import type * as v from 'valibot';
import { abortErrorFor, createCallHandle } from './abort.ts';
import { SUBMISSION_HARNESS_NAME, SUBMISSION_SESSION_NAME } from './adapter-helpers.ts';
import { discoverSessionContext } from './context.ts';
import type { ConversationRecordWriter } from './conversation-writer.ts';
import { SessionNotFoundError } from './errors.ts';
import type { FlueExecutionContext } from './execution-interceptor.ts';
import type { HookStateBuffer } from './hooks/use-persistent-state.ts';
import type { McpUnavailableConnection } from './mcp-types.ts';
import type { AgentOutputChannel } from './message-output.ts';
import type { AttachmentStore } from './runtime/attachment-store.ts';
import { createConversationIdentity } from './runtime/ids.ts';
import { createCwdSessionEnv } from './sandbox.ts';
import {
	type CreateTaskSessionOptions,
	createPublicSession,
	Session,
	type SessionEnvRuntime,
	type SessionEnvSlot,
	type SessionRerender,
	type SessionResourceRuntime,
} from './session.ts';
import {
	assertPublicSessionName,
	createActionScopeName,
	createTaskSessionName,
} from './session-identity.ts';
import type {
	AgentConfig,
	CallHandle,
	DeliveredMessage,
	FlueEventInputCallback,
	FlueHarness,
	FlueSession,
	PromptOptions,
	PromptResponse,
	PromptResultResponse,
	ResolvedSubagent,
	SessionEnv,
	SessionToolFactory,
	ToolDefinition,
} from './types.ts';

const DEFAULT_SESSION_NAME = 'default';

export interface HarnessOptions {
	/** Harness name (`"default"` at the root; the nested scope name for action children). */
	name: string;
	config: AgentConfig;
	/** Initial environment (or none); wrapped in a fresh env slot unless `envSlot` is provided. */
	env: SessionEnv | undefined;
	eventCallback?: FlueEventInputCallback;
	agentTools: ToolDefinition[];
	/** Optional MCP connections that failed to resolve at initialization. */
	mcpUnavailable?: McpUnavailableConnection[];
	toolFactory?: SessionToolFactory;
	conversationWriter: ConversationRecordWriter;
	attachmentStore: AttachmentStore;
	executionContext?: FlueExecutionContext;
	scopeName?: string;
	scopeDepth?: number;
	retainSession?: (
		session: string,
		conversation: { conversationId: string; affinityKey: string; createdAt: string },
		harness: string,
	) => Promise<void>;
	/** Aborting this signal aborts the harness scope and its sessions. */
	scopeSignal?: AbortSignal;
	/**
	 * `usePersistentState` write buffer from this harness's render, when the
	 * agent was authored as a function. Handed to the sessions this harness
	 * opens directly (never task/action children) so their tool batches drain
	 * it.
	 */
	hookState?: HookStateBuffer;
	/** Per-turn re-render for function agents; same routing as hookState. */
	rerender?: SessionRerender;
	/** Client-facing output channel (useDataWriter, lifecycle/boundary hooks); same routing as hookState. */
	output?: AgentOutputChannel;
	/**
	 * Advance the render state's delivery cursor (function agents only):
	 * `useDelivery()` returns the latest message put in front of the model,
	 * so the session moves it when a delivery joins the live response or a
	 * lifecycle callback appends a signal. Same routing as hookState.
	 */
	advanceDelivery?: (message: DeliveredMessage) => void;
	/** Dynamic-resource runtime (function agents only); same routing as hookState. */
	resources?: SessionResourceRuntime;
	/**
	 * Shared mutable environment slot from harness init (function agents
	 * only). When absent, a fresh slot wraps `env`/`toolFactory` — same
	 * behavior as before, nothing ever swaps it.
	 */
	envSlot?: SessionEnvSlot;
	/** Environment-swap wiring (function agents only); same routing as hookState. */
	envRuntime?: SessionEnvRuntime;
}

