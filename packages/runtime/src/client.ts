import {
	assertResolvedAgentProfile,
	extendAgentProfile,
	resolveAgentProfile,
} from './agent-definition.ts';
import type { AgentSubmissionStore } from './agent-execution-store.ts';
import { discoverSessionContext } from './context.ts';
import { ConversationRecordWriter } from './conversation-writer.ts';
import { Harness } from './harness.ts';
import { type AttachmentStore, InMemoryAttachmentStore } from './runtime/attachment-store.ts';
import { InMemoryConversationStreamStore } from './runtime/conversation-stream-store.ts';
import { agentStreamPath } from './runtime/event-stream-store.ts';
import { dispatchGlobalEvent } from './runtime/events.ts';
import { createCwdSessionEnv } from './sandbox.ts';
import type {
	AgentConfig,
	AgentDefinition,
	AgentProfile,
	AgentRuntimeConfig,
	FlueEvent,
	FlueEventCallback,
	FlueEventContext,
	FlueEventInput,
	FlueObservationDetail,
	SandboxFactory,
	SessionEnv,
	SessionToolFactory,
} from './types.ts';

export interface FlueContextConfig {
	id: string;
	agentName?: string;
	runId?: string;
	dispatchId?: string;
	env: Record<string, any>;
	/**
	 * Host-provided agent-config seeds (`resolveModel` and runtime-wide defaults).
	 * `systemPrompt`, `skills`, and `model` are
	 * runtime-owned — discovered from the session cwd and resolved from the
	 * agent definition during harness initialization — so they are not inputs.
	 */
	agentConfig: Omit<AgentConfig, 'systemPrompt' | 'skills' | 'model'>;
	createDefaultEnv: () => Promise<SessionEnv>;
	/**
	 * The current HTTP request, if any. Surfaced to handlers as `ctx.req`.
	 * Build plugins pass the standard Fetch `Request` through; non-HTTP entry
	 * points (e.g. future cron triggers) leave it undefined.
	 */
	req?: Request;
	initialEventIndex?: number;
	submissionStore?: AgentSubmissionStore;
	conversationWriter?: ConversationRecordWriter;
	attachmentStore?: AttachmentStore;
}

/** Extends FlueEventContext with server-only methods. */
export interface FlueContextInternal extends FlueEventContext {
	readonly runId: string | undefined;
	initializeRootHarness(agent: AgentDefinition): Promise<Harness>;
	createEvent(event: FlueEventInput): FlueEvent;
	publishEvent(event: FlueEvent): void;
	emitEvent(event: FlueEventInput, observation?: FlueObservationDetail): FlueEvent;
	subscribeEvent(callback: FlueEventCallback): () => void;
	flushEventCallbacks(): Promise<void>;
	setEventCallback(callback: FlueEventCallback | undefined): void;
	setSubmissionId(submissionId: string | undefined): void;
	setConversationWriter?(writer: ConversationRecordWriter | undefined): void;
	setAttachmentStore?(store: AttachmentStore | undefined): void;
}

