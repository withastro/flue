import { abortErrorFor, createCallHandle } from './abort.ts';
import type { ActionDefinition } from './action.ts';
import { discoverSessionContext } from './context.ts';
import type { ConversationRecordWriter } from './conversation-writer.ts';
import { SessionAlreadyExistsError, SessionNotFoundError } from './errors.ts';
import type { FlueExecutionContext } from './execution-interceptor.ts';
import type { AttachmentStore } from './runtime/attachment-store.ts';
import { generateConversationId, generateSessionAffinityKey } from './runtime/ids.ts';
import { createCwdSessionEnv, createFlueFs } from './sandbox.ts';
import {
	type CreateTaskSessionOptions,
	createPublicSession,
	Session,
} from './session.ts';
import {
	assertPublicSessionName,
	createActionScopeName,
	createTaskSessionName,
} from './session-identity.ts';
import { execShellWithEvents } from './shell.ts';
import type {
	AgentConfig,
	AgentProfile,
	CallHandle,
	FlueEventInput,
	FlueEventInputCallback,
	FlueFs,
	FlueHarness,
	FlueObservationDetail,
	FlueSession,
	FlueSessions,
	SessionEnv,
	SessionToolFactory,
	ShellOptions,
	ShellResult,
	ToolDefinition,
} from './types.ts';

const DEFAULT_SESSION_NAME = 'default';

type OpenMode = 'get-or-create' | 'get' | 'create';

export class Harness implements FlueHarness {
	readonly sessions: FlueSessions = {
		get: (name?: string) => this.openSession(name, 'get'),
		create: (name?: string) => this.openSession(name, 'create'),
	};

	readonly fs: FlueFs;

	private openSessions = new Map<string, Session>();
	private pendingSessionOperations = new Map<string, Promise<void>>();
	private activeShellCalls = new Set<CallHandle<ShellResult>>();
	private scopeAbortController = new AbortController();
	private closePromise: Promise<void> | undefined;

