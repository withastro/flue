import { describe, expect, it, vi } from 'vitest';
import { bash, createSandboxSessionEnv, type SandboxApi } from '../src/index.ts';
import { bashFactoryToSessionEnv } from '../src/internal.ts';
import type { BashLike } from '../src/types.ts';

function createSandboxApi(overrides: Partial<SandboxApi> = {}): SandboxApi {
	return {
		readFile: async () => '',
		readFileBuffer: async () => new Uint8Array(),
		writeFile: async () => {},
		stat: async () => ({
			isFile: true,
			isDirectory: false,
			isSymbolicLink: false,
			size: 0,
			mtime: new Date(0),
		}),
		readdir: async () => [],
		exists: async () => false,
		mkdir: async () => {},
		rm: async () => {},
		exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
		...overrides,
	};
}

describe('createSandboxSessionEnv()', () => {
	it('resolves relative filesystem paths against cwd when a SandboxApi is adapted', async () => {
		const readFile = vi.fn(async () => 'notes');
		const readFileBuffer = vi.fn(async () => new Uint8Array([1, 2]));
		const writeFile = vi.fn(async () => {});
		const stat = vi.fn(async () => ({
			isFile: true,
			isDirectory: false,
			isSymbolicLink: false,
			size: 5,
			mtime: new Date(0),
		}));
		const readdir = vi.fn(async () => ['notes.txt']);
		const exists = vi.fn(async () => true);
		const mkdir = vi.fn(async () => {});
		const rm = vi.fn(async () => {});
		const env = createSandboxSessionEnv(
			createSandboxApi({ readFile, readFileBuffer, writeFile, stat, readdir, exists, mkdir, rm }),
			'/workspace/project',
		);

		await expect(env.readFile('./drafts/../notes.txt')).resolves.toBe('notes');
		await expect(env.readFileBuffer('assets/logo.bin')).resolves.toEqual(new Uint8Array([1, 2]));
		await env.writeFile('output/result.txt', 'done');
		await expect(env.stat('output/result.txt')).resolves.toMatchObject({ size: 5 });
		await expect(env.readdir('output')).resolves.toEqual(['notes.txt']);
		await expect(env.exists('output/result.txt')).resolves.toBe(true);
		await env.mkdir('cache/nested', { recursive: true });
		await env.rm('cache', { recursive: true, force: true });

		expect(env.cwd).toBe('/workspace/project');
		expect(env.resolvePath('drafts/../notes.txt')).toBe('/workspace/project/notes.txt');
		expect(readFile).toHaveBeenCalledWith('/workspace/project/notes.txt');
		expect(readFileBuffer).toHaveBeenCalledWith('/workspace/project/assets/logo.bin');
		expect(writeFile).toHaveBeenCalledWith('/workspace/project/output/result.txt', 'done');
		expect(stat).toHaveBeenCalledWith('/workspace/project/output/result.txt');
		expect(readdir).toHaveBeenCalledWith('/workspace/project/output');
		expect(exists).toHaveBeenCalledWith('/workspace/project/output/result.txt');
		expect(mkdir).toHaveBeenCalledWith('/workspace/project/cache/nested', { recursive: true });
		expect(rm).toHaveBeenCalledWith('/workspace/project/cache', { recursive: true, force: true });
	});

	it('preserves absolute filesystem paths when a SandboxApi is adapted', async () => {
		const readFile = vi.fn(async () => 'notes');
		const readFileBuffer = vi.fn(async () => new Uint8Array([1, 2]));
		const writeFile = vi.fn(async () => {});
		const stat = vi.fn(async () => ({
			isFile: true,
			isDirectory: false,
			isSymbolicLink: false,
			size: 5,
			mtime: new Date(0),
		}));
		const readdir = vi.fn(async () => ['notes.txt']);
		const exists = vi.fn(async () => true);
		const mkdir = vi.fn(async () => {});
		const rm = vi.fn(async () => {});
		const env = createSandboxSessionEnv(
			createSandboxApi({ readFile, readFileBuffer, writeFile, stat, readdir, exists, mkdir, rm }),
			'/workspace/project',
		);

		await env.readFile('/shared/notes.txt');
		await env.readFileBuffer('/shared/logo.bin');
		await env.writeFile('/shared/result.txt', 'done');
		await env.stat('/shared/result.txt');
		await env.readdir('/shared');
		await env.exists('/shared/result.txt');
		await env.mkdir('/shared/cache', { recursive: true });
		await env.rm('/shared/cache', { recursive: true, force: true });

		expect(env.resolvePath('/shared/notes.txt')).toBe('/shared/notes.txt');
		expect(readFile).toHaveBeenCalledWith('/shared/notes.txt');
		expect(readFileBuffer).toHaveBeenCalledWith('/shared/logo.bin');
		expect(writeFile).toHaveBeenCalledWith('/shared/result.txt', 'done');
		expect(stat).toHaveBeenCalledWith('/shared/result.txt');
		expect(readdir).toHaveBeenCalledWith('/shared');
		expect(exists).toHaveBeenCalledWith('/shared/result.txt');
		expect(mkdir).toHaveBeenCalledWith('/shared/cache', { recursive: true });
		expect(rm).toHaveBeenCalledWith('/shared/cache', { recursive: true, force: true });
	});

	it('writes without a mkdir round-trip when a filesystem write succeeds directly', async () => {
		const writeFile = vi.fn(async () => {});
		const mkdir = vi.fn(async () => {});
		const env = createSandboxSessionEnv(
			createSandboxApi({ writeFile, mkdir }),
			'/workspace/project',
		);

		await env.writeFile('output/result.txt', 'done');

		expect(writeFile).toHaveBeenCalledTimes(1);
		expect(writeFile).toHaveBeenCalledWith('/workspace/project/output/result.txt', 'done');
		expect(mkdir).not.toHaveBeenCalled();
	});

	it('creates the parent directory and retries once when a filesystem write fails', async () => {
		const writeFile = vi
			.fn(async () => {})
			.mockRejectedValueOnce(new Error('ENOENT: no such file or directory'));
		const mkdir = vi.fn(async () => {});
		const env = createSandboxSessionEnv(
			createSandboxApi({ writeFile, mkdir }),
			'/workspace/project',
		);

		await env.writeFile('output/nested/result.txt', 'done');

		expect(mkdir).toHaveBeenCalledWith('/workspace/project/output/nested', { recursive: true });
		expect(writeFile).toHaveBeenCalledTimes(2);
		expect(writeFile).toHaveBeenNthCalledWith(
			2,
			'/workspace/project/output/nested/result.txt',
			'done',
		);
	});

	it('rejects with the retried write error when a write still fails after parent creation', async () => {
		const writeFile = vi
			.fn<SandboxApi['writeFile']>()
			.mockRejectedValueOnce(new Error('first failure'))
			.mockRejectedValueOnce(new Error('disk quota exceeded'));
		const mkdir = vi.fn(async () => {
			throw new Error('mkdir not supported');
		});
		const env = createSandboxSessionEnv(
			createSandboxApi({ writeFile, mkdir }),
			'/workspace/project',
		);

		await expect(env.writeFile('output/result.txt', 'done')).rejects.toThrow('disk quota exceeded');
		expect(writeFile).toHaveBeenCalledTimes(2);
	});

	it('passes command cwd env timeoutMs and signal when an adapted environment executes a command', async () => {
		const exec = vi.fn(async () => ({ stdout: 'done', stderr: '', exitCode: 0 }));
		const env = createSandboxSessionEnv(createSandboxApi({ exec }), '/workspace/project');
		const controller = new AbortController();

		await expect(
			env.exec('npm test', {
				cwd: '/workspace/check',
				env: { NODE_ENV: 'test' },
				timeoutMs: 12_000,
				signal: controller.signal,
			}),
		).resolves.toEqual({ stdout: 'done', stderr: '', exitCode: 0 });

		expect(exec).toHaveBeenCalledWith('npm test', {
			cwd: '/workspace/check',
			env: { NODE_ENV: 'test' },
			timeoutMs: 12_000,
			signal: controller.signal,
		});
	});

	it('resolves a relative command cwd against the environment cwd when exec receives one', async () => {
		const exec = vi.fn(async () => ({ stdout: 'done', stderr: '', exitCode: 0 }));
		const env = createSandboxSessionEnv(createSandboxApi({ exec }), '/workspace/project');

		await expect(env.exec('ls', { cwd: 'data' })).resolves.toEqual({
			stdout: 'done',
			stderr: '',
			exitCode: 0,
		});

		expect(exec).toHaveBeenCalledWith('ls', {
			cwd: '/workspace/project/data',
			env: undefined,
			timeoutMs: undefined,
			signal: undefined,
		});
	});

	it('defaults command cwd to the environment cwd when exec receives no cwd', async () => {
		const exec = vi.fn(async () => ({ stdout: '/workspace/project', stderr: '', exitCode: 0 }));
		const env = createSandboxSessionEnv(createSandboxApi({ exec }), '/workspace/project');

		await expect(env.exec('pwd')).resolves.toEqual({
			stdout: '/workspace/project',
			stderr: '',
			exitCode: 0,
		});

		expect(exec).toHaveBeenCalledWith('pwd', {
			cwd: '/workspace/project',
			env: undefined,
			timeoutMs: undefined,
			signal: undefined,
		});
	});

	it('rejects before execution when an adapted environment receives an already-aborted signal', async () => {
		const exec = vi.fn(async () => ({ stdout: 'unexpected', stderr: '', exitCode: 0 }));
		const env = createSandboxSessionEnv(createSandboxApi({ exec }), '/workspace/project');
		const controller = new AbortController();
		controller.abort('stop before execution');

		await expect(env.exec('npm test', { signal: controller.signal })).rejects.toMatchObject({
			name: 'AbortError',
			message: 'stop before execution',
		});
		expect(exec).not.toHaveBeenCalled();
	});

	it('rejects after execution when an adapted environment is aborted during a signal-blind command', async () => {
		let markStarted: () => void = () => {};
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		let finishCommand: () => void = () => {};
		const commandFinished = new Promise<void>((resolve) => {
			finishCommand = resolve;
		});
		const exec = vi.fn(async () => {
			markStarted();
			await commandFinished;
			return { stdout: 'finished remotely', stderr: '', exitCode: 0 };
		});
		const env = createSandboxSessionEnv(createSandboxApi({ exec }), '/workspace/project');
		const controller = new AbortController();

		const result = env.exec('npm test', { signal: controller.signal });
		await started;
		controller.abort('stop during execution');
		finishCommand();

		await expect(result).rejects.toMatchObject({
			name: 'AbortError',
			message: 'stop during execution',
		});
		expect(exec).toHaveBeenCalledWith('npm test', {
			cwd: '/workspace/project',
			env: undefined,
			timeoutMs: undefined,
			signal: controller.signal,
		});
	});
});

