import { describe, expect, it } from 'vitest';
import { InMemorySessionStore, Session } from '../src/session.ts';
import type { AgentConfig, FileStat, FlueEvent, SessionEnv } from '../src/types.ts';

describe('Session task tool', () => {
	it('can run while the parent prompt operation is active', async () => {
		const events: FlueEvent[] = [];
		let childPrompt = '';
		const session = new Session({
			name: 'default',
			storageKey: 'session',
			affinityKey: 'affinity',
			config: createConfig(),
			env: createEnv(),
			store: new InMemorySessionStore(),
			existingData: null,
			onAgentEvent: (event) => {
				events.push(event);
			},
			createTaskSession: async (options) =>
				({
					name: `task:${options.taskId}`,
					storageKey: `task-storage:${options.taskId}`,
					prompt: async (text: string) => {
						childPrompt = text;
						return { text: `child saw ${text}` };
					},
					getAssistantText: () => 'child fallback',
					getLatestAssistantMessageId: () => 'message-1',
					close: () => {},
					abort: () => {},
				}) as unknown as Session,
		});

		(session as unknown as { activeOperation: string }).activeOperation = 'prompt';

		const result = await (
			session as unknown as {
				runTaskForTool: (
					params: { prompt: string },
					tools: [],
					role: undefined,
					model: undefined,
					thinkingLevel: undefined,
				) => Promise<{ content: Array<{ text: string }> }>;
			}
		).runTaskForTool({ prompt: 'inspect the diff' }, [], undefined, undefined, undefined);

		expect(childPrompt).toBe('inspect the diff');
		expect(result.content[0]?.text).toBe('child saw inspect the diff');
		expect(events.map((event) => event.type)).toContain('task_start');
		expect(events.map((event) => event.type)).toContain('task');
	});
});

function createConfig(): AgentConfig {
	return {
		systemPrompt: '',
		skills: {},
		roles: {},
		model: undefined,
		resolveModel: () => undefined,
	};
}

function createEnv(): SessionEnv {
	const stat: FileStat = {
		isFile: true,
		isDirectory: false,
		isSymbolicLink: false,
		size: 0,
		mtime: new Date(0),
	};
	return {
		cwd: '/workspace',
		resolvePath: (path) => (path.startsWith('/') ? path : `/workspace/${path}`),
		exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
		readFile: async () => '',
		readFileBuffer: async () => new Uint8Array(),
		writeFile: async () => {},
		stat: async () => stat,
		readdir: async () => [],
		exists: async () => true,
		mkdir: async () => {},
		rm: async () => {},
	};
}
