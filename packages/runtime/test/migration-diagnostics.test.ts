import { describe, expect, it } from 'vitest';
import { createFlueContext } from '../src/client.ts';
import { InMemorySessionStore } from '../src/session.ts';
import type { SessionEnv } from '../src/types.ts';

const env: SessionEnv = {
	cwd: '/',
	resolvePath: (path) => path,
	exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
	readFile: async () => '',
	readFileBuffer: async () => new Uint8Array(),
	writeFile: async () => {},
	stat: async () => ({ isFile: false, isDirectory: false, isSymbolicLink: false, size: 0, mtime: new Date(0) }),
	readdir: async () => [],
	exists: async () => false,
	mkdir: async () => {},
	rm: async () => {},
};

function createContext() {
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
	});
}

describe('migration diagnostics', () => {
	it('explains removed sandbox magic strings', async () => {
		await expect(createContext().init({ sandbox: 'empty' as never, model: false })).rejects.toThrow(
			'init({ sandbox: \'empty\' })',
		);
		await expect(createContext().init({ sandbox: 'local' as never, model: false })).rejects.toThrow(
			'@flue/runtime/node',
		);
	});

	it('explains Bash-like sandbox values that need a factory', async () => {
		await expect(
			createContext().init({
				sandbox: { exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }), getCwd: () => '/', fs: {} } as never,
				model: false,
			}),
		).rejects.toThrow('sandbox: () => new Bash');
	});

	it('rejects empty explicit sandbox discovery paths', async () => {
		await expect(createContext().init({ model: false, loadFromSandbox: { skills: '' } })).rejects.toThrow(
			'loadFromSandbox.skills',
		);
		await expect(createContext().init({ model: false, loadFromSandbox: { context: '' } })).rejects.toThrow(
			'loadFromSandbox.context',
		);
	});
});
