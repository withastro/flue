import {
	assertResolvedAgentProfile,
	extendAgentProfile,
	resolveAgentProfile,
} from './agent-definition.ts';
import type { AgentSubmissionStore } from './agent-execution-store.ts';
import { discoverSessionContext } from './context.ts';
import { Harness } from './harness.ts';
import { dispatchGlobalEvent } from './runtime/events.ts';
import { createCwdSessionEnv } from './sandbox.ts';
import type {
	AgentConfig,
	AgentHarnessOptions,
	AgentProfile,
	AgentRuntimeConfig,
	CreatedAgent,
	FlueContext,
	FlueEvent,
	FlueEventCallback,
	FlueEventInput,
	FlueHarness,
	SandboxFactory,
	SessionEnv,
	SessionStore,
	SessionToolFactory,
} from './types.ts';

export interface FlueContextConfig {
	id: string;
	runId?: string;
	dispatchId?: string;
	payload: any;
	env: Record<string, any>;
	/**
	 * Host-provided agent-config seeds (`resolveModel`, `packagedSkills`, and
	 * runtime-wide defaults). `systemPrompt`, `skills`, and `model` are
	 * runtime-owned — discovered from the session cwd and resolved from the
	 * agent definition during harness initialization — so they are not inputs.
	 */
	agentConfig: Omit<AgentConfig, 'systemPrompt' | 'skills' | 'model'>;
	createDefaultEnv: () => Promise<SessionEnv>;
	defaultStore: SessionStore;
	/**
	 * The current HTTP request, if any. Surfaced to handlers as `ctx.req`.
	 * Build plugins pass the standard Fetch `Request` through; non-HTTP entry
	 * points (e.g. future cron triggers) leave it undefined.
	 */
	req?: Request;
	initialEventIndex?: number;
	submissionStore?: AgentSubmissionStore;
}

/** Extends FlueContext with server-only methods. Agent handlers only see FlueContext. */
export interface FlueContextInternal extends FlueContext {
	readonly runId: string | undefined;
	initializeCreatedAgent(
		agent: CreatedAgent,
		options?: AgentHarnessOptions,
	): Promise<FlueHarness>;
	emitEvent(event: FlueEventInput): FlueEvent;
	subscribeEvent(callback: FlueEventCallback): () => void;
	setEventCallback(callback: FlueEventCallback | undefined): void;
	setSubmissionId(submissionId: string | undefined): void;
}

