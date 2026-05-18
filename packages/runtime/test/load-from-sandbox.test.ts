import { describe, expect, it } from 'vitest';
import { createFlueContext } from '../src/client.ts';
import { InMemorySessionStore } from '../src/session.ts';
import type { AgentConfig, FileStat, FlueEvent, SessionEnv } from '../src/types.ts';

function createEnv(options: { files?: Record<string, string>; dirs?: Record<string, string[]> }): SessionEnv {
	const files = new Map(Object.entries(options.files ?? {}));
	const dirs = new Map(Object.entries(options.dirs ?? {}));
	return {
		cwd: '/repo',
		resolvePath: (path) => (path.startsWith('/') ? path : `/repo/${path}`),
		exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
		readFile: async (path) => files.get(path) ?? '',
		readFileBuffer: async (path) => new TextEncoder().encode(files.get(path) ?? ''),
		writeFile: async () => {},
		stat: async (path): Promise<FileStat> => ({
			isFile: files.has(path),
			isDirectory: dirs.has(path),
			isSymbolicLink: false,
			size: files.get(path)?.length ?? 0,
			mtime: new Date(0),
		}),
		readdir: async (path) => dirs.get(path) ?? [],
		exists: async (path) => files.has(path) || dirs.has(path),
		mkdir: async () => {},
		rm: async () => {},
	};
}

function createContext(env: SessionEnv) {
	return createFlueContext({
		actionName: 'hello',
		id: 'agent',
		runId: 'run',
		payload: {},
		env: {},
		agentConfig: {
			systemPrompt: '',
			skills: {},
			sandboxSkills: {},
			sandboxSkillDiscoveryHint: false,
			subagents: {},
			model: undefined,
			resolveModel: () => undefined,
		},
		createDefaultEnv: async () => env,
		defaultStore: new InMemorySessionStore(),
		resolveSandbox: async () => env,
	});
}

const files = {
	'/repo/AGENTS.md': 'Repository context.',
	'/repo/.agents/skills/review/SKILL.md': '---\nname: review\ndescription: Review work.\n---\nReview.',
};
const dirs = {
	'/repo/.agents/skills': ['review'],
	'/repo/.agents/skills/review': ['SKILL.md'],
};

describe('init loadFromSandbox', () => {
	it('loads context and skills into the harness', async () => {
		const ctx = createContext(createEnv({ files, dirs }));
		const harness = await ctx.init({
			sandbox: {} as never,
			loadFromSandbox: true,
			context: 'Invocation context.',
			model: false,
		});
		const config = (harness as unknown as { config: AgentConfig }).config;
		expect(config.skills.review?.name).toBe('review');
		expect(config.sandboxSkills.review?.name).toBe('review');
		expect(config.systemPrompt).toContain('Repository context.\n\nInvocation context.');
	});

	it.each([
		undefined,
		{ context: '/repo/AGENTS.md' },
	])('warns when conventional sandbox skills exist without skill discovery: %j', async (loadFromSandbox) => {
		const events: FlueEvent[] = [];
		const ctx = createContext(createEnv({ files, dirs }));
		ctx.subscribeEvent((event) => {
			events.push(event);
		});
		await ctx.init({ sandbox: {} as never, loadFromSandbox, model: false });
		expect(events).toContainEqual(
			expect.objectContaining({ type: 'log', level: 'warn', message: expect.stringContaining('loadFromSandbox') }),
		);
	});
});
