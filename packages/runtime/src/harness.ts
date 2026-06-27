import { abortErrorFor, createCallHandle } from './abort.ts';
import type { ActionDefinition } from './action.ts';
import type { AgentSubmissionStore } from './agent-execution-store.ts';
import { discoverSessionContext } from './context.ts';
import type { FlueExecutionContext } from './execution-interceptor.ts';
import { SessionAlreadyExistsError, SessionNotFoundError } from './errors.ts';
import { generateConversationId, generateSessionAffinityKey } from './runtime/ids.ts';
import { createCwdSessionEnv, createFlueFs } from './sandbox.ts';
import {
	type CreateTaskSessionOptions,
	createPublicSession,
	deleteSessionTree,
	Session,
} from './session.ts';
import {
	assertPublicSessionName,
	createActionScopeName,
	createSessionStorageKey,
	createTaskSessionName,
} from './session-identity.ts';
import { execShellWithEvents } from './shell.ts';
import type {
	AgentConfig,
	AgentProfile,
	CallHandle,
	FlueEventInput,
	FlueEventInputCallback,
	FlueObservationDetail,
	FlueFs,
	FlueHarness,
	FlueSession,
	FlueSessions,
	SessionData,
	SessionEnv,
	SessionStore,
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
		delete: (name?: string) => this.deleteSession(name),
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
		private store: SessionStore,
		private eventCallback?: FlueEventInputCallback,
		private agentTools: ToolDefinition[] = [],
		private toolFactory?: SessionToolFactory,
		private submissionStore?: AgentSubmissionStore,
		private actions: ActionDefinition[] = config.actions ?? [],
		private executionContext: FlueExecutionContext = {},
		private scopeName?: string,
		private scopeDepth = 0,
		private retainSession?: (session: string) => Promise<void>,
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

		const storageKey = createSessionStorageKey(
			this.instanceId,
			this.scopeName ? `${this.name}:${this.scopeName}` : this.name,
			sessionName,
		);
		const existingData = await this.store.load(storageKey);
		if (mode === 'get' && !existingData) {
			throw new SessionNotFoundError({ session: sessionName, harness: this.name });
		}
		if (mode === 'create' && existingData) {
			throw new SessionAlreadyExistsError({ session: sessionName, harness: this.name });
		}

		let data = existingData;
		if (!data) {
			data = createEmptySessionData();
			await this.retainSession?.(sessionName);
			await this.store.save(storageKey, data);
		}

		const session = new Session({
			name: sessionName,
			storageKey,
			conversationId: data.conversationId,
			affinityKey: data.affinityKey,
			config: this.config,
			env: this.env,
			store: this.store,
			existingData: data,
			onAgentEvent: this.decorateEventCallback(this.eventCallback),
			agentTools: this.agentTools,
			toolFactory: this.toolFactory,
			delegationDepth: this.scopeDepth,
			createTaskSession: (taskOptions) => this.createTaskSession(taskOptions),
			actions: this.actions,
			createActionHarness: (actionOptions) => this.createActionHarness(actionOptions),
			scopeSignal: this.scopeAbortController.signal,
			onDelete: () => this.openSessions.delete(sessionName),
			submissionStore: this.submissionStore,
			executionContext: { ...this.executionContext, harness: this.name },
		});
		this.openSessions.set(sessionName, session);
		return session;
	}

	private async deleteSession(name: string | undefined): Promise<void> {
		const sessionName = normalizeSessionName(name);
		assertPublicSessionName(sessionName);
		return this.runSessionOperation(sessionName, async () => {
			const open = this.openSessions.get(sessionName);
			if (open) {
				await open.delete();
				return;
			}
			const storageKey = createSessionStorageKey(
				this.instanceId,
				this.scopeName ? `${this.name}:${this.scopeName}` : this.name,
				sessionName,
			);
			const deleteTree = () => deleteSessionTree(this.store, storageKey);
			await (this.submissionStore?.deleteSession(storageKey, deleteTree) ?? deleteTree());
		});
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
		const storageKey = createSessionStorageKey(
			this.instanceId,
			this.scopeName ? `${this.name}:${this.scopeName}` : this.name,
			sessionName,
		);
		// `metadata` is application-owned; the parent→child relationship is
		// carried by the parent's typed `childSessions` field, and task/parent
		// correlation flows through event decoration below.
		const data = createEmptySessionData();
		const eventCallback: FlueEventInputCallback | undefined = this.eventCallback
			? (event, observation) => {
					const agentName = event.agentName ?? taskAgent?.name;
					this.eventCallback?.({
						...event,
						harness: event.harness ?? this.name,
						...(agentName ? { agentName } : {}),
						parentSession: event.parentSession ?? options.parentSession,
						taskId: event.taskId ?? options.taskId,
					}, observation);
				}
			: undefined;

		return new Session({
			name: sessionName,
			storageKey,
			conversationId: data.conversationId,
			affinityKey: data.affinityKey,
			config: taskConfig,
			env: taskEnv,
			store: this.store,
			existingData: data,
			onAgentEvent: eventCallback,
			agentTools: taskAgent ? (taskAgent.tools ?? []) : this.agentTools,
			toolFactory: this.toolFactory,
			delegationDepth: options.depth,
			createTaskSession: (childOptions) => this.createTaskSession(childOptions),
			actions: taskConfig.actions ?? [],
			createActionHarness: (actionOptions) => this.createActionHarness(actionOptions),
			scopeSignal: this.scopeAbortController.signal,
			executionContext: {
				...this.executionContext,
				harness: this.name,
				taskId: options.taskId,
				...(taskAgent?.name ? { agentName: taskAgent.name } : {}),
			},
		});
	}

	private createActionHarness: import('./session.ts').CreateActionHarness = (options) => {
		const scope = createActionScopeName(options.invocationId);
		const nestedScope = this.scopeName ? `${this.scopeName}:${scope}` : scope;
		const harness = new Harness(
			this.instanceId,
			this.name,
			options.config,
			options.env,
			this.store,
			options.eventCallback ?? this.eventCallback,
			options.tools,
			this.toolFactory,
			this.submissionStore,
			options.actions,
			options.executionContext,
			nestedScope,
			options.depth,
			(session) => options.retainSession(session),
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

function createEmptySessionData(): SessionData {
	const now = new Date().toISOString();
	return {
		version: 8,
		conversationId: generateConversationId(),
		affinityKey: generateSessionAffinityKey(),
		entries: [],
		leafId: null,
		childSessions: [],
		metadata: {},
		createdAt: now,
		updatedAt: now,
	};
}
