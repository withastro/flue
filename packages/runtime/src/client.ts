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
	AgentProfile,
	AgentRuntimeConfig,
	AgentDefinition,
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
	initializeRootHarness(agent: AgentDefinition): Promise<Harness>;
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
		// a second argument so cross-cutting code can read runtime identity
		// and environment metadata.
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

		get env() {
			return config.env;
		},

		get req() {
			return config.req;
		},

		initializeRootHarness(agent: AgentDefinition): Promise<Harness> {
			return initializeRootHarness(agent, config, emitEvent);
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

export async function initializeRootHarness(
	agent: AgentDefinition,
	config: FlueContextConfig,
	emitEvent: (event: FlueEventInput) => void,
): Promise<Harness> {
	const resolvedOptions = await agent.initialize({ id: config.id, env: config.env });
	const definition = assertResolvedAgentProfile(
		extendAgentProfile(resolveAgentProfile(resolvedOptions), {}),
		'defineAgent()',
	);
	if (!hasInitModel(resolvedOptions)) {
		throw new Error(
			'[flue] defineAgent() requires a model. Return { model: "provider-id/model-id" }, { model: false }, or a profile with a model.',
		);
	}
	if (definition.model !== false && typeof definition.model !== 'string') {
		throw new Error('[flue] defineAgent() model must be a model specifier or false.');
	}
	const { env: baseEnv, toolFactory } = await resolveSessionEnv(
		config.id,
		resolvedOptions.sandbox,
		config,
	);
	const env = resolvedOptions.cwd
		? createCwdSessionEnv(baseEnv, baseEnv.resolvePath(resolvedOptions.cwd))
		: baseEnv;
	const localContext = await discoverSessionContext(
		env,
		definition.instructions,
		definition.skills,
	);
	const agentConfig: AgentConfig = {
		...config.agentConfig,
		systemPrompt: localContext.systemPrompt,
		instructions: definition.instructions,
		definitionSkills: definition.skills,
		skills: localContext.skills,
		actions: definition.actions,
		subagents: Object.fromEntries(
			(definition.subagents ?? [])
				.filter((candidate): candidate is AgentProfile & { name: string } => candidate.name !== undefined)
				.map((candidate) => [candidate.name, candidate]),
		),
		model: config.agentConfig.resolveModel(definition.model),
		thinkingLevel: definition.thinkingLevel ?? config.agentConfig.thinkingLevel,
		compaction: definition.compaction ?? config.agentConfig.compaction,
		durability: definition.durability,
	};
	return new Harness(
		config.id,
		'default',
		agentConfig,
		env,
		config.defaultStore,
		emitEvent,
		definition.tools,
		toolFactory,
		config.submissionStore,
		definition.actions,
	);
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
	throw new Error('[flue] Invalid sandbox option returned from defineAgent().');
}
