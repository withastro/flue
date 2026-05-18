import { createCallHandle } from './abort.ts';
import { composeAgentSystemPrompt } from './context.ts';
import { createCwdSessionEnv, createFlueFs } from './sandbox.ts';
import { type CreateTaskSessionOptions, deleteSessionTree, Session } from './session.ts';
import type {
	AgentConfig,
	CallHandle,
	FlueEventCallback,
	FlueFs,
	FlueHarness,
	FlueSession,
	FlueSessions,
	SessionData,
	SessionEnv,
	SessionOptions,
	SessionStore,
	SessionToolFactory,
	ShellOptions,
	ShellResult,
	SkillDefinition,
	ToolDef,
} from './types.ts';

const DEFAULT_SESSION_NAME = 'default';

type OpenMode = 'get-or-create' | 'get' | 'create';

export class Harness implements FlueHarness {
	readonly sessions: FlueSessions = {
		get: (name?: string, options?: SessionOptions) => this.openSession(name, 'get', options),
		create: (name?: string, options?: SessionOptions) => this.openSession(name, 'create', options),
		delete: (name?: string) => this.deleteSession(name),
	};

	readonly fs: FlueFs;

	private openSessions = new Map<string, Session>();

	constructor(
		private actionName: string,
		private instanceId: string,
		readonly name: string,
		private config: AgentConfig,
		private env: SessionEnv,
		private store: SessionStore,
		private eventCallback?: FlueEventCallback,
		private agentTools: ToolDef[] = [],
		private toolFactory?: SessionToolFactory,
	) {
		this.fs = createFlueFs(env);
	}

	async session(name?: string, options?: SessionOptions): Promise<FlueSession> {
		return this.openSession(name, 'get-or-create', options);
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

	private async openSession(
		name: string | undefined,
		mode: OpenMode,
		options?: SessionOptions,
	): Promise<FlueSession> {
		if (options && typeof options === 'object' && 'role' in options) {
			throw new Error('[flue] harness.session(..., { role }) is no longer supported because roles have been removed. Define a subagent, include it in `subagents`, and delegate with `session.task("...", { agent: reviewer })` instead.');
		}
		const sessionName = normalizeSessionName(name);
		const open = this.openSessions.get(sessionName);
		if (open) {
			if (mode === 'create') {
				throw new Error(`[flue] Session "${sessionName}" already exists in harness "${this.name}".`);
			}
			return open;
		}

		const storageKey = createSessionStorageKey(this.actionName, this.instanceId, this.name, sessionName);
		const affinityKey = createSessionAffinityKey(this.actionName, this.instanceId, this.name, sessionName);
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
		await deleteSessionTree(this.store, createSessionStorageKey(this.actionName, this.instanceId, this.name, sessionName));
	}

	private async createTaskSession(options: CreateTaskSessionOptions): Promise<Session> {
		const sessionName = `task:${options.parentSession}:${options.taskId}`;
		const taskEnv = options.cwd
			? createCwdSessionEnv(options.parentEnv, options.parentEnv.resolvePath(options.cwd))
			: options.parentEnv;
		const taskAgent = options.agent;
		const taskSkills = taskAgent ? mergeTaskSkills(taskAgent.skills ?? [], this.config.sandboxSkills) : undefined;
		const taskAgentTools = taskAgent ? [...(taskAgent.tools ?? [])] : this.agentTools;
		const taskConfig: AgentConfig = taskAgent
			? {
					...this.config,
					systemPrompt: composeAgentSystemPrompt(taskAgent, {
						context: this.config.workspaceContext,
						skills: Object.values(taskSkills ?? {}),
					}),
					skills: taskSkills ?? {},
					subagents: Object.fromEntries((taskAgent.subagents ?? []).map((agent) => [agent.name, agent])),
					model: taskAgent.model ? this.config.resolveModel(taskAgent.model) : this.config.model,
				}
			: this.config;
		const storageKey = createSessionStorageKey(this.actionName, this.instanceId, this.name, sessionName);
		const affinityKey = createSessionAffinityKey(this.actionName, this.instanceId, this.name, sessionName);
		const data = createEmptySessionData();
		data.metadata = {
			parentSession: options.parentSession,
			taskId: options.taskId,
			cwd: taskEnv.cwd,
			agent: options.agent?.name,
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
			agentTools: taskAgentTools,
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

function mergeTaskSkills(
	declared: readonly SkillDefinition[],
	sandboxSkills: AgentConfig['sandboxSkills'],
): AgentConfig['skills'] {
	const skills = Object.fromEntries(declared.map((skill) => [skill.name, skill]));
	for (const skill of Object.values(sandboxSkills)) {
		if (skills[skill.name]) {
			throw new Error(`[flue] Skill name "${skill.name}" appears on a task agent and in sandbox discovery.`);
		}
		skills[skill.name] = skill;
	}
	return skills;
}

function normalizeSessionName(name: string | undefined): string {
	return name ?? DEFAULT_SESSION_NAME;
}

function createSessionStorageKey(actionName: string, instanceId: string, harness: string, sessionName: string): string {
	return `action-session:${JSON.stringify([actionName, instanceId, harness, sessionName])}`;
}

function createSessionAffinityKey(actionName: string, instanceId: string, harness: string, sessionName: string): string {
	return `${actionName}::${instanceId}::${harness}::${sessionName}`;
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
