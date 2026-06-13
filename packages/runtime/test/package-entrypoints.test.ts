import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it, vi } from 'vitest';

// Node-based export-map smoke tests cannot load the Cloudflare virtual module
// pulled in by @flue/runtime/cloudflare/internal (the FlueRegistry Durable
// Object); real Cloudflare runtime behavior is covered by explicit boundary
// and integration suites.
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
			connectMcpServer: expect.any(Function),
			createAgent: expect.any(Function),
			createSandboxSessionEnv: expect.any(Function),
			defineAgentProfile: expect.any(Function),
			defineTool: expect.any(Function),
			dispatch: expect.any(Function),
			getRun: expect.any(Function),
			listAgents: expect.any(Function),
			listRuns: expect.any(Function),
			observe: expect.any(Function),
			registerApiProvider: expect.any(Function),
			registerProvider: expect.any(Function),
		});
		expect(runtime).not.toHaveProperty('Type');
		expect(runtime).not.toHaveProperty('resetFlueRuntimeForTests');
		expect(runtime).not.toHaveProperty('resetProvidersForTests');
	});

	it('exposes flue() when a consumer imports @flue/runtime/routing', async () => {
		const routing = await import('@flue/runtime/routing');

		expect(routing.flue).toEqual(expect.any(Function));
		expect(routing).not.toHaveProperty('admin');
	});

	it('exposes the portable tool authoring API from @flue/runtime/tool', async () => {
		const tool = await import('@flue/runtime/tool');

		expect(tool).toMatchObject({
			defineTool: expect.any(Function),
		});
		expect(tool).not.toHaveProperty('normalizeToolDefinition');
	});

	it('keeps tool declarations isolated when a consumer imports @flue/runtime/tool', () => {
		const declaration = readFileSync('dist/tool-entrypoint.d.mts', 'utf8');

		expect(declaration).not.toContain('./types-');
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

	it('exposes Cloudflare authoring APIs when a consumer imports @flue/runtime/cloudflare', async () => {
		const cloudflare = await import('@flue/runtime/cloudflare');

		expect(cloudflare).toMatchObject({
			cloudflareSandbox: expect.any(Function),
			extend: expect.any(Function),
			getCloudflareContext: expect.any(Function),
			getDurableObjectIdentity: expect.any(Function),
		});
		expect(cloudflare).not.toHaveProperty('FlueRegistry');
		expect(cloudflare).not.toHaveProperty('cfSandboxToSessionEnv');
		expect(cloudflare).not.toHaveProperty('resolveCloudflareExtension');
	});

	it('exposes generated Worker plumbing when generated code imports @flue/runtime/cloudflare/internal', async () => {
		const internal = await import('@flue/runtime/cloudflare/internal');

		expect(internal).toMatchObject({
			cfSandboxToSessionEnv: expect.any(Function),
			createCloudflareRunIndex: expect.any(Function),
			createCloudflareRunStore: expect.any(Function),
			FlueRegistry: expect.any(Function),
			getCloudflareAIBindingApiProvider: expect.any(Function),
			resolveCloudflareExtension: expect.any(Function),
			runWithCloudflareContext: expect.any(Function),
		});
	});

	it('exposes the adapter contract suites when an adapter author imports @flue/runtime/test-utils', async () => {
		const testUtils = await import('@flue/runtime/test-utils');

		expect(testUtils).toMatchObject({
			defineEventStreamStoreContractTests: expect.any(Function),
			defineRunStoreContractTests: expect.any(Function),
			defineStoreContractTests: expect.any(Function),
		});
	});
});
