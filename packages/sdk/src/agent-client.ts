import { discoverSessionContext } from './context.ts';
import { createCwdSessionEnv } from './sandbox.ts';
import { deleteSessionTree, Session, type CreateTaskSessionOptions } from './session.ts';
import { createScopedEnv, mergeCommands } from './env-utils.ts';
import { assertRoleExists } from './roles.ts';
import type {
	AgentConfig,
	Command,
	FlueAgent,
	FlueSessions,
	FlueSession,
	FlueEventCallback,
	SessionData,
	SessionEnv,
	SessionOptions,
	SessionStore,
	ShellOptions,
	ShellResult,
	ToolDef,
} from './types.ts';

const DEFAULT_SESSION_ID = 'default';

type OpenMode = 'get-or-create' | 'get' | 'create';

export class AgentClient implements FlueAgent {
	readonly sessions: FlueSessions = {
		get: (id?: string, options?: SessionOptions) => this.openSession(id, 'get', options),
		create: (id?: string, options?: SessionOptions) => this.openSession(id, 'create', options),
		delete: (id?: string) => this.deleteSession(id),
	};

	private openSessions = new Map<string, Session>();

	constructor(
		readonly id: string,
		private config: AgentConfig,
		private env: SessionEnv,
		private store: SessionStore,
		private eventCallback?: FlueEventCallback,
		private agentCommands: Command[] = [],
		private agentTools: ToolDef[] = [],
	) {}

	async session(id?: string, options?: SessionOptions): Promise<FlueSession> {
		return this.openSession(id, 'get-or-create', options);
	}

	async shell(command: string, options?: ShellOptions): Promise<ShellResult> {
		const effectiveCommands = mergeCommands(this.agentCommands, options?.commands);
		const env = await createScopedEnv(this.env, effectiveCommands);
		const result = await env.exec(command, {
			env: options?.env,
			cwd: options?.cwd,
			timeout: options?.timeout,
		});
		return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
	}

	private async openSession(
		id: string | undefined,
		mode: OpenMode,
		options?: SessionOptions,
	): Promise<FlueSession> {
		assertRoleExists(this.config.roles, options?.role);
		const sessionId = normalizeSessionId(id);
		const open = this.openSessions.get(sessionId);
		if (open) {
			if (mode === 'create') {
				throw new Error(`[flue] Session "${sessionId}" already exists for agent "${this.id}".`);
			}
			if (options?.role !== undefined && options.role !== open.role) {
				throw new Error(
					`[flue] Session "${sessionId}" is already open with ` +
						`role ${JSON.stringify(open.role ?? null)}; cannot reopen with role ${JSON.stringify(options.role)}.`,
				);
			}
			return open;
		}

		const storageKey = createSessionStorageKey(this.id, sessionId);
		const existingData = await this.store.load(storageKey);
		if (mode === 'get' && !existingData) {
			throw new Error(`[flue] Session "${sessionId}" does not exist for agent "${this.id}".`);
		}
		if (mode === 'create' && existingData) {
			throw new Error(`[flue] Session "${sessionId}" already exists for agent "${this.id}".`);
		}

		let data = existingData;
		if (!data && mode !== 'get') {
			data = createEmptySessionData();
			await this.store.save(storageKey, data);
		}

		const session = new Session({
			id: sessionId,
			storageKey,
			config: this.config,
			env: this.env,
			store: this.store,
			existingData: data,
			onAgentEvent: this.eventCallback,
			agentCommands: this.agentCommands,
			agentTools: this.agentTools,
			sessionRole: options?.role,
			taskDepth: 0,
			createTaskSession: (taskOptions) => this.createTaskSession(taskOptions),
			onDelete: () => this.openSessions.delete(sessionId),
		});
		this.openSessions.set(sessionId, session);
		return session;
	}

	private async deleteSession(id: string | undefined): Promise<void> {
		const sessionId = normalizeSessionId(id);
		const open = this.openSessions.get(sessionId);
		if (open) {
			await open.delete();
			return;
		}
		await deleteSessionTree(this.store, createSessionStorageKey(this.id, sessionId));
	}

	private async createTaskSession(options: CreateTaskSessionOptions): Promise<Session> {
		assertRoleExists(this.config.roles, options.role);

		const sessionId = `task:${options.parentSessionId}:${options.taskId}`;
		const taskEnv = options.cwd
			? createCwdSessionEnv(options.parentEnv, options.parentEnv.resolvePath(options.cwd))
			: options.parentEnv;
		const localContext = await discoverSessionContext(taskEnv);
		const taskConfig: AgentConfig = {
			...this.config,
			systemPrompt: localContext.systemPrompt,
			skills: localContext.skills,
		};
		const storageKey = createSessionStorageKey(this.id, sessionId);
		const data = createEmptySessionData();
		data.metadata = {
			parentSessionId: options.parentSessionId,
			taskId: options.taskId,
			cwd: taskEnv.cwd,
			role: options.role,
			depth: options.depth,
		};
		await this.store.save(storageKey, data);

		const eventCallback: FlueEventCallback | undefined = this.eventCallback
			? (event) => {
					this.eventCallback?.({
						...event,
						parentSessionId: event.parentSessionId ?? options.parentSessionId,
						taskId: event.taskId ?? options.taskId,
					});
				}
			: undefined;

		return new Session({
			id: sessionId,
			storageKey,
			config: taskConfig,
			env: taskEnv,
			store: this.store,
			existingData: data,
			onAgentEvent: eventCallback,
			agentCommands: options.commands,
			agentTools: this.agentTools,
			sessionRole: options.role,
			taskDepth: options.depth,
			createTaskSession: (childOptions) => this.createTaskSession(childOptions),
		});
	}
}

function normalizeSessionId(id: string | undefined): string {
	return id ?? DEFAULT_SESSION_ID;
}

function createSessionStorageKey(agentId: string, sessionId: string): string {
	return `agent-session:${JSON.stringify([agentId, sessionId])}`;
}

function createEmptySessionData(): SessionData {
	const now = new Date().toISOString();
	return {
		version: 2,
		entries: [],
		leafId: null,
		metadata: {},
		createdAt: now,
		updatedAt: now,
	};
}
