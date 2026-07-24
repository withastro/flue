import { discoverSessionContext, skillCatalogEntries } from './context.ts';
import { ConversationRecordWriter } from './conversation-writer.ts';
import { normalizeLogAttributes } from './errors.ts';
import { Harness } from './harness.ts';
import type { RenderStateContext } from './hooks/frame.ts';
import {
	type AgentRenderStructure,
	assertRenderStructureInvariance,
	renderAgentFunctionWithStructure,
} from './hooks/render.ts';
import { createHookStateBuffer } from './hooks/use-persistent-state.ts';
import { createMcpConnection, type McpConnectionResolver } from './mcp.ts';
import type { McpConnectionDefinition, McpUnavailableConnection } from './mcp-types.ts';
import { createAgentOutputChannel } from './message-output.ts';
import { digestInstructions, type ToolResourceEntry } from './resources.ts';
import { ensureInstanceIdentity } from './runtime/agent-submissions.ts';
import { type AttachmentStore, InMemoryAttachmentStore } from './runtime/attachment-store.ts';
import { InMemoryConversationStreamStore } from './runtime/conversation-stream-store.ts';
import { dispatchGlobalEvent } from './runtime/events.ts';
import { resolveAgentDurability } from './runtime/registration.ts';
import { agentStreamPath } from './runtime/stream-offsets.ts';
import { createCwdSessionEnv } from './sandbox.ts';
import type {
	RenderedResources,
	SessionEnvRuntime,
	SessionEnvSlot,
	SessionRerender,
	SessionResourceRuntime,
} from './session.ts';
import { getPreparedToolAdapter } from './tool-adapter.ts';
import type {
	Agent,
	AgentConfig,
	AgentRuntimeConfig,
	DeliveredMessage,
	FlueEvent,
	FlueEventCallback,
	FlueEventContext,
	FlueEventInput,
	FlueObservationDetail,
	SandboxFactory,
	SessionEnv,
	SessionToolFactory,
	ToolDefinition,
} from './types.ts';

export interface FlueContextConfig {
	id: string;
	agentName?: string;
	/**
	 * The submission this context processes, when known at construction —
	 * coordinators pass it for every admitted submission (dispatched and
	 * direct alike) so emitted events carry it from the first event on.
	 */
	submissionId?: string;
	env: Record<string, any>;
	/**
	 * Host-provided agent-config seeds (`resolveModel` and runtime-wide defaults).
	 * `systemPrompt`, `skills`, and `model` are
	 * runtime-owned — discovered from the session cwd and resolved from the
	 * agent definition during harness initialization — so they are not inputs.
	 */
	agentConfig: Omit<AgentConfig, 'systemPrompt' | 'skills' | 'model'>;
	/**
	 * The current HTTP request, if any. Surfaced to handlers as `ctx.req`.
	 * Build plugins pass the standard Fetch `Request` through; non-HTTP entry
	 * points (e.g. future cron triggers) leave it undefined.
	 */
	req?: Request;
	conversationWriter?: ConversationRecordWriter;
	attachmentStore?: AttachmentStore;
	/**
	 * Resolves `useMcpConnection()` declarations to live MCP connections.
	 * Coordinators inject a per-instance caching resolver; a context without
	 * one connects fresh at every harness initialization.
	 */
	mcpConnections?: McpConnectionResolver;
}

