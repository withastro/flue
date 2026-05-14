import { discoverSessionContext } from './context.ts';
import { Harness } from './harness.ts';
import { assertRoleExists } from './roles.ts';
import { dispatchGlobalEvent } from './runtime/events.ts';
import { bashFactoryToSessionEnv, createCwdSessionEnv } from './sandbox.ts';
import type {
	AgentConfig,
	AgentInit,
	BashFactory,
	BashLike,
	FlueContext,
	FlueEvent,
	FlueEventCallback,
	FlueHarness,
	SandboxFactory,
	SessionEnv,
	SessionStore,
} from './types.ts';

export interface FlueContextConfig {
	id: string;
	runId: string;
	payload: any;
	env: Record<string, any>;
	agentConfig: AgentConfig;
	createDefaultEnv: () => Promise<SessionEnv>;
	defaultStore: SessionStore;
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
}

export function createFlueContext(config: FlueContextConfig): FlueContextInternal {
	const subscribers = new Set<FlueEventCallback>();
	let handlerUnsubscribe: (() => void) | undefined;
	let eventIndex = 0;
	const initializedHarnessNames = new Set<string>();

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

		async init(options?: AgentInit): Promise<FlueHarness> {
			if (!options || !('model' in options)) {
				throw new Error(
					'[flue] init() requires a model. Pass { model: "provider/model-id" } or { model: false }.',
				);
			}
			if (options.model !== false && typeof options.model !== 'string') {
				throw new Error('[flue] init({ model }) must be a model string or false.');
			}

			const name = options.name ?? 'default';
			if (initializedHarnessNames.has(name)) {
				throw new Error(`[flue] init() has already been called with name "${name}" in this request.`);
			}
			initializedHarnessNames.add(name);

			try {
				assertRoleExists(config.agentConfig.roles, options.role);
				const sandbox = options.sandbox;
				const baseEnv = await resolveSessionEnv(config.id, sandbox, config, options.cwd);
				const env = options.cwd ? createCwdSessionEnv(baseEnv, options.cwd) : baseEnv;
				const store: SessionStore = options.persist ?? config.defaultStore;
				const localContext = await discoverSessionContext(env);

				// Harness-level model override. Per-call `model` on prompt()/skill() still wins
				// because resolveModelForCall() applies it on top of this default.
				const agentModel = config.agentConfig.resolveModel(options.model);

				const agentConfig: AgentConfig = {
					...config.agentConfig,
					systemPrompt: localContext.systemPrompt,
					skills: localContext.skills,
					model: agentModel,
					role: options.role ?? config.agentConfig.role,
					thinkingLevel: options.thinkingLevel ?? config.agentConfig.thinkingLevel,
					compaction: options.compaction ?? config.agentConfig.compaction,
				};

				return new Harness(
					config.id,
					name,
					agentConfig,
					env,
					store,
					(event) => {
						emitEvent(event);
					},
					options.tools,
				);
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

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Duck-type detection for just-bash Bash instances. */
function isBashLike(value: unknown): value is BashLike {
	return (
		typeof value === 'object' &&
		value !== null &&
		'exec' in value &&
		'getCwd' in value &&
		'fs' in value &&
		typeof (value as any).exec === 'function' &&
		typeof (value as any).getCwd === 'function' &&
		typeof (value as any).fs === 'object'
	);
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

/** Resolve sandbox option to SessionEnv: default → BashFactory → platform hook → SandboxFactory. */
async function resolveSessionEnv(
	id: string,
	sandbox: AgentInit['sandbox'],
	config: FlueContextConfig,
	cwd: string | undefined,
): Promise<SessionEnv> {
	if (sandbox === undefined || sandbox === false) {
		return config.createDefaultEnv();
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
		return bashFactoryToSessionEnv(sandbox);
	}
	if (isBashLike(sandbox)) {
		throw new Error(
			'[flue] init({ sandbox }) no longer accepts a Bash-like object directly. ' +
				'Pass a BashFactory instead, e.g. `sandbox: () => new Bash({ fs })`.',
		);
	}
	if (config.resolveSandbox) {
		const resolved = await config.resolveSandbox(sandbox);
		if (resolved) return resolved;
	}
	if (isSandboxFactory(sandbox)) {
		return sandbox.createSessionEnv({ id, cwd });
	}
	throw new Error('[flue] Invalid sandbox option passed to init().');
}
