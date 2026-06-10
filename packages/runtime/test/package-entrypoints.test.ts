import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { beforeAll, describe, expect, it, vi } from 'vite-plus/test';

// Node-based export-map smoke tests cannot load the Cloudflare virtual module; real Cloudflare runtime behavior is covered by explicit boundary and integration suites.
vi.mock('cloudflare:workers', () => ({
	DurableObject: class {},
}));

beforeAll(() => {
	if (!existsSync('dist/internal.mjs')) {
		execFileSync('pnpm', ['run', 'build'], { cwd: process.cwd(), stdio: 'pipe' });
	}
});

describe('package entrypoints', () => {
	it('exposes core authoring APIs when a consumer imports @flue/runtime', async () => {
		const runtime = await import('@flue/runtime');

		expect(runtime).toMatchObject({
			configureProvider: expect.any(Function),
			connectMcpServer: expect.any(Function),
			createAgent: expect.any(Function),
			createSandboxSessionEnv: expect.any(Function),
			defineAgentProfile: expect.any(Function),
			defineTool: expect.any(Function),
			dispatch: expect.any(Function),
			observe: expect.any(Function),
			registerApiProvider: expect.any(Function),
			registerProvider: expect.any(Function),
			Type: expect.objectContaining({ Object: expect.any(Function) }),
		});
		expect(runtime).not.toHaveProperty('resetFlueRuntimeForTests');
		expect(runtime).not.toHaveProperty('resetProvidersForTests');
	});

	it('exposes flue() and admin() when a consumer imports @flue/runtime/routing', async () => {
		const routing = await import('@flue/runtime/routing');

		expect(routing.flue).toEqual(expect.any(Function));
		expect(routing.admin).toEqual(expect.any(Function));
	});

	it('exposes generated-runtime APIs when generated code imports @flue/runtime/internal', async () => {
		const internal = await import('@flue/runtime/internal');

		expect(internal).toMatchObject({
			configureFlueRuntime: expect.any(Function),
			createDefaultFlueApp: expect.any(Function),
			resolveModel: expect.any(Function),
		});
	});

	it('exposes local() when a consumer imports @flue/runtime/node', async () => {
		const node = await import('@flue/runtime/node');

		expect(node.local).toEqual(expect.any(Function));
	});

	it('exposes generated Worker adapters when generated code imports @flue/runtime/cloudflare', async () => {
		const cloudflare = await import('@flue/runtime/cloudflare');

		expect(cloudflare).toMatchObject({
			cfSandboxToSessionEnv: expect.any(Function),
			createCloudflareRunRegistry: expect.any(Function),
			extend: expect.any(Function),
			FlueRegistry: expect.any(Function),
			getCloudflareAIBindingApiProvider: expect.any(Function),
			runWithCloudflareContext: expect.any(Function),
		});
	});
});