/** Extends FlueEventContext with server-only methods. */
export interface FlueContextInternal extends FlueEventContext {
	/**
	 * `delivery` is the submission's delivered message; renders read it via
	 * `useDelivery()`. Omit for invocations no delivered message triggered.
	 * Requires the instance's birth record to exist — admission owns instance
	 * identity. `data` is creation data consumed only when the context
	 * self-provisions its conversation runtime (and with it, the identity);
	 * on a coordinator-provided runtime the recorded birth value wins.
	 */
	initializeRootHarness(
		agent: Agent,
		delivery?: DeliveredMessage,
		data?: unknown,
	): Promise<Harness>;
	createEvent(event: FlueEventInput): FlueEvent;
	publishEvent(event: FlueEvent, observation?: FlueObservationDetail): void;
	emitEvent(event: FlueEventInput, observation?: FlueObservationDetail): FlueEvent;
	subscribeEvent(callback: FlueEventCallback): () => void;
	flushEventCallbacks(): Promise<void>;
	setEventCallback(callback: FlueEventCallback | undefined): void;
	setConversationWriter?(writer: ConversationRecordWriter | undefined): void;
	setAttachmentStore?(store: AttachmentStore | undefined): void;
	setMcpConnections?(resolver: McpConnectionResolver | undefined): void;
}