export class Harness implements FlueHarness {
	/**
	 * The agent's CURRENT environment — the live {@link SessionEnv} behind the
	 * shared env slot. A live getter, not a snapshot: a conditional
	 * `useSandbox()` may swap the environment at a turn boundary, and this
	 * surface follows. Code doing conditional swaps owns not caching the
	 * returned reference across boundaries. The public direct-to-sandbox
	 * surface. THROWS when the agent declared no sandbox — there is no
	 * default environment.
	 */
	get sandbox(): SessionEnv {
		const env = this.envSlot.env;
		if (!env) {
			throw new Error(
				'[flue] This agent has no sandbox. Declare one with useSandbox() to use shell and filesystem operations.',
			);
		}
		return env;
	}

	/**
	 * The harness's mutable environment: shared by reference with every
	 * session this harness opens, so a session-driven swap is visible here
	 * and to sessions opened later. Fresh per harness when the constructor
	 * receives none (action harnesses, task-less legacy paths).
	 */
	private envSlot: SessionEnvSlot;

	private openSessions = new Map<string, Session>();
	private pendingSessionOperations = new Map<string, Promise<void>>();
	private scopeAbortController = new AbortController();
	private closePromise: Promise<void> | undefined;

	readonly name: string;
	private config: AgentConfig;
	private eventCallback: FlueEventInputCallback | undefined;
	private agentTools: ToolDefinition[];
	private mcpUnavailable: McpUnavailableConnection[];
	private conversationWriter: ConversationRecordWriter;
	private attachmentStore: AttachmentStore;
	private executionContext: FlueExecutionContext;
	private scopeName: string | undefined;
	private scopeDepth: number;
	private retainSession: HarnessOptions['retainSession'];
	private hookState: HookStateBuffer | undefined;
	private rerender: SessionRerender | undefined;
	private output: AgentOutputChannel | undefined;
	private advanceDelivery: ((message: DeliveredMessage) => void) | undefined;
	private resources: SessionResourceRuntime | undefined;
	private envRuntime: SessionEnvRuntime | undefined;

	constructor(options: HarnessOptions) {
		this.name = options.name;
		this.config = options.config;
		this.eventCallback = options.eventCallback;
		this.agentTools = options.agentTools;
		this.mcpUnavailable = options.mcpUnavailable ?? [];
		this.conversationWriter = options.conversationWriter;
		this.attachmentStore = options.attachmentStore;
		this.executionContext = options.executionContext ?? {};
		this.scopeName = options.scopeName;
		this.scopeDepth = options.scopeDepth ?? 0;
		this.retainSession = options.retainSession;
		this.hookState = options.hookState;
		this.rerender = options.rerender;
		this.output = options.output;
		this.advanceDelivery = options.advanceDelivery;
		this.resources = options.resources;
		this.envRuntime = options.envRuntime;
		this.envSlot = options.envSlot ?? {
			env: options.env,
			toolFactory: options.toolFactory,
			rediscoverNeeded: false,
		};
		const scopeSignal = options.scopeSignal;
		if (scopeSignal) {
			if (scopeSignal.aborted) this.scopeAbortController.abort(scopeSignal.reason);
			else
				scopeSignal.addEventListener(
					'abort',
					() => this.scopeAbortController.abort(scopeSignal.reason),
					{ once: true },
				);
		}
	}

	/**
	 * Get or create a session by name (defaults to `'default'`). Not part of
	 * the public {@link FlueHarness} surface — the flattened `prompt`/`compact`
	 * methods below drive the default session.
	 */
	async session(name?: string): Promise<FlueSession> {
		return this.openSession(name);
	}

