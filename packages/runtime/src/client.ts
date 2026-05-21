import { assertResolvedAgentDefinition, resolveAgentDefinition } from './agent-definition.ts';
import { discoverSessionContext } from './context.ts';
import { AgentBusyError } from './errors.ts';
import { Harness } from './harness.ts';
import type { DefaultWorkspaceScope } from './runtime/default-workspace-store.ts';
import { dispatchGlobalEvent } from './runtime/events.ts';
import type { RegistrationStore } from './runtime/registration-store.ts';
import { bashFactoryToSessionEnv, createCwdSessionEnv, isBashLike } from './sandbox.ts';
import type {
	Agent,
	AgentConfig,
	AgentInit,
	BashFactory,
	FlueContext,
	FlueEvent,
	FlueEventCallback,
	FlueHarness,
	SandboxFactory,
	SessionEnv,
	SessionStore,
	SessionToolFactory,
} from './types.ts';

export interface FlueContextConfig {
	id: string;
	runId: string;
	payload: any;
	env: Record<string, any>;
	agentName: string;
	agentConfig: AgentConfig;
	createDefaultEnv: (scope: DefaultWorkspaceScope) => Promise<SessionEnv>;
	defaultStore: SessionStore;
	registrationStore: RegistrationStore;
	/**
	 * Platform-specific sandbox resolver hook. Called before default resolution.
	 * Returns SessionEnv to use, or null to fall through to default logic.
	 */
	resolveSandbox?: (sandbox: unknown) => Promise<SessionEnv> | null;
	/**
	 * The current HTTP request, if any. Surfaced to handlers as `ctx.req`.
	 * Build plugins pass the standard Fetch `Request` through; non-HTTP entry
	 * points (e.g. future cron triggers) leave it undefined.
	 */
	req?: Request;
}

/** Extends FlueContext with server-only methods. Agent handlers only see FlueContext. */
export interface FlueContextInternal extends FlueContext {
	/** Decorate and dispatch an event, returning the decorated event. */
	emitEvent(event: FlueEvent): FlueEvent;
	subscribeEvent(callback: FlueEventCallback): () => void;
	setEventCallback(callback: FlueEventCallback | undefined): void;
	waitForIdle(): Promise<void>;
}

