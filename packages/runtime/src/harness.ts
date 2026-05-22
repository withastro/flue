import { createCallHandle } from './abort.ts';
import { discoverSessionContext } from './context.ts';
import { createCwdSessionEnv, createFlueFs } from './sandbox.ts';
import { type CreateTaskSessionOptions, deleteSessionTree, Session } from './session.ts';
import type {
	AgentConfig,
	AgentProfile,
	CallHandle,
	FlueEventCallback,
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

	constructor(
		private instanceId: string,
		readonly name: string,
		private config: AgentConfig,
		private env: SessionEnv,
		private store: SessionStore,
		private eventCallback?: FlueEventCallback,
		private agentTools: ToolDefinition[] = [],
		private toolFactory?: SessionToolFactory,
	) {
		this.fs = createFlueFs(env);
	}

	async session(name?: string): Promise<FlueSession> {
		return this.openSession(name, 'get-or-create');
	}

	shell(command: string, options?: ShellOptions): CallHandle<ShellResult> {
		return createCallHandle(options?.signal, async (signal) => {
			const result = await this.env.exec(command, {
				env: options?.env,
				cwd: options?.cwd,
				signal,
			});
			return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
		});
	}

	private async openSession(name: string | undefined, mode: OpenMode): Promise<FlueSession> {
		const sessionName = normalizeSessionName(name);
		const open = this.openSessions.get(sessionName);
		if (open) {
			if (mode === 'create') {
				throw new Error(`[flue] Session "${sessionName}" already exists in harness "${this.name}".`);
			}
			return open;
		}

		const storageKey = createSessionStorageKey(this.instanceId, this.name, sessionName);
		const affinityKey = createSessionAffinityKey(this.instanceId, this.name, sessionName);
		const existingData = await this.store.load(storageKey);
		if (mode === 'get' && !existingData) {
			throw new Error(`[flue] Session "${sessionName}" does not exist in harness "${this.name}".`);
		}
		if (mode === 'create' && existingData) {
			throw new Error(`[flue] Session "${sessionName}" already exists in harness "${this.name}".`);
		}

		let data = existingData;
		if (!data && mode !== 'get') {
			data = createEmptySessionData();
			await this.store.save(storageKey, data);
		}

		const session = new Session({
			name: sessionName,
			storageKey,
			affinityKey,
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
		});
		this.openSessions.set(sessionName, session);
		return session;
	}

	private async deleteSession(name: string | undefined): Promise<void> {
		const sessionName = normalizeSessionName(name);
		const open = this.openSessions.get(sessionName);
		if (open) {
			await open.delete();
			return;
		}
		await deleteSessionTree(this.store, createSessionStorageKey(this.instanceId, this.name, sessionName));
	}

	private async createTaskSession(options: CreateTaskSessionOptions): Promise<Session> {
		const sessionName = `task:${options.parentSession}:${options.taskId}`;
		const taskEnv = options.cwd
			? createCwdSessionEnv(options.parentEnv, options.parentEnv.resolvePath(options.cwd))
			: options.parentEnv;
		const taskAgent = options.agent;
		const localContext = await discoverSessionContext(
			taskEnv,
			taskAgent?.instructions ?? this.config.instructions,
			taskAgent?.skills ?? this.config.definitionSkills,
		);
		const taskConfig: AgentConfig = {
			...this.config,
			systemPrompt: localContext.systemPrompt,
			instructions: taskAgent?.instructions ?? this.config.instructions,
			definitionSkills: taskAgent?.skills ?? this.config.definitionSkills,
			skills: localContext.skills,
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
		const storageKey = createSessionStorageKey(this.instanceId, this.name, sessionName);
		const affinityKey = createSessionAffinityKey(this.instanceId, this.name, sessionName);
		const data = createEmptySessionData();
		data.metadata = {
			parentSession: options.parentSession,
			taskId: options.taskId,
			cwd: taskEnv.cwd,
			agent: taskAgent?.name,
			depth: options.depth,
		};
		await this.store.save(storageKey, data);

		const eventCallback: FlueEventCallback | undefined = this.eventCallback
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
			affinityKey,
			config: taskConfig,
			env: taskEnv,
			store: this.store,
			existingData: data,
			onAgentEvent: eventCallback,
			agentTools: taskAgent?.tools ?? this.agentTools,
			toolFactory: this.toolFactory,
			taskDepth: options.depth,
			createTaskSession: (childOptions) => this.createTaskSession(childOptions),
		});
	}

	private decorateEventCallback(callback: FlueEventCallback | undefined): FlueEventCallback | undefined {
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

function createSessionStorageKey(instanceId: string, harness: string, sessionName: string): string {
	return `agent-session:${JSON.stringify([instanceId, harness, sessionName])}`;
}

function createSessionAffinityKey(instanceId: string, harness: string, sessionName: string): string {
	return `${instanceId}::${harness}::${sessionName}`;
}

function createEmptySessionData(): SessionData {
	const now = new Date().toISOString();
	return {
		version: 3,
		entries: [],
		leafId: null,
		metadata: {},
		createdAt: now,
		updatedAt: now,
	};
}