	prompt<S extends v.GenericSchema>(
		text: string,
		options: PromptOptions<S> & { result: S },
	): CallHandle<PromptResultResponse<v.InferOutput<S>>>;
	prompt(text: string, options?: PromptOptions): CallHandle<PromptResponse>;
	prompt(text: string, options?: PromptOptions<v.GenericSchema | undefined>): CallHandle<any> {
		return this.defaultSessionCall(options?.signal, (session, signal) =>
			session.prompt(text, { ...options, signal } as PromptOptions),
		);
	}

	async compact(): Promise<void> {
		const session = await this.session();
		return session.compact();
	}

	/**
	 * Defer one default-session operation behind the session's lazy open,
	 * preserving the synchronous CallHandle contract: aborting the returned
	 * handle (or the harness scope) aborts the open and the inner call.
	 */
	private defaultSessionCall<T>(
		external: AbortSignal | undefined,
		run: (session: FlueSession, signal: AbortSignal) => CallHandle<T>,
	): CallHandle<T> {
		const merged = external
			? AbortSignal.any([external, this.scopeAbortController.signal])
			: this.scopeAbortController.signal;
		return createCallHandle(merged, async (signal) => {
			const session = await this.session();
			return run(session, signal);
		});
	}

	private async openSession(name?: string): Promise<FlueSession> {
		const sessionName = normalizeSessionName(name);
		assertPublicSessionName(sessionName);
		const session = await this.runSessionOperation(sessionName, () =>
			this.loadSession(sessionName),
		);
		// User code only ever receives the FlueSession facade; the internal
		// Session (durable submission executor, abort/close, metadata) stays
		// runtime-owned.
		return createPublicSession(session);
	}

	private runSessionOperation<T>(sessionName: string, operation: () => Promise<T>): Promise<T> {
		const previous = this.pendingSessionOperations.get(sessionName) ?? Promise.resolve();
		const result = previous.then(operation);
		const tail = result.then(
			() => {},
			() => {},
		);
		this.pendingSessionOperations.set(sessionName, tail);
		void tail.then(() => {
			if (this.pendingSessionOperations.get(sessionName) === tail) {
				this.pendingSessionOperations.delete(sessionName);
			}
		});
		return result;
	}

	private async loadSession(sessionName: string): Promise<Session> {
		if (this.scopeAbortController.signal.aborted)
			throw abortErrorFor(this.scopeAbortController.signal);
		const open = this.openSessions.get(sessionName);
		if (open) return open;

		const harnessScope = this.scopeName ? `${this.name}:${this.scopeName}` : this.name;
		let conversation = await this.conversationWriter.findConversation(harnessScope, sessionName);
		if (!conversation) {
			// The submission root (default harness, default session) is the birth
			// record — admission owns its creation, so a miss here is a lifecycle
			// violation, never a create.
			if (
				!this.retainSession &&
				harnessScope === SUBMISSION_HARNESS_NAME &&
				sessionName === SUBMISSION_SESSION_NAME
			) {
				throw new Error(
					'[flue] Instance identity must exist before execution — admission creates it.',
				);
			}
			const identity = createConversationIdentity();
			if (this.retainSession) await this.retainSession(sessionName, identity, harnessScope);
			else
				await this.conversationWriter.ensureConversation({
					kind: 'root',
					conversationId: identity.conversationId,
					harness: harnessScope,
					session: sessionName,
					affinityKey: identity.affinityKey,
					createdAt: identity.createdAt,
				});
			conversation = await this.conversationWriter.findConversation(harnessScope, sessionName);
			if (!conversation)
				throw new SessionNotFoundError({ session: sessionName, harness: this.name });
		}

		const session = new Session({
			name: sessionName,
			conversation,
			config: this.config,
			onAgentEvent: this.decorateEventCallback(this.eventCallback),
			agentTools: this.agentTools,
			mcpUnavailable: this.mcpUnavailable,
			delegationDepth: this.scopeDepth,
			createTaskSession: (taskOptions) => this.createTaskSession(taskOptions),
			createActionHarness: (actionOptions) => this.createActionHarness(actionOptions),
			scopeSignal: this.scopeAbortController.signal,
			onClose: () => this.openSessions.delete(sessionName),
			conversationWriter: this.conversationWriter,
			attachmentStore: this.attachmentStore,
			executionContext: { ...this.executionContext, harness: harnessScope },
			hookState: this.hookState,
			rerender: this.rerender,
			output: this.output,
			advanceDelivery: this.advanceDelivery,
			resources: this.resources,
			envSlot: this.envSlot,
			envRuntime: this.envRuntime,
		});
		await session.initializeCanonicalContext();
		this.openSessions.set(sessionName, session);
		return session;
	}