	constructor(
		private instanceId: string,
		readonly name: string,
		private config: AgentConfig,
		private env: SessionEnv,
		private eventCallback: FlueEventInputCallback | undefined,

		private agentTools: ToolDefinition[],
		private toolFactory: SessionToolFactory | undefined,
		private conversationWriter: ConversationRecordWriter,
		private attachmentStore: AttachmentStore,
		private actions: ActionDefinition[] = config.actions ?? [],
		private executionContext: FlueExecutionContext = {},
		private scopeName?: string,
		private scopeDepth = 0,
		private retainSession?: (
			session: string,
			conversation: { conversationId: string; affinityKey: string; createdAt: string },
			harness: string,
		) => Promise<void>,
		scopeSignal?: AbortSignal,
	) {
		this.fs = createFlueFs(env);
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

	async session(name?: string): Promise<FlueSession> {
		return this.openSession(name, 'get-or-create');
	}

	shell(command: string, options?: ShellOptions): CallHandle<ShellResult> {
		const externalSignal = options?.signal
			? AbortSignal.any([options.signal, this.scopeAbortController.signal])
			: this.scopeAbortController.signal;
		const call = createCallHandle(externalSignal, (signal) =>
			execShellWithEvents(
				this.env,
				(event, detail) => this.emit(event, detail),
				command,
				options,
				signal,
				this.executionContext,
			),
		);
		this.activeShellCalls.add(call);
		void call.then(
			() => this.activeShellCalls.delete(call),
			() => this.activeShellCalls.delete(call),
		);
		return call;
	}

	private async openSession(name: string | undefined, mode: OpenMode): Promise<FlueSession> {
		const sessionName = normalizeSessionName(name);
		assertPublicSessionName(sessionName);
		const session = await this.runSessionOperation(sessionName, () =>
			this.loadSession(sessionName, mode),
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

	private async loadSession(sessionName: string, mode: OpenMode): Promise<Session> {
		if (this.scopeAbortController.signal.aborted)
			throw abortErrorFor(this.scopeAbortController.signal);
		const open = this.openSessions.get(sessionName);
		if (open) {
			if (mode === 'create') {
				throw new SessionAlreadyExistsError({ session: sessionName, harness: this.name });
			}
			return open;
		}

		const harnessScope = this.scopeName ? `${this.name}:${this.scopeName}` : this.name;
		let conversation = await this.conversationWriter.findConversation(harnessScope, sessionName);
		if (mode === 'get' && !conversation) {
			throw new SessionNotFoundError({ session: sessionName, harness: this.name });
		}
		if (mode === 'create' && conversation) {
			throw new SessionAlreadyExistsError({ session: sessionName, harness: this.name });
		}
		if (!conversation) {
			const identity = createConversationIdentity();
			if (this.retainSession) await this.retainSession(sessionName, identity, harnessScope);
			else await this.conversationWriter.ensureConversation({
				kind: 'root',
				conversationId: identity.conversationId,
				harness: harnessScope,
				session: sessionName,
				affinityKey: identity.affinityKey,
				createdAt: identity.createdAt,
			});
			conversation = await this.conversationWriter.findConversation(harnessScope, sessionName);
			if (!conversation) throw new SessionNotFoundError({ session: sessionName, harness: this.name });
		}

		const session = new Session({
			name: sessionName,
			conversation,
			config: this.config,
			env: this.env,
			onAgentEvent: this.decorateEventCallback(this.eventCallback),
			agentTools: this.agentTools,
			toolFactory: this.toolFactory,
			delegationDepth: this.scopeDepth,
			createTaskSession: (taskOptions) => this.createTaskSession(taskOptions),
			actions: this.actions,
			createActionHarness: (actionOptions) => this.createActionHarness(actionOptions),
			scopeSignal: this.scopeAbortController.signal,
			onClose: () => this.openSessions.delete(sessionName),
			conversationWriter: this.conversationWriter,
			attachmentStore: this.attachmentStore,
			executionContext: { ...this.executionContext, harness: harnessScope },
		});
		await session.initializeCanonicalContext();
		this.openSessions.set(sessionName, session);
		return session;
	}

	private async createTaskSession(options: CreateTaskSessionOptions): Promise<Session> {
		const sessionName = createTaskSessionName(options.parentSession, options.taskId);
		const taskEnv = options.cwd
			? createCwdSessionEnv(options.parentEnv, options.parentEnv.resolvePath(options.cwd))
			: options.parentEnv;
		const taskAgent = options.agent;
		// Subagent profiles are self-contained: capability/identity fields
		// (instructions, tools, skills, subagents) come only from the profile —
		// omitted means none, never the parent's. Environment fields (model,
		// thinkingLevel, compaction) inherit from the parent as runtime
		// defaults. Agent-less tasks reuse the parent's full config.
		const instructions = taskAgent ? taskAgent.instructions : this.config.instructions;
		const definitionSkills = taskAgent ? taskAgent.skills : this.config.definitionSkills;
		const localContext = await discoverSessionContext(taskEnv, instructions, definitionSkills);
		const taskConfig: AgentConfig = {
			...this.config,
			systemPrompt: localContext.systemPrompt,
			instructions,
			definitionSkills,
			skills: localContext.skills,
			actions: taskAgent ? taskAgent.actions : this.config.actions,
			subagents: taskAgent
				? Object.fromEntries(
						(taskAgent.subagents ?? [])
							.filter((agent): agent is AgentProfile & { name: string } => agent.name !== undefined)
							.map((agent) => [agent.name, agent]),
					)
				: this.config.subagents,
			model:
				taskAgent?.model !== undefined
					? this.config.resolveModel(taskAgent.model)
					: this.config.model,
			thinkingLevel: taskAgent?.thinkingLevel ?? this.config.thinkingLevel,
			compaction: taskAgent?.compaction ?? this.config.compaction,
		};
		const identity = createConversationIdentity();
		const harnessScope = this.scopeName ? `${this.name}:${this.scopeName}` : this.name;
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
			},
			ref: {
				conversationId: identity.conversationId,
				harness: harnessScope,
				session: sessionName,
				type: 'task',
				taskId: options.taskId,
			},
		});
		const eventCallback: FlueEventInputCallback | undefined = this.eventCallback
			? (event, observation) => {
					this.eventCallback?.({
						...event,
						harness: event.harness ?? this.name,
						parentSession: event.parentSession ?? options.parentSession,
						taskId: event.taskId ?? options.taskId,
					}, observation);
				}
			: undefined;

		const conversation = await this.conversationWriter.getConversation(identity.conversationId);
		if (!conversation) throw new SessionNotFoundError({ session: sessionName, harness: this.name });
		const session = new Session({
			name: sessionName,
			conversation,
			config: taskConfig,
			env: taskEnv,
			onAgentEvent: eventCallback,
			agentTools: taskAgent ? (taskAgent.tools ?? []) : this.agentTools,
			toolFactory: this.toolFactory,
			delegationDepth: options.depth,
			createTaskSession: (childOptions) => this.createTaskSession(childOptions),
			actions: taskConfig.actions ?? [],
			createActionHarness: (actionOptions) => this.createActionHarness(actionOptions),
			scopeSignal: this.scopeAbortController.signal,
			conversationWriter: this.conversationWriter,
			attachmentStore: this.attachmentStore,
			executionContext: { ...this.executionContext, harness: harnessScope, taskId: options.taskId },
		});
		await session.initializeCanonicalContext();
		return session;
	}

	private createActionHarness: import('./session.ts').CreateActionHarness = (options) => {
		const scope = createActionScopeName(options.invocationId);
		const nestedScope = this.scopeName ? `${this.scopeName}:${scope}` : scope;
		const harness = new Harness(
			this.instanceId,
			this.name,
			options.config,
			options.env,
			options.eventCallback ?? this.eventCallback,
			options.tools,
			this.toolFactory,
			this.conversationWriter,
			this.attachmentStore,
			options.actions,
			options.executionContext,
			nestedScope,
			options.depth,
			(session, conversation, harnessScope) =>
				options.retainSession(session, conversation, harnessScope),
			options.signal,
		);
		return harness;
	};

	close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		this.scopeAbortController.abort();
		for (const call of this.activeShellCalls) call.abort();
		for (const session of this.openSessions.values()) session.abort();
		this.closePromise = (async () => {
			await Promise.allSettled([
				...this.pendingSessionOperations.values(),
				...this.activeShellCalls,
			]);
			this.activeShellCalls.clear();
			const sessions = [...this.openSessions.values()];
			await Promise.allSettled(sessions.map((session) => session.close()));
			this.openSessions.clear();
		})();
		return this.closePromise;
	}

	private emit(event: FlueEventInput, observation?: FlueObservationDetail): void {
		this.eventCallback?.({ ...event, harness: event.harness ?? this.name }, observation);
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

function createConversationIdentity(): {
	conversationId: string;
	affinityKey: string;
	createdAt: string;
} {
	return {
		conversationId: generateConversationId(),
		affinityKey: generateSessionAffinityKey(),
		createdAt: new Date().toISOString(),
	};
}