export function createFlueContext(config: FlueContextConfig): FlueContextInternal {
	const subscribers = new Set<FlueEventCallback>();
	let handlerUnsubscribe: (() => void) | undefined;
	let eventIndex = 0;
	let didRegister = false;
	const initializedHarnessNames = new Set<string>();
	const detachedOperations = new Set<Promise<unknown>>();

	const emitEvent = (event: FlueEvent): FlueEvent => {
		const decorated: FlueEvent = {
			...event,
			runId: config.runId,
			eventIndex: eventIndex++,
			timestamp: new Date().toISOString(),
		};
		for (const subscriber of subscribers) {
			try {
				Promise.resolve(subscriber(decorated)).catch((error) => {
					console.error('[flue:subscriber] Event subscriber failed:', error);
				});
			} catch (error) {
				console.error('[flue:subscriber] Event subscriber failed:', error);
			}
		}
		// Fan out to module-scoped subscribers registered via
		// `observe()` from `@flue/runtime/app`. These run after the
		// per-context subscribers and receive the originating `ctx` as
		// a second argument so cross-cutting code (error reporting,
		// log forwarding) can read `ctx.id`, `ctx.runId`, etc.
		dispatchGlobalEvent(decorated, ctx);
		return decorated;
	};

	const ctx: FlueContextInternal = {
		get id() {
			return config.id;
		},

		get runId() {
			return config.runId;
		},

		get payload() {
			return config.payload;
		},

		get env() {
			return config.env;
		},

		get req() {
			return config.req;
		},

		log: {
			info(message, attributes) {
				emitEvent({ type: 'log', level: 'info', message, attributes: normalizeLogAttributes(attributes) });
			},
			warn(message, attributes) {
				emitEvent({ type: 'log', level: 'warn', message, attributes: normalizeLogAttributes(attributes) });
			},
			error(message, attributes) {
				emitEvent({ type: 'log', level: 'error', message, attributes: normalizeLogAttributes(attributes) });
			},
		},

		async register(callback: () => unknown | Promise<unknown>): Promise<void> {
			if (typeof callback !== 'function') {
				throw new Error('[flue] register() requires a callback function.');
			}
			if (didRegister) {
				throw new Error('[flue] register() may only be called once per request.');
			}
			didRegister = true;
			const registration = { agentName: config.agentName, instanceId: config.id };
			const claim = await config.registrationStore.claim(registration);
			if (!claim) return;
			try {
				await callback();
				await claim.complete();
			} catch (error) {
				await claim.release();
				throw error;
			}
		},

		async init(options?: AgentInit): Promise<Agent> {
			const definition = assertResolvedAgentDefinition(resolveAgentDefinition(options), 'init()');
			if (!hasInitModel(options)) {
				throw new Error(
					'[flue] init() requires a model. Pass { model: "provider/model-id" }, { model: false }, or inherit a definition with a model.',
				);
			}
			if (definition.model !== false && typeof definition.model !== 'string') {
				throw new Error('[flue] init({ model }) must be a model string or false.');
			}

			const resolvedOptions = options ?? {};
			const name = resolvedOptions.name ?? 'default';
			if (initializedHarnessNames.has(name)) {
				throw new Error(`[flue] init() has already been called with name "${name}" in this request.`);
			}
			initializedHarnessNames.add(name);

			try {
				const sandbox = resolvedOptions.sandbox;
				const { env: baseEnv, toolFactory } = await resolveSessionEnv(
					config.agentName,
					config.id,
					name,
					sandbox,
					config,
					resolvedOptions.cwd,
				);
				// Resolve `init({ cwd })` against the sandbox's own cwd so that
				// relative paths target the sandbox/session filesystem, not the
				// agent process cwd or `/`. Mirrors the same pattern used for
				// task sessions in harness.ts.
				const env = resolvedOptions.cwd
					? createCwdSessionEnv(baseEnv, baseEnv.resolvePath(resolvedOptions.cwd))
					: baseEnv;
				const store: SessionStore = resolvedOptions.persist ?? config.defaultStore;
				const localContext = await discoverSessionContext(env, definition.instructions, definition.skills);

				// Harness-level model override. Per-call `model` on prompt()/skill() still wins
				// because resolveModelForCall() applies it on top of this default.
				const agentModel = config.agentConfig.resolveModel(definition.model);

				const agentConfig: AgentConfig = {
					...config.agentConfig,
					systemPrompt: localContext.systemPrompt,
					instructions: definition.instructions,
					definitionSkills: definition.skills,
					skills: localContext.skills,
					subagents: Object.fromEntries((definition.subagents ?? []).map((agent) => [agent.name!, agent])),
					model: agentModel,
					thinkingLevel: definition.thinkingLevel ?? config.agentConfig.thinkingLevel,
					compaction: definition.compaction ?? config.agentConfig.compaction,
				};

				const harness: FlueHarness = new Harness(
					config.id,
					name,
					agentConfig,
					env,
					store,
					(event) => {
						emitEvent(event);
					},
					definition.tools,
					toolFactory,
				);
				let sendInFlight = false;
				return {
					name: config.agentName,
					id: config.id,
					send(message, sendOptions) {
						if (sendInFlight) {
							throw new AgentBusyError({ name: config.agentName, id: config.id });
						}
						if (typeof message !== 'string') {
							throw new Error('[flue] agent.send(message) requires a string message.');
						}
						sendInFlight = true;
						const operation = harness
							.session(sendOptions?.session)
							.then((session) => session.prompt(message))
							.catch((error) => {
								emitEvent({
									type: 'log',
									level: 'error',
									message: 'agent.send() failed.',
									attributes: { error: serializeAgentSendError(error) },
								});
							})
							.finally(() => {
								sendInFlight = false;
								detachedOperations.delete(operation);
							});
						detachedOperations.add(operation);
					},
					harness: () => harness,
				};
			} catch (error) {
				initializedHarnessNames.delete(name);
				throw error;
			}
		},

		emitEvent,

		subscribeEvent(callback: FlueEventCallback): () => void {
			subscribers.add(callback);
			return () => subscribers.delete(callback);
		},

		setEventCallback(callback: FlueEventCallback | undefined): void {
			handlerUnsubscribe?.();
			handlerUnsubscribe = callback ? ctx.subscribeEvent(callback) : undefined;
		},

		async waitForIdle(): Promise<void> {
			while (detachedOperations.size > 0) {
				await Promise.allSettled([...detachedOperations]);
			}
		},
	};

	return ctx;
}