	private async createTaskSession(options: CreateTaskSessionOptions): Promise<Session> {
		const sessionName = createTaskSessionName(options.parentSession, options.taskId);
		const taskEnv =
			options.parentEnv && options.cwd
				? createCwdSessionEnv(options.parentEnv, options.parentEnv.resolvePath(options.cwd))
				: options.parentEnv;
		const taskAgent = options.agent;
		// Task children are self-contained: behavior/identity fields
		// (instructions, tools, skills, subagents) come only from the selected
		// profile — omitted means none, NEVER the parent's. An agent-less task
		// (programmatic `session.task()` without `agent`, or a durable replay
		// of a pre-required-agent call) runs the same blank child the
		// `GeneralSubagent` declaration names: fresh context, filesystem
		// discovery, environment tools. Environment fields (model,
		// thinkingLevel, compaction) inherit from the parent as runtime
		// defaults.
		const instructions = taskAgent?.instructions;
		const definitionSkills = taskAgent?.skills;
		const localContext = await discoverSessionContext(taskEnv, definitionSkills);
		// The child's "Available Agents" section is its own (nested) roster —
		// a blank or leaf delegate correctly reads "None".
		localContext.setAgentCatalog(
			(taskAgent?.subagents ?? []).map((subagent) => ({
				name: subagent.name,
				...(subagent.description !== undefined ? { description: subagent.description } : {}),
			})),
		);
		const taskModel =
			taskAgent?.model !== undefined
				? this.config.resolveModel(taskAgent.model)
				: this.config.model;
		if (!taskModel) {
			throw new Error(`[flue] Subagent model "${taskAgent?.model}" could not be resolved.`);
		}
		const taskConfig: AgentConfig = {
			...this.config,
			// Recompose AFTER the agent-catalog seed above — the discovery-time
			// composition predates it.
			systemPrompt: localContext.recompose(instructions),
			instructions,
			definitionSkills,
			skills: localContext.skills,
			subagents: Object.fromEntries(
				(taskAgent?.subagents ?? []).map((agent) => [agent.name, agent]),
			),
			model: taskModel,
			thinkingLevel: taskAgent?.thinkingLevel ?? this.config.thinkingLevel,
			compaction: this.config.compaction,
		};
		const harnessScope = this.scopeName ? `${this.name}:${this.scopeName}` : this.name;
		// Reattach (recovery) reuses the existing child conversation: its
		// `conversation_created` + `child_session_retained` records are already
		// durable (and reducer-validated on load), so creation is skipped. A fresh
		// task mints a new identity and writes those records.
		const conversationId =
			options.existing?.conversationId ??
			(await this.createChildConversation(options, harnessScope, sessionName, taskAgent));
		const eventCallback: FlueEventInputCallback | undefined = this.eventCallback
			? (event, observation) => {
					this.eventCallback?.(
						{
							...event,
							harness: event.harness ?? this.name,
							parentSession: event.parentSession ?? options.parentSession,
							taskId: event.taskId ?? options.taskId,
						},
						observation,
					);
				}
			: undefined;

		const conversation = await this.conversationWriter.getConversation(conversationId);
		if (!conversation) throw new SessionNotFoundError({ session: sessionName, harness: this.name });
		const session = new Session({
			name: sessionName,
			conversation,
			config: taskConfig,
			// A fresh detached slot: the child's environment is captured at
			// creation and never follows the parent's turn-boundary swaps.
			envSlot: {
				env: taskEnv,
				toolFactory: this.envSlot.toolFactory,
				rediscoverNeeded: false,
			},
			onAgentEvent: eventCallback,
			agentTools: taskAgent?.tools ?? [],
			delegationDepth: options.depth,
			createTaskSession: (childOptions) => this.createTaskSession(childOptions),
			createActionHarness: (actionOptions) => this.createActionHarness(actionOptions),
			scopeSignal: this.scopeAbortController.signal,
			conversationWriter: this.conversationWriter,
			attachmentStore: this.attachmentStore,
			executionContext: { ...this.executionContext, harness: harnessScope, taskId: options.taskId },
		});
		await session.initializeCanonicalContext();
		return session;
	}