export function createFlueContext(config: FlueContextConfig): FlueContextInternal {
	const subscribers = new Set<FlueEventCallback>();
	let handlerUnsubscribe: (() => void) | undefined;
	const pendingEventCallbacks = new Set<Promise<void>>();
	let eventCallbackError: unknown;
	let eventIndex = config.initialEventIndex ?? 0;
	let submissionId: string | undefined;
	let conversationWriter = config.conversationWriter;
	let attachmentStore = config.attachmentStore;
	let localConversationRuntime: Promise<{
		writer: ConversationRecordWriter;
		attachments: AttachmentStore;
	}> | undefined;

	const createEvent = (event: FlueEventInput): FlueEvent => ({
		...event,
		...(config.runId === undefined ? { instanceId: config.id } : { runId: config.runId }),
		...(config.dispatchId === undefined ? {} : { dispatchId: config.dispatchId }),
		...(submissionId === undefined ? {} : { submissionId }),
		...(config.agentName === undefined ? {} : { agentName: config.agentName }),
		v: 3,
		eventIndex: eventIndex++,
		timestamp: new Date().toISOString(),
	});

	const publishEvent = (decorated: FlueEvent, observation?: FlueObservationDetail): void => {
		for (const subscriber of subscribers) {
			try {
				const callback = subscriber(decorated);
				if (callback instanceof Promise) {
					const pending = callback
						.catch((error) => {
							eventCallbackError ??= error;
						})
						.finally(() => pendingEventCallbacks.delete(pending));
					pendingEventCallbacks.add(pending);
				}
			} catch (error) {
				eventCallbackError ??= error;
			}
		}
		// Fan out to module-scoped subscribers registered via
		// `observe()` from `@flue/runtime`. These run after the
		// per-context subscribers and receive the originating `ctx` as
		// a second argument so cross-cutting code can read runtime identity
		// and environment metadata.
		dispatchGlobalEvent(decorated, ctx, observation);
	};

	const emitEvent = (event: FlueEventInput, observation?: FlueObservationDetail): FlueEvent => {
		const decorated = createEvent(event);
		publishEvent(decorated, observation);
		return decorated;
	};

	const ctx: FlueContextInternal = {
		get id() {
			return config.id;
		},

		get runId() {
			return config.runId;
		},

		get agentName() {
			return config.agentName;
		},

		get env() {
			return config.env;
		},

		get req() {
			return config.req;
		},

		async initializeRootHarness(agent: AgentDefinition): Promise<Harness> {
			if (!conversationWriter || !attachmentStore) {
				localConversationRuntime ??= createLocalConversationRuntime(config);
				const local = await localConversationRuntime;
				conversationWriter ??= local.writer;
				attachmentStore ??= local.attachments;
			}
			return initializeRootHarness(agent, { ...config, conversationWriter, attachmentStore }, emitEvent);
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

		createEvent,

		publishEvent,

		emitEvent,

		subscribeEvent(callback: FlueEventCallback): () => void {
			subscribers.add(callback);
			return () => subscribers.delete(callback);
		},

		async flushEventCallbacks(): Promise<void> {
			await Promise.all(pendingEventCallbacks);
			if (eventCallbackError !== undefined) {
				const error = eventCallbackError;
				eventCallbackError = undefined;
				throw error;
			}
		},

		setEventCallback(callback: FlueEventCallback | undefined): void {
			handlerUnsubscribe?.();
			handlerUnsubscribe = callback ? ctx.subscribeEvent(callback) : undefined;
		},

		setSubmissionId(value: string | undefined): void {
			submissionId = value;
		},

		setConversationWriter(value: ConversationRecordWriter | undefined): void {
			conversationWriter = value;
		},

		setAttachmentStore(value: AttachmentStore | undefined): void {
			attachmentStore = value;
		},
	};

	return ctx;
}

async function createLocalConversationRuntime(config: FlueContextConfig): Promise<{
	writer: ConversationRecordWriter;
	attachments: AttachmentStore;
}> {
	const store = new InMemoryConversationStreamStore();
	const path = config.runId === undefined
		? agentStreamPath(config.agentName ?? 'agent', config.id)
		: `workflow-executions/${config.runId}`;
	return {
		writer: await ConversationRecordWriter.create({
			store,
			path,
			identity: { agentName: config.agentName ?? 'workflow', instanceId: config.id },
			producerId: `execution:${config.runId ?? config.id}`,
		}),
		attachments: new InMemoryAttachmentStore(),
	};
}

export async function initializeRootHarness(
	agent: AgentDefinition,
	config: FlueContextConfig,
	emitEvent: (event: FlueEventInput, observation?: FlueObservationDetail) => void,
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
	if (!config.conversationWriter || !config.attachmentStore) {
		throw new Error('[flue] Canonical conversation runtime is not configured.');
	}
	return new Harness(
		config.id,
		'default',
		agentConfig,
		env,
		emitEvent,
		definition.tools ?? [],
		toolFactory,
		config.submissionStore,
		config.conversationWriter,
		config.attachmentStore,
		definition.actions,
		config.runId === undefined ? { instanceId: config.id } : { runId: config.runId },
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
