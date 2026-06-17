import { describe, expect, it, vi } from 'vitest';
import { type CloudflareSandboxStub, cloudflareSandbox } from '../src/cloudflare/cf-sandbox.ts';
import {
	getCloudflareContext,
	getDurableObjectIdentity,
	runWithCloudflareContext,
} from '../src/cloudflare/context.ts';

describe('Cloudflare context', () => {
	it('returns request-scoped Cloudflare primitives when code runs inside a Cloudflare context', () => {
		const context = {
			env: { SECRET: 'request-scoped' },
			storage: { sql: { exec: vi.fn() } },
		};

		const result = runWithCloudflareContext(context, () => getCloudflareContext());

		expect(result).toBe(context);
	});

	it('isolates interleaved Cloudflare contexts when asynchronous work overlaps', async () => {
		let resumeFirst: () => void = () => {};
		const firstPaused = new Promise<void>((resolve) => {
			resumeFirst = resolve;
		});
		const firstContext = {
			env: { request: 'first' },
			storage: { sql: { exec: vi.fn() } },
		};
		const secondContext = {
			env: { request: 'second' },
			storage: { sql: { exec: vi.fn() } },
		};

		const first = runWithCloudflareContext(firstContext, async () => {
			expect(getCloudflareContext()).toBe(firstContext);
			await firstPaused;
			expect(getCloudflareContext()).toBe(firstContext);
		});
		const second = runWithCloudflareContext(secondContext, async () => {
			expect(getCloudflareContext()).toBe(secondContext);
			resumeFirst();
			await Promise.resolve();
			expect(getCloudflareContext()).toBe(secondContext);
		});

		await Promise.all([first, second]);
	});

	it('rejects context access when code runs outside a Cloudflare context', () => {
		expect(() => getCloudflareContext()).toThrow(
			'[flue] Not running in a Cloudflare context. This function can only be called inside a Cloudflare Worker or Durable Object.',
		);
	});

	it('returns Durable Object identity when the current context supplies identity', () => {
		const durableObjectIdentity = {
			bindingName: 'FLUE_ASSISTANT_AGENT',
			className: 'FlueAssistantAgent',
			name: 'customer-123',
			id: 'durable-object-id',
		};
		const context = {
			env: {},
			storage: { sql: { exec: vi.fn() } },
			durableObjectIdentity,
		};

		const result = runWithCloudflareContext(context, () => getDurableObjectIdentity());

		expect(result).toBe(durableObjectIdentity);
	});

	it('rejects Durable Object identity access when the current context omits identity', () => {
		const context = {
			env: {},
			storage: { sql: { exec: vi.fn() } },
		};

		expect(() => runWithCloudflareContext(context, () => getDurableObjectIdentity())).toThrow(
			'[flue] Durable Object identity is not available in this Cloudflare context.',
		);
	});
});