export function createFlueContext(config: FlueContextConfig): FlueContextInternal {
	const subscribers = new Set<FlueEventCallback>();
	let handlerUnsubscribe: (() => void) | undefined;
	const pendingEventCallbacks = new Set<Promise<void>>();
	let eventCallbackError: unknown;
	let eventIndex = 0;
	let conversationWriter = config.conversationWriter;
	let attachmentStore = config.attachmentStore;
	let mcpConnections = config.mcpConnections;
	let localConversationRuntime:
		| Promise<{
				writer: ConversationRecordWriter;
				attachments: AttachmentStore;
		  }>
		| undefined;

	const createEvent = (event: FlueEventInput): FlueEvent => ({
		...event,
		instanceId: config.id,
		...(config.submissionId === undefined ? {} : { submissionId: config.submissionId }),
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

		get agentName() {
			return config.agentName;
		},

		get env() {
			return config.env;
		},

		get req() {
			return config.req;
		},

		async initializeRootHarness(
			agent: Agent,
			delivery?: DeliveredMessage,
			data?: unknown,
		): Promise<Harness> {
			if (!conversationWriter || !attachmentStore) {
				localConversationRuntime ??= createLocalConversationRuntime(config);
				const local = await localConversationRuntime;
				conversationWriter ??= local.writer;
				attachmentStore ??= local.attachments;
				// A context without a coordinator-provided conversation runtime has
				// no admission layer to own instance identity, so it self-admits:
				// the same find-or-create that coordinator admission runs, against
				// the self-provisioned runtime.
				await ensureInstanceIdentity(conversationWriter, agent, data);
			}
			return initializeRootHarness(
				agent,
				{ ...config, conversationWriter, attachmentStore, mcpConnections },
				emitEvent,
				delivery,
			);
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

		setConversationWriter(value: ConversationRecordWriter | undefined): void {
			conversationWriter = value;
		},

		setAttachmentStore(value: AttachmentStore | undefined): void {
			attachmentStore = value;
		},

		setMcpConnections(value: McpConnectionResolver | undefined): void {
			mcpConnections = value;
		},
	};

	return ctx;
}

async function createLocalConversationRuntime(config: FlueContextConfig): Promise<{
	writer: ConversationRecordWriter;
	attachments: AttachmentStore;
}> {
	const store = new InMemoryConversationStreamStore();
	const path = agentStreamPath(config.agentName ?? 'agent', config.id);
	return {
		writer: await ConversationRecordWriter.create({
			store,
			path,
			identity: { agentName: config.agentName ?? 'agent', instanceId: config.id },
			producerId: `execution:${config.id}`,
		}),
		attachments: new InMemoryAttachmentStore(),
	};
}

async function initializeRootHarness(
	agent: Agent,
	config: FlueContextConfig,
	emitEvent: (event: FlueEventInput, observation?: FlueObservationDetail) => void,
	delivery?: DeliveredMessage,
): Promise<Harness> {
	if (!config.conversationWriter || !config.attachmentStore) {
		throw new Error('[flue] Canonical conversation runtime is not configured.');
	}
	// usePersistentState reads the instance's reduced state snapshot at render time and
	// writes through this buffer, which the session drains into the tool
	// batch's append. One buffer per harness lifetime (one submission attempt).
	const reduced = await config.conversationWriter.loadReducedState();
	// Instance-creation data comes from the birth record admission wrote
	// (already schema-parsed — the value renders see forever; data on later
	// messages is deliberately ignored, and nothing re-validates). Execution
	// never creates instance identity.
	if (!reduced.initialData) {
		throw new Error('[flue] Instance identity must exist before execution — admission creates it.');
	}
	const initialData = reduced.initialData.value;
	const hookState = createHookStateBuffer(reduced.state);
	const outputChannel = createAgentOutputChannel();
	// The delivery is a CURSOR over the messages put in front of the model:
	// it starts as the waking delivery and the session advances it when a
	// delivery joins the live response or a lifecycle callback appends a
	// signal, so every re-render's `useDelivery()` reads the latest input.
	const renderState: RenderStateContext = {
		snapshot: reduced.state,
		store: hookState,
		output: outputChannel,
		delivery,
		instanceId: config.id,
		...(config.agentName === undefined ? {} : { agentName: config.agentName }),
		initialData,
	};
	const first = renderAgentFunctionWithStructure(agent, renderState);
	// The render composes the whole config: hooks validated every value when
	// it was declared. Values are submission-scoped — read HERE, once per
	// initialized harness; a later render's different value takes effect on
	// the next submission. The sandbox is the one exception: a PRESENCE flip
	// swaps the environment at a turn boundary (see maybeSwapEnvironment).
	const definition: AgentRuntimeConfig = first.config;
	let lastStructure: AgentRenderStructure = first.structure;
	if (typeof definition.model !== 'string') {
		throw new Error(
			`[flue] The agent requires a model. Call useModel('provider-id/model-id') in the agent function.`,
		);
	}
	const resolvedModel = config.agentConfig.resolveModel(definition.model);
	if (!resolvedModel) {
		throw new Error(`[flue] The agent model "${definition.model}" could not be resolved.`);
	}
	// MCP declarations resolve alongside the sandbox: every declared server
	// connects in parallel, inside request context. Init-only like the rest of
	// the config — a declaration a later render adds or drops takes effect on
	// the next submission, where the durable resource-snapshot diff narrates
	// the tool-set change. A failed connect fails the submission before the
	// model runs — unless the definition is optional, which mounts zero tools
	// and narrates the gap instead. Rejections are never cached, so the next
	// submission retries either way.
	const [{ tools: mcpTools, unavailable: mcpUnavailable }, { env: baseEnv, toolFactory }] =
		await Promise.all([
			resolveMcpTools(config, definition.mcpConnections),
			resolveSessionEnv(config.id, definition.sandbox),
		]);
	for (const entry of mcpUnavailable) {
		emitEvent({
			type: 'log',
			level: 'warn',
			message: `MCP server "${entry.name}" is unavailable; its tools are not mounted for this submission.`,
			attributes: normalizeLogAttributes({ server: entry.name, reason: entry.reason }),
		});
	}
	const mcpResourceEntries = mcpTools.map((tool) => mcpToolResourceEntry(tool));
	const env =
		baseEnv && definition.cwd
			? createCwdSessionEnv(baseEnv, baseEnv.resolvePath(definition.cwd))
			: baseEnv;
	// The harness's mutable environment. A conditional useSandbox() whose
	// presence flips mid-submission swaps it at a turn boundary; every env
	// consumer reads through this slot. `undefined` when the render declared
	// no sandbox — there is no default environment.
	const envSlot: SessionEnvSlot = {
		env,
		toolFactory,
		rediscoverNeeded: false,
	};
	// Two live views of workspace discovery. `promptContext` backs the
	// system-prompt surfaces (recompose, catalog baseline) and stays frozen
	// across environment swaps until a compaction rebaseline — the prompt
	// must keep describing the workspace the transcript's earlier turns
	// actually ran in. `workspaceContext` backs the live skill merge and
	// follows the current environment immediately.
	let promptContext = await discoverSessionContext(env, definition.skills);
	let workspaceContext = promptContext;
	const envRuntime: SessionEnvRuntime = {
		resolve: (sandbox) => resolveSessionEnv(config.id, sandbox),
		swapDiscovery: async (nextEnv) => {
			workspaceContext = await discoverSessionContext(nextEnv, definition.skills);
		},
		rediscover: async (currentEnv) => {
			const fresh = await discoverSessionContext(currentEnv, definition.skills);
			promptContext = fresh;
			workspaceContext = fresh;
		},
	};
	// One render's model-facing resources: the declared snapshot with skills
	// merged over workspace discovery (what narration diffs), plus the live
	// maps that back skill activation and task-agent resolution.
	const renderedResources = (
		rendered: ReturnType<typeof renderAgentFunctionWithStructure>,
	): RenderedResources => {
		const skills = workspaceContext.mergeSkills(rendered.config.skills ?? []);
		return {
			snapshot: {
				...rendered.structure.resources,
				// MCP tools join the declared tool set for narration exactly as
				// they join the model-facing set: the init-resolved list, every
				// render of this submission.
				tools: [...rendered.structure.resources.tools, ...mcpResourceEntries],
				skills: skillCatalogEntries(skills),
				instructionsDigest: digestInstructions(rendered.config.instructions),
			},
			skills,
			subagents: Object.fromEntries(
				(rendered.config.subagents ?? []).map((candidate) => [candidate.name, candidate]),
			),
		};
	};
	const initialResources = renderedResources(first);
	// The frozen skill catalog: the durable baseline when this instance has
	// lived before, else this first render. Dynamic skill flips announce
	// themselves as `resources` signals instead of rewriting the prompt; a
	// compaction rebaseline swaps the catalog to the then-current set.
	const durableResources = reduced.resources;
	if (durableResources?.baseline) promptContext.setCatalog(durableResources.baseline.skills);
	// The "Available Agents" prompt section: the durable baseline when this
	// instance has lived before, else this first render's roster — the same
	// freeze rule as the skill catalog above.
	promptContext.setAgentCatalog(
		(durableResources?.baseline ?? initialResources.snapshot).subagents,
	);
	const agentConfig: AgentConfig = {
		...config.agentConfig,
		systemPrompt: promptContext.recompose(definition.instructions),
		instructions: definition.instructions,
		definitionSkills: definition.skills,
		skills: promptContext.skills,
		subagents: initialResources.subagents,
		model: resolvedModel,
		thinkingLevel: definition.thinkingLevel ?? config.agentConfig.thinkingLevel,
		compaction: definition.compaction ?? config.agentConfig.compaction,
		// Submission retry policy: binding config (not a hook) because the
		// policy must be readable even when the render itself crashes — the
		// runner that bound this agent decided it.
		durability: resolveAgentDurability(config.agentName),
	};
	// Per-turn re-render: fresh closures over the latest state values, the
	// identity-invariance guard, and a recomposed system prompt. The session
	// applies the result at each turn boundary, so mid-run state writes reach
	// the very next model call (guards read current truth; interpolated text
	// stays live). Resources (tools, skills, subagents) may change between
	// renders — the session narrates the delta to the model.
	const rerender: SessionRerender = () => {
		const next = renderAgentFunctionWithStructure(agent, renderState);
		assertRenderStructureInvariance(lastStructure, next.structure);
		lastStructure = next.structure;
		return {
			// `promptContext` is read at call time: frozen across environment
			// swaps, refreshed by the compaction rebaseline's rediscover.
			systemPrompt: promptContext.recompose(next.config.instructions),
			tools: [...(next.config.tools ?? []), ...mcpTools],
			resources: renderedResources(next),
			sandbox: next.config.sandbox,
			cwd: next.config.cwd,
		};
	};
	const resourceRuntime: SessionResourceRuntime = {
		initial: initialResources,
		...(durableResources?.baseline ? { baseline: durableResources.baseline } : {}),
		...(durableResources?.narrated ? { narrated: durableResources.narrated } : {}),
		rebaseline: (snapshot) => {
			promptContext.setCatalog(snapshot.skills);
			promptContext.setAgentCatalog(snapshot.subagents);
		},
	};
	return new Harness({
		name: 'default',
		config: agentConfig,
		env,
		eventCallback: emitEvent,
		agentTools: [...(definition.tools ?? []), ...mcpTools],
		mcpUnavailable,
		toolFactory,
		conversationWriter: config.conversationWriter,
		attachmentStore: config.attachmentStore,
		executionContext: { instanceId: config.id },
		hookState,
		rerender,
		output: outputChannel,
		advanceDelivery: (message) => {
			renderState.delivery = message;
		},
		resources: resourceRuntime,
		envSlot,
		envRuntime,
	});
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Resolve the render's MCP declarations to adapted tool definitions — every
 * declared server in parallel, through the context's resolver when a
 * coordinator injected one (per-instance connection reuse), else a fresh
 * connection per initialized harness.
 */
async function resolveMcpTools(
	config: FlueContextConfig,
	definitions: readonly McpConnectionDefinition[] | undefined,
): Promise<{ tools: ToolDefinition[]; unavailable: McpUnavailableConnection[] }> {
	if (!definitions || definitions.length === 0) return { tools: [], unavailable: [] };
	const resolver = config.mcpConnections;
	const settled = await Promise.allSettled(
		definitions.map((definition) =>
			resolver ? resolver.resolve(definition) : createMcpConnection(definition),
		),
	);
	const tools: ToolDefinition[] = [];
	const unavailable: McpUnavailableConnection[] = [];
	for (const [index, result] of settled.entries()) {
		const declared = definitions[index] as McpConnectionDefinition;
		if (result.status === 'fulfilled') {
			tools.push(...result.value.tools);
		} else if (declared.optional) {
			unavailable.push({
				name: declared.name,
				reason: result.reason instanceof Error ? result.reason.message : String(result.reason),
			});
		} else {
			throw result.reason;
		}
	}
	return { tools, unavailable };
}

/**
 * Resource-snapshot entry for a resolved MCP tool. MCP tools carry their raw
 * JSON schema on the prepared adapter (no valibot `input`), so the fingerprint
 * reads it from there.
 */
function mcpToolResourceEntry(tool: ToolDefinition): ToolResourceEntry {
	const adapter = getPreparedToolAdapter(tool);
	return {
		name: tool.name,
		description: tool.description,
		...(adapter ? { schema: JSON.stringify(adapter.parameters) } : {}),
	};
}

function isSandboxFactory(value: unknown): value is SandboxFactory {
	return (
		typeof value === 'object' &&
		value !== null &&
		'createSessionEnv' in value &&
		typeof (value as any).createSessionEnv === 'function'
	);
}

/**
 * Resolve the sandbox option to its session environment and optional tool
 * factory. No `useSandbox()` means no environment: the built-in shell and
 * filesystem tools aren't added, and sandbox-backed operations throw.
 */
async function resolveSessionEnv(
	id: string,
	sandbox: AgentRuntimeConfig['sandbox'],
): Promise<{ env: SessionEnv | undefined; toolFactory?: SessionToolFactory }> {
	if (sandbox === undefined) {
		return { env: undefined };
	}
	if (isSandboxFactory(sandbox)) {
		const env = await sandbox.createSessionEnv({ id });
		return { env, toolFactory: sandbox.tools };
	}
	throw new Error('[flue] Invalid sandbox option composed by the agent function.');
}