	/** Mint a fresh child conversation identity and durably record its creation
	 *  plus the parent's retained link. Returns the new child conversation id. */
	private async createChildConversation(
		options: CreateTaskSessionOptions,
		harnessScope: string,
		sessionName: string,
		taskAgent: ResolvedSubagent | undefined,
	): Promise<string> {
		const identity = createConversationIdentity();
		await this.conversationWriter.ensureChildConversation({
			parent: {
				conversationId: options.parentConversationId,
				harness: harnessScope,
				session: options.parentSession,
			},
			child: {
				kind: 'task',
				conversationId: identity.conversationId,
				harness: harnessScope,
				session: sessionName,
				affinityKey: identity.affinityKey,
				createdAt: identity.createdAt,
				parentConversationId: options.parentConversationId,
				taskId: options.taskId,
				...(taskAgent?.name ? { agent: taskAgent.name } : {}),
			},
			ref: {
				conversationId: identity.conversationId,
				harness: harnessScope,
				session: sessionName,
				type: 'task',
				taskId: options.taskId,
				...(options.parentToolCallId ? { parentToolCallId: options.parentToolCallId } : {}),
				...(options.parentAssistantEntryId
					? { parentAssistantEntryId: options.parentAssistantEntryId }
					: {}),
			},
		});
		return identity.conversationId;
	}

	private createActionHarness: import('./session.ts').CreateActionHarness = (options) => {
		const scope = createActionScopeName(options.invocationId);
		const nestedScope = this.scopeName ? `${this.scopeName}:${scope}` : scope;
		const harness = new Harness({
			name: this.name,
			config: options.config,
			env: options.env,
			eventCallback: options.eventCallback ?? this.eventCallback,
			agentTools: options.tools,
			toolFactory: this.envSlot.toolFactory,
			conversationWriter: this.conversationWriter,
			attachmentStore: this.attachmentStore,
			executionContext: options.executionContext,
			scopeName: nestedScope,
			scopeDepth: options.depth,
			retainSession: (session, conversation, harnessScope) =>
				options.retainSession(session, conversation, harnessScope),
			scopeSignal: options.signal,
		});
		return harness;
	};

	close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		this.scopeAbortController.abort();
		for (const session of this.openSessions.values()) session.abort();
		this.closePromise = (async () => {
			await Promise.allSettled(this.pendingSessionOperations.values());
			const sessions = [...this.openSessions.values()];
			await Promise.allSettled(sessions.map((session) => session.close()));
			this.openSessions.clear();
		})();
		return this.closePromise;
	}

	private decorateEventCallback(
		callback: FlueEventInputCallback | undefined,
	): FlueEventInputCallback | undefined {
		return callback
			? (event, observation) => {
					callback({ ...event, harness: event.harness ?? this.name }, observation);
				}
			: undefined;
	}
}

function normalizeSessionName(name: string | undefined): string {
	return name ?? DEFAULT_SESSION_NAME;
}