export function createFlueContext(config: FlueContextConfig): FlueContextInternal {
	const subscribers = new Set<FlueEventCallback>();
	let handlerUnsubscribe: (() => void) | undefined;
	let eventIndex = config.initialEventIndex ?? 0;
	let submissionId: string | undefined;
	const initializedHarnessNames = new Set<string>();

	const emitEvent = (event: FlueEventInput): FlueEvent => {
		const decorated: FlueEvent = {
			...event,
			...(config.runId === undefined ? { instanceId: config.id } : { runId: config.runId }),
			...(config.dispatchId === undefined ? {} : { dispatchId: config.dispatchId }),
			...(submissionId === undefined ? {} : { submissionId }),
			v: 1,
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
		// `observe()` from `@flue/runtime`. These run after the
		// per-context subscribers and receive the originating `ctx` as
		// a second argument so cross-cutting code (error reporting,
		// log forwarding) can read `ctx.id`, `ctx.payload`, etc.
		dispatchGlobalEvent(decorated, ctx);
		return decorated;
	};

	const initializeHarness = async (
		runtimeConfig: AgentRuntimeConfig,
		options?: AgentHarnessOptions,
	): Promise<FlueHarness> => {
		const definition = assertResolvedAgentProfile(
			extendAgentProfile(resolveAgentProfile(runtimeConfig), {
				tools: options?.tools,
				skills: options?.skills,
				subagents: options?.subagents,
			}),
			'init()',
		);
		if (!hasInitModel(runtimeConfig)) {
			throw new Error(
				'[flue] init() requires a model. Pass { model: "provider-id/model-id" }, { model: false }, or a profile with a model.',
			);
		}
		if (definition.model !== false && typeof definition.model !== 'string') {
			throw new Error('[flue] init() model must be a model specifier or false.');
		}

		const name = options?.name ?? 'default';
		if (initializedHarnessNames.has(name)) {
			throw new Error(`[flue] init() has already been called with name "${name}" in this request.`);
		}
		initializedHarnessNames.add(name);

		try {
			const { env: baseEnv, toolFactory } = await resolveSessionEnv(
				config.id,
				runtimeConfig.sandbox,
				config,
			);
			const env = runtimeConfig.cwd
				? createCwdSessionEnv(baseEnv, baseEnv.resolvePath(runtimeConfig.cwd))
				: baseEnv;
			const localContext = await discoverSessionContext(
				env,
				definition.instructions,
				definition.skills,
			);
			const agentModel = config.agentConfig.resolveModel(definition.model);
			const agentConfig: AgentConfig = {
				...config.agentConfig,
				systemPrompt: localContext.systemPrompt,
				instructions: definition.instructions,
				definitionSkills: definition.skills,
				skills: localContext.skills,
				subagents: Object.fromEntries(
					(definition.subagents ?? [])
						.filter((agent): agent is AgentProfile & { name: string } => agent.name !== undefined)
						.map((agent) => [agent.name, agent]),
				),
				model: agentModel,
				thinkingLevel: definition.thinkingLevel ?? config.agentConfig.thinkingLevel,
				compaction: definition.compaction ?? config.agentConfig.compaction,
				durability: definition.durability,
			};

			return new Harness(
				config.id,
				name,
				agentConfig,
				env,
				config.defaultStore,
				(event) => {
					emitEvent(event);
				},
				definition.tools,
				toolFactory,
				config.submissionStore,
			);
		} catch (error) {
			initializedHarnessNames.delete(name);
			throw error;
		}
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
				emitEvent({
					type: 'log',
					level: 'info',
					message,
					attributes: normalizeLogAttributes(attributes),
				});
			},
			warn(message, attributes) {
				emitEvent({
					type: 'log',
					level: 'warn',
					message,
					attributes: normalizeLogAttributes(attributes),
				});
			},
			error(message, attributes) {
				emitEvent({
					type: 'log',
					level: 'error',
					message,
					attributes: normalizeLogAttributes(attributes),
				});
			},
		},

		init(runtimeConfig: AgentRuntimeConfig, options?: AgentHarnessOptions): Promise<FlueHarness> {
			return initializeHarness(runtimeConfig, options);
		},

		async initializeCreatedAgent(
			agent: CreatedAgent,
			options?: AgentHarnessOptions,
		): Promise<FlueHarness> {
			if (!agent || agent.__flueCreatedAgent !== true || typeof agent.initialize !== 'function') {
				throw new Error('[flue] Addressable agent initialization requires createAgent(...).');
			}
			const runtimeConfig = await agent.initialize({ id: config.id, env: config.env });
			return initializeHarness(runtimeConfig, options);
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

		setSubmissionId(value: string | undefined): void {
			submissionId = value;
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

function hasInitModel(options: AgentRuntimeConfig | undefined): boolean {
	return Boolean(
		options && ('model' in options || (options.profile && 'model' in options.profile)),
	);
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
	id: string,
	sandbox: AgentRuntimeConfig['sandbox'],
	config: FlueContextConfig,
): Promise<{ env: SessionEnv; toolFactory?: SessionToolFactory }> {
	if (sandbox === undefined) {
		return { env: await config.createDefaultEnv() };
	}
	if (isSandboxFactory(sandbox)) {
		const env = await sandbox.createSessionEnv({ id });
		return { env, toolFactory: sandbox.tools };
	}
	throw new Error('[flue] Agent runtime config contains an invalid sandbox.');
}