describe('bash()', () => {
	it('routes exec and filesystem calls through the wrapped Bash runtime when used as a SandboxFactory', async () => {
		const exec = vi.fn(async () => ({ stdout: 'ran', stderr: '', exitCode: 0 }));
		const readFile = vi.fn(async () => 'notes');
		const runtime: BashLike = {
			exec,
			getCwd: () => '/workspace',
			fs: {
				readFile,
				readFileBuffer: async () => new Uint8Array(),
				writeFile: async () => {},
				stat: async () => ({}),
				readdir: async () => [],
				exists: async () => false,
				mkdir: async () => {},
				rm: async () => {},
				resolvePath: (base, path) => `${base}/${path}`,
			},
		};

		const factory = bash(() => runtime);
		const env = await factory.createSessionEnv({ id: 'agent-1' });

		await expect(env.exec('npm test')).resolves.toMatchObject({ stdout: 'ran', exitCode: 0 });
		await expect(env.readFile('notes.txt')).resolves.toBe('notes');
		expect(exec).toHaveBeenCalledWith('npm test', undefined);
		expect(readFile).toHaveBeenCalledWith('/workspace/notes.txt');
	});
});

describe('bashFactoryToSessionEnv()', () => {
	it('rejects before execution when a signal-blind Bash runtime receives an already-aborted signal', async () => {
		const exec = vi.fn(async () => ({ stdout: 'unexpected', stderr: '', exitCode: 0 }));
		const bash: BashLike = {
			exec,
			getCwd: () => '/workspace/project',
			fs: {
				readFile: async () => '',
				readFileBuffer: async () => new Uint8Array(),
				writeFile: async () => {},
				stat: async () => ({}),
				readdir: async () => [],
				exists: async () => false,
				mkdir: async () => {},
				rm: async () => {},
				resolvePath: (base, path) => `${base}/${path}`,
			},
		};
		const env = await bashFactoryToSessionEnv(() => bash);
		const controller = new AbortController();
		controller.abort('stop before execution');

		await expect(env.exec('npm test', { signal: controller.signal })).rejects.toMatchObject({
			name: 'AbortError',
			message: 'stop before execution',
		});
		expect(exec).not.toHaveBeenCalled();
	});
});