function normalizeLogAttributes(
	attributes: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	if (!attributes) return undefined;
	if (!(attributes.error instanceof Error)) return attributes;
	return {
		...attributes,
		error: serializeLogError(attributes.error),
	};
}

function serializeLogError(error: Error): Record<string, unknown> {
	return {
		name: error.name,
		message: error.message,
		stack: error.stack,
	};
}

function serializeAgentSendError(error: unknown): Record<string, unknown> {
	return error instanceof Error ? serializeLogError(error) : { value: error };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function hasInitModel(options: AgentInit | undefined): boolean {
	return Boolean(options && ('model' in options || (options.inherit && 'model' in options.inherit)));
}

function isBashFactory(value: unknown): value is BashFactory {
	return typeof value === 'function';
}

function isSandboxFactory(value: unknown): value is SandboxFactory {
	return (
		typeof value === 'object' &&
		value !== null &&
		'createSessionEnv' in value &&
		typeof (value as any).createSessionEnv === 'function'
	);
}

/** Resolve sandbox option to its session environment and optional tool factory. */
async function resolveSessionEnv(
	agentName: string,
	id: string,
	harnessName: string,
	sandbox: AgentInit['sandbox'],
	config: FlueContextConfig,
	cwd: string | undefined,
): Promise<{ env: SessionEnv; toolFactory?: SessionToolFactory }> {
	if (sandbox === undefined || sandbox === false) {
		return {
			env: await config.createDefaultEnv({
				agentName,
				instanceId: id,
				harnessName,
			}),
		};
	}
	// JS-caller / `any`-input fallback for the removed `'empty'` and
	// `'local'` magic strings. TS callers get compile errors from the
	// `AgentInit['sandbox']` union. The `as unknown` cast keeps `tsc`
	// from flagging these branches as dead under the narrowed type.
	if ((sandbox as unknown) === 'empty') {
		throw new Error(
			"[flue] `sandbox: 'empty'` is no longer supported. " +
				'Omit the `sandbox` option (or pass `false`) for the default in-memory sandbox.',
		);
	}
	if ((sandbox as unknown) === 'local') {
		throw new Error(
			"[flue] `sandbox: 'local'` is no longer supported. " +
				"Use the `local()` factory instead: " +
				"`import { local } from '@flue/runtime/node'; init({ sandbox: local() })`. " +
				"The factory accepts an `env` option for opting host env vars into the sandbox.",
		);
	}
	if (isBashFactory(sandbox)) {
		return { env: await bashFactoryToSessionEnv(sandbox) };
	}
	if (isBashLike(sandbox)) {
		throw new Error(
			'[flue] init({ sandbox }) no longer accepts a Bash-like object directly. ' +
				'Pass a BashFactory instead, e.g. `sandbox: () => new Bash({ fs })`.',
		);
	}
	if (config.resolveSandbox) {
		const resolved = await config.resolveSandbox(sandbox);
		if (resolved) return { env: resolved };
	}
	if (isSandboxFactory(sandbox)) {
		const env = await sandbox.createSessionEnv({ id, cwd });
		return { env, toolFactory: sandbox.tools };
	}
	throw new Error('[flue] Invalid sandbox option passed to init().');
}