describe('cloudflareSandbox()', () => {
	it('preserves text content when wrapped Cloudflare sandbox files are read and written', async () => {
		const readFile = vi.fn(async () => ({ content: 'hello from Cloudflare' }));
		const writeFile = vi.fn(async () => {});
		const sandbox = { readFile, writeFile } as unknown as CloudflareSandboxStub;
		const env = await cloudflareSandbox(sandbox, { cwd: '/workspace/project' }).createSessionEnv({
			id: 'agent-1',
		});

		await expect(env.readFile('notes.txt')).resolves.toBe('hello from Cloudflare');
		await env.writeFile('output.txt', 'written as text');

		expect(readFile).toHaveBeenCalledWith('/workspace/project/notes.txt');
		expect(writeFile).toHaveBeenCalledWith('/workspace/project/output.txt', 'written as text');
	});

	it('preserves binary bytes when wrapped Cloudflare sandbox files are read and written through base64 encoding', async () => {
		const readFile = vi.fn(async () => ({ content: 'AP+AQQ==' }));
		const writeFile = vi.fn(async () => {});
		const sandbox = { readFile, writeFile } as unknown as CloudflareSandboxStub;
		const env = await cloudflareSandbox(sandbox, { cwd: '/workspace/project' }).createSessionEnv({
			id: 'agent-1',
		});

		await expect(env.readFileBuffer('artifact.bin')).resolves.toEqual(
			new Uint8Array([0, 255, 128, 65]),
		);
		await env.writeFile('copy.bin', new Uint8Array([0, 255, 128, 65]));

		expect(readFile).toHaveBeenCalledWith('/workspace/project/artifact.bin', {
			encoding: 'base64',
		});
		expect(writeFile).toHaveBeenCalledWith('/workspace/project/copy.bin', 'AP+AQQ==', {
			encoding: 'base64',
		});
	});

	it('forwards cloneable command options when a wrapped command executes', async () => {
		const exec = vi.fn(async () => ({ stdout: 'done', stderr: 'warning', exitCode: 3 }));
		const env = await cloudflareSandbox({ exec } as unknown as CloudflareSandboxStub, {
			cwd: '/workspace/project',
		}).createSessionEnv({ id: 'agent-1' });

		const signal = new AbortController().signal;
		await expect(
			env.exec('pnpm test', {
				cwd: '/workspace/check',
				env: { NODE_ENV: 'test' },
				timeoutMs: 12_000,
				signal,
			}),
		).resolves.toEqual({ stdout: 'done', stderr: 'warning', exitCode: 3 });

		expect(exec).toHaveBeenCalledWith('pnpm test', {
			cwd: '/workspace/check',
			env: { NODE_ENV: 'test' },
			timeout: 12_000,
		});
	});

	it('includes dotfile entries when a wrapped sandbox directory is listed', async () => {
		const exec = vi.fn(async () => ({
			success: true,
			stdout: '.env\0.gitignore\0src\0README.md\0',
			stderr: '',
		}));
		const env = await cloudflareSandbox({ exec } as unknown as CloudflareSandboxStub, {
			cwd: '/workspace/project',
		}).createSessionEnv({ id: 'agent-1' });

		await expect(env.readdir('config')).resolves.toEqual([
			'.env',
			'.gitignore',
			'src',
			'README.md',
		]);

		expect(exec).toHaveBeenCalledWith(
			`find '/workspace/project/config' -mindepth 1 -maxdepth 1 -printf '%f\\0'`,
		);
	});

	it('reports directory metadata of the link target when a wrapped sandbox stats a symlink to a directory', async () => {
		const exec = vi.fn(async () => ({
			success: true,
			stdout: '4096/1718000000/directory\nsymbolic link\n',
			stderr: '',
		}));
		const env = await cloudflareSandbox({ exec } as unknown as CloudflareSandboxStub, {
			cwd: '/workspace/project',
		}).createSessionEnv({ id: 'agent-1' });

		await expect(env.stat('linked-dir')).resolves.toEqual({
			isFile: false,
			isDirectory: true,
			isSymbolicLink: true,
			size: 4096,
			mtime: new Date(1_718_000_000 * 1000),
		});

		expect(exec).toHaveBeenCalledWith(
			`stat -L -c '%s/%Y/%F' '/workspace/project/linked-dir' && stat -c '%F' '/workspace/project/linked-dir'`,
		);
	});

	it('rejects unsupported rm options before mutating the Cloudflare sandbox', async () => {
		const exec = vi.fn(async () => ({ success: true, stdout: '', stderr: '' }));
		const deleteFile = vi.fn(async () => {});
		const env = await cloudflareSandbox({ exec, deleteFile } as unknown as CloudflareSandboxStub, {
			cwd: '/workspace/project',
		}).createSessionEnv({ id: 'agent-1' });

		await expect(env.rm('tmp', { recursive: true, force: true })).rejects.toMatchObject({
			type: 'sandbox_operation_unsupported',
			meta: {
				operation: 'rm',
				provider: 'Cloudflare Sandbox',
				options: ['recursive', 'force'],
			},
		});
		expect(exec).not.toHaveBeenCalled();
		expect(deleteFile).not.toHaveBeenCalled();
	});

	it('deletes a path with the Cloudflare filesystem API when no rm options are requested', async () => {
		const deleteFile = vi.fn(async () => {});
		const env = await cloudflareSandbox({ deleteFile } as unknown as CloudflareSandboxStub, {
			cwd: '/workspace/project',
		}).createSessionEnv({ id: 'agent-1' });

		await env.rm('tmp');

		expect(deleteFile).toHaveBeenCalledWith('/workspace/project/tmp');
	});

	it('keeps cancellation local when a Cloudflare sandbox command is aborted in flight', async () => {
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
			return { success: true, stdout: 'finished remotely', stderr: '' };
		});
		const env = await cloudflareSandbox({ exec } as unknown as CloudflareSandboxStub, {
			cwd: '/workspace/project',
		}).createSessionEnv({ id: 'agent-1' });
		const controller = new AbortController();

		const result = env.exec('pnpm test', { signal: controller.signal });
		await started;
		controller.abort('stop during execution');
		finishCommand();

		await expect(result).rejects.toMatchObject({
			name: 'AbortError',
			message: 'stop during execution',
		});
		expect(exec).toHaveBeenCalledWith('pnpm test', {
			cwd: '/workspace/project',
			env: undefined,
			timeout: undefined,
		});
	});
});
