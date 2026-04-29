import { Session } from './session.ts';
import { createScopedEnv, mergeCommands } from './env-utils.ts';
import type {
	AgentConfig,
	Command,
	FlueAgent,
	FlueSessions,
	FlueSession,
	FlueEventCallback,
	SessionData,
	SessionEnv,
	SessionStore,
	ShellOptions,
	ShellResult,
} from './types.ts';

const DEFAULT_SESSION_ID = 'default';

type OpenMode = 'get-or-create' | 'get' | 'create';

export class AgentClient implements FlueAgent {
	readonly sessions: FlueSessions = {
		get: (id?: string) => this.openSession(id, 'get'),
		create: (id?: string) => this.openSession(id, 'create'),
		delete: (id?: string) => this.deleteSession(id),
	};

	private openSessions = new Map<string, Session>();
	private destroyed = false;

	constructor(
		readonly id: string,
		private config: AgentConfig,
		private env: SessionEnv,
		private store: SessionStore,
		private eventCallback?: FlueEventCallback,
		private agentCommands: Command[] = [],
	) {}

	async session(id?: string): Promise<FlueSession> {
		return this.openSession(id, 'get-or-create');
	}

	async shell(command: string, options?: ShellOptions): Promise<ShellResult> {
		this.assertActive();
		const effectiveCommands = mergeCommands(this.agentCommands, options?.commands);
		const env = await createScopedEnv(this.env, effectiveCommands);
		const result = await env.exec(command, {
			env: options?.env,
			cwd: options?.cwd,
		});
		return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
	}

	async destroy(): Promise<void> {
		if (this.destroyed) return;
		this.destroyed = true;
		for (const session of Array.from(this.openSessions.values())) {
			session.close();
		}
		this.openSessions.clear();
		await this.env.cleanup();
	}

	private async openSession(id: string | undefined, mode: OpenMode): Promise<FlueSession> {
		this.assertActive();
		const sessionId = normalizeSessionId(id);
		const open = this.openSessions.get(sessionId);
		if (open) {
			if (mode === 'create') {
				throw new Error(`[flue] Session "${sessionId}" already exists for agent "${this.id}".`);
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

		const session = new Session(
			sessionId,
			storageKey,
			this.config,
			this.env,
			this.store,
			data,
			this.eventCallback,
			this.agentCommands,
			() => this.openSessions.delete(sessionId),
		);
		this.openSessions.set(sessionId, session);
		return session;
	}

	private async deleteSession(id: string | undefined): Promise<void> {
		this.assertActive();
		const sessionId = normalizeSessionId(id);
		const open = this.openSessions.get(sessionId);
		if (open) {
			await open.delete();
			return;
		}
		await this.store.delete(createSessionStorageKey(this.id, sessionId));
	}

	private assertActive(): void {
		if (this.destroyed) {
			throw new Error(`[flue] Agent "${this.id}" has been destroyed.`);
		}
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
