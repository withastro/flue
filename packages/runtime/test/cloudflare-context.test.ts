import { describe, expect, it, vi } from 'vite-plus/test';
import { cfSandboxToSessionEnv } from '../src/cloudflare/cf-sandbox.ts';
import {
	getCloudflareContext,
	getDurableObjectIdentity,
	runWithCloudflareContext,
} from '../src/cloudflare/context.ts';

describe('Cloudflare context', () => {
	it('returns request-scoped Cloudflare primitives when code runs inside a Cloudflare context', () => {
		const context = {
			env: { SECRET: 'request-scoped' },
			agentInstance: { state: { sessions: {} }, setState: vi.fn() },
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
			agentInstance: { state: {}, setState: vi.fn() },
			storage: { sql: { request: 'first' } },
		};
		const secondContext = {
			env: { request: 'second' },
			agentInstance: { state: {}, setState: vi.fn() },
			storage: { sql: { request: 'second' } },
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
			'[flue:cloudflare] Not running in a Cloudflare context. This function can only be called inside a Cloudflare Worker or Durable Object.',
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
			agentInstance: { state: {}, setState: vi.fn() },
			storage: { sql: {} },
			durableObjectIdentity,
		};

		const result = runWithCloudflareContext(context, () => getDurableObjectIdentity());

		expect(result).toBe(durableObjectIdentity);
	});

	it('rejects Durable Object identity access when the current context omits identity', () => {
		const context = {
			env: {},
			agentInstance: { state: {}, setState: vi.fn() },
			storage: { sql: {} },
		};

		expect(() => runWithCloudflareContext(context, () => getDurableObjectIdentity())).toThrow(
			'[flue:cloudflare] Durable Object identity is not available in this Cloudflare context.',
		);
	});
});

describe('cfSandboxToSessionEnv()', () => {
	it('preserves text content when wrapped Cloudflare sandbox files are read and written', async () => {
		const readFile = vi.fn(async () => ({ content: 'hello from Cloudflare' }));
		const writeFile = vi.fn(async () => {});
		const sandbox = { readFile, writeFile };
		const env = await cfSandboxToSessionEnv(sandbox, '/workspace/project');

		await expect(env.readFile('notes.txt')).resolves.toBe('hello from Cloudflare');
		await env.writeFile('output.txt', 'written as text');

		expect(readFile).toHaveBeenCalledWith('/workspace/project/notes.txt');
		expect(writeFile).toHaveBeenCalledWith('/workspace/project/output.txt', 'written as text');
	});

	it('preserves binary bytes when wrapped Cloudflare sandbox files are read and written through base64 encoding', async () => {
		const readFile = vi.fn(async () => ({ content: 'AP+AQQ==' }));
		const writeFile = vi.fn(async () => {});
		const sandbox = { readFile, writeFile };
		const env = await cfSandboxToSessionEnv(sandbox, '/workspace/project');

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

	it('forwards command cwd and env and converts timeout seconds to milliseconds when a wrapped command executes', async () => {
		const exec = vi.fn(async () => ({ stdout: 'done', stderr: 'warning', exitCode: 3 }));
		const env = await cfSandboxToSessionEnv({ exec }, '/workspace/project');

		await expect(
			env.exec('pnpm test', {
				cwd: '/workspace/check',
				env: { NODE_ENV: 'test' },
				timeout: 12,
			}),
		).resolves.toEqual({ stdout: 'done', stderr: 'warning', exitCode: 3 });

		expect(exec).toHaveBeenCalledWith('pnpm test', {
			cwd: '/workspace/check',
			env: { NODE_ENV: 'test' },
			timeout: 12_000,
		});
	});

	it('rejects after execution when a signal-blind Cloudflare sandbox is aborted in flight', async () => {
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
		const env = await cfSandboxToSessionEnv({ exec }, '/workspace/project');
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
