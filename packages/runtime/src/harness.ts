import { createCallHandle } from './abort.ts';
import type { AgentSubmissionStore } from './agent-execution-store.ts';
import { discoverSessionContext } from './context.ts';
import { SessionAlreadyExistsError, SessionNotFoundError } from './errors.ts';
import { generateSessionAffinityKey } from './runtime/ids.ts';
import { createCwdSessionEnv, createFlueFs } from './sandbox.ts';
import {
	type CreateTaskSessionOptions,
	createPublicSession,
	deleteSessionTree,
	Session,
} from './session.ts';
import {
	assertPublicSessionName,
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
	) {
		this.fs = createFlueFs(env);
	}

	async session(name?: string): Promise<FlueSession> {
		return this.openSession(name, 'get-or-create');
	}

	shell(command: string, options?: ShellOptions): CallHandle<ShellResult> {
		return createCallHandle(options?.signal, (signal) =>
			execShellWithEvents(this.env, (event) => this.emit(event), command, options, signal),
		);
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
		const open = this.openSessions.get(sessionName);
		if (open) {
			if (mode === 'create') {
				throw new SessionAlreadyExistsError({ session: sessionName, harness: this.name });
			}
			return open;
		}

		const storageKey = createSessionStorageKey(this.instanceId, this.name, sessionName);
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
			await this.store.save(storageKey, data);
		}

		const session = new Session({
			name: sessionName,
			storageKey,
			affinityKey: data.affinityKey,
			config: this.config,
			env: this.env,
			store: this.store,
			existingData: data,
			onAgentEvent: this.decorateEventCallback(this.eventCallback),
			agentTools: this.agentTools,
			toolFactory: this.toolFactory,
			taskDepth: 0,
			createTaskSession: (taskOptions) => this.createTaskSession(taskOptions),
			onDelete: () => this.openSessions.delete(sessionName),
			submissionStore: this.submissionStore,
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
			const storageKey = createSessionStorageKey(this.instanceId, this.name, sessionName);
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
		// omitted means none, never the parent's. builtInTools also uses the
		// profile's own selection; omitted preserves the framework default set.
		// Environment fields (model, thinkingLevel, compaction) inherit from
		// the parent as runtime defaults. Agent-less tasks reuse the parent's full config.
		const instructions = taskAgent ? taskAgent.instructions : this.config.instructions;
		const definitionSkills = taskAgent ? taskAgent.skills : this.config.definitionSkills;
		const localContext = await discoverSessionContext(taskEnv, instructions, definitionSkills);
		const taskConfig: AgentConfig = {
			...this.config,
			systemPrompt: localContext.systemPrompt,
			instructions,
			definitionSkills,
			skills: localContext.skills,
			subagents: taskAgent
				? Object.fromEntries(
						(taskAgent.subagents ?? [])
							.filter((agent): agent is AgentProfile & { name: string } => agent.name !== undefined)
							.map((agent) => [agent.name, agent]),
					)
				: this.config.subagents,
			builtInTools: taskAgent ? taskAgent.builtInTools : this.config.builtInTools,
			model:
				taskAgent?.model !== undefined
					? this.config.resolveModel(taskAgent.model)
					: this.config.model,
			thinkingLevel: taskAgent?.thinkingLevel ?? this.config.thinkingLevel,
			compaction: taskAgent?.compaction ?? this.config.compaction,
		};
		const storageKey = createSessionStorageKey(this.instanceId, this.name, sessionName);
		// `metadata` is application-owned; the parent→child relationship is
		// carried by the parent's typed `taskSessions` field, and task/parent
		// correlation flows through event decoration below.
		const data = createEmptySessionData();
		const eventCallback: FlueEventInputCallback | undefined = this.eventCallback
			? (event) => {
					this.eventCallback?.({
						...event,
						harness: event.harness ?? this.name,
						parentSession: event.parentSession ?? options.parentSession,
						taskId: event.taskId ?? options.taskId,
					});
				}
			: undefined;

		return new Session({
			name: sessionName,
			storageKey,
			affinityKey: data.affinityKey,
			config: taskConfig,
			env: taskEnv,
			store: this.store,
			existingData: data,
			onAgentEvent: eventCallback,
			agentTools: taskAgent ? (taskAgent.tools ?? []) : this.agentTools,
			toolFactory: this.toolFactory,
			taskDepth: options.depth,
			createTaskSession: (childOptions) => this.createTaskSession(childOptions),
		});
	}

	private emit(event: FlueEventInput): void {
		this.eventCallback?.({ ...event, harness: event.harness ?? this.name });
	}

	private decorateEventCallback(
		callback: FlueEventInputCallback | undefined,
	): FlueEventInputCallback | undefined {
		return callback
			? (event) => {
					callback({ ...event, harness: event.harness ?? this.name });
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
		version: 6,
		affinityKey: generateSessionAffinityKey(),
		entries: [],
		leafId: null,
		taskSessions: [],
		metadata: {},
		createdAt: now,
		updatedAt: now,
	};
}
