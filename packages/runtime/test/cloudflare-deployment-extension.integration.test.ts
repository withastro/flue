import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import { describe, expect, it } from 'vitest';
import {
	build,
	cloudflareViteConfigPath,
	cloudflareViteInputDir,
	createCloudflareViteConfig,
} from '../../cli/src/lib/build.ts';

describe('Cloudflare deployment extensions', () => {
	it('exports an authored Durable Object and composes non-HTTP Worker handlers', async () => {
		const root = await createGeneratedFixture(
			`import { DurableObject } from 'cloudflare:workers';
export class Counter extends DurableObject {
  async increment() {
    const count = ((await this.ctx.storage.get('count')) ?? 0) + 1;
    await this.ctx.storage.put('count', count);
    return count;
  }
}
export default {
  async scheduled(_controller, env) {
    await env.Counter.getByName('default').increment();
  },
};
`,
		);
		let server: Awaited<ReturnType<typeof startServer>> | undefined;
		try {
			server = await startServer(root);
			const response = await fetch(new URL('/counter', server.url));
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ count: 1 });
			const scheduled = await fetch(new URL('/cdn-cgi/handler/scheduled', server.url));
			expect(scheduled.status).toBe(200);
			expect(await scheduled.text()).toBe('ok');
			const afterScheduled = await fetch(new URL('/counter', server.url));
			expect(afterScheduled.status).toBe(200);
			expect(await afterScheduled.json()).toEqual({ count: 3 });
		} finally {
			await server?.close();
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 90000);

	it('rejects fetch handlers authored in cloudflare.ts', async () => {
		await expectRuntimeFailure(
			`export default { async fetch() { return new Response('wrong'); } };\n`,
			'cloudflare.ts default export must not define fetch. Use app.ts for custom HTTP handling.',
		);
	}, 90000);

	it('rejects invalid cloudflare.ts default exports', async () => {
		const root = await createGeneratedFixture(`export default null;\n`);
		try {
			const entry = fs.readFileSync(path.join(cloudflareViteInputDir(root), '_entry.ts'), 'utf8');
			expect(entry).toContain(
				`throw new Error('[flue] cloudflare.ts default export must be an object containing non-HTTP Worker handlers.');`,
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 90000);

	it('rejects authored exports that conflict with generated Worker exports', async () => {
		await expectRuntimeFailure(
			`export class Assistant {}\n`,
			'cloudflare.ts export "Assistant" conflicts with a Flue-generated Worker export.',
		);
	}, 90000);

	it('does not infer Sandbox exports from Wrangler class names', async () => {
		const root = await createGeneratedFixture(`export const marker = true;\n`, {
			durable_objects: { bindings: [{ name: 'Sandbox', class_name: 'Sandbox' }] },
			migrations: [
				{ tag: 'v1', new_sqlite_classes: ['Assistant', 'FlueRegistry'] },
				{ tag: 'v2', new_sqlite_classes: ['Sandbox'] },
			],
		});
		try {
			const entry = fs.readFileSync(path.join(cloudflareViteInputDir(root), '_entry.ts'), 'utf8');
			expect(entry).not.toContain(`from '@cloudflare/sandbox'`);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 90000);

	it('rejects authored bindings that shadow generated Durable Object bindings', async () => {
		await expect(
			createGeneratedFixture(`export class Counter {}\n`, {
				durable_objects: { bindings: [{ name: 'Assistant', class_name: 'Counter' }] },
			}),
		).rejects.toThrow(
			'wrangler.jsonc durable object binding "Assistant" is reserved by Flue. Expected class_name "Assistant", received "Counter".',
		);
	}, 90000);

	it('does not update generated deployment inputs when Wrangler validation fails', async () => {
		const root = await createGeneratedFixture(`export class Counter {}\n`);
		const entryPath = path.join(cloudflareViteInputDir(root), '_entry.ts');
		const entry = fs.readFileSync(entryPath, 'utf8');
		try {
			fs.writeFileSync(
				path.join(root, 'src', 'agents', 'reviewer.ts'),
				`import { createAgent } from '@flue/runtime';\nexport default createAgent(() => ({ model: false }));\n`,
			);
			fs.writeFileSync(
				path.join(root, 'wrangler.jsonc'),
				JSON.stringify({
					compatibility_date: '2026-04-01',
					compatibility_flags: ['nodejs_compat'],
					durable_objects: { bindings: [{ name: 'Assistant', class_name: 'Counter' }] },
				}),
			);
			await expect(
				build({
					root,
					sourceRoot: path.join(root, 'src'),
					output: path.join(root, 'generated'),
					target: 'cloudflare',
					mode: 'development',
				}),
			).rejects.toThrow('durable object binding "Assistant" is reserved by Flue');
			expect(fs.readFileSync(entryPath, 'utf8')).toBe(entry);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 90000);
});

async function expectRuntimeFailure(cloudflareSource: string, expected: string): Promise<void> {
	const root = await createGeneratedFixture(cloudflareSource);
	try {
		await expect(startServer(root)).rejects.toThrow(expected);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

async function createGeneratedFixture(
	cloudflareSource: string,
	wranglerOverrides: Record<string, unknown> = {},
): Promise<string> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flue-cloudflare-deployment-extension-'));
	const output = path.join(root, 'generated');
	fs.mkdirSync(path.join(root, 'node_modules', '@earendil-works'), { recursive: true });
	fs.mkdirSync(path.join(root, 'node_modules', '@flue'), { recursive: true });
	fs.symlinkSync(
		path.resolve(process.cwd(), 'node_modules', '@earendil-works', 'pi-ai'),
		path.join(root, 'node_modules', '@earendil-works', 'pi-ai'),
		'dir',
	);
	fs.symlinkSync(process.cwd(), path.join(root, 'node_modules', '@flue', 'runtime'), 'dir');
	fs.symlinkSync(
		path.resolve(process.cwd(), '../../examples/cloudflare-websocket/node_modules/agents'),
		path.join(root, 'node_modules', 'agents'),
		'dir',
	);
	fs.mkdirSync(path.join(root, 'src', 'agents'), { recursive: true });
	fs.writeFileSync(
		path.join(root, 'wrangler.jsonc'),
		JSON.stringify({
			name: 'cloudflare-deployment-extension',
			compatibility_date: '2026-04-01',
			compatibility_flags: ['nodejs_compat'],
			durable_objects: { bindings: [{ name: 'Counter', class_name: 'Counter' }] },
			migrations: [
				{ tag: 'v1', new_sqlite_classes: ['Assistant', 'FlueRegistry'] },
				{ tag: 'v2', new_sqlite_classes: ['Counter'] },
			],
			...wranglerOverrides,
		}),
	);
	fs.writeFileSync(
		path.join(root, 'src', 'agents', 'assistant.ts'),
		`import { createAgent } from '@flue/runtime';\nexport default createAgent(() => ({ model: false }));\n`,
	);
	fs.writeFileSync(path.join(root, 'src', 'cloudflare.ts'), cloudflareSource);
	fs.writeFileSync(
		path.join(root, 'src', 'app.ts'),
		`export default {\n  async fetch(_request, env) {\n    const count = await env.Counter.getByName('default').increment();\n    return Response.json({ count });\n  },\n};\n`,
	);
	try {
		await build({
			root,
			sourceRoot: path.join(root, 'src'),
			output,
			target: 'cloudflare',
			mode: 'development',
		});
		return root;
	} catch (error) {
		fs.rmSync(root, { recursive: true, force: true });
		throw error;
	}
}

async function startServer(root: string): Promise<{ url: string; close(): Promise<void> }> {
	const entryPath = path.join(cloudflareViteInputDir(root), '_entry.ts');
	const viteConfig = createCloudflareViteConfig(root, cloudflareViteConfigPath(root), [entryPath], {
		persistState: false,
	});
	const server: ViteDevServer = await createServer({
		...viteConfig,
		logLevel: 'silent',
		server: { host: '127.0.0.1', port: 0 },
	});
	await server.listen();
	const url = server.resolvedUrls?.local[0];
	if (!url) throw new Error('Vite server URL unavailable');
	return { url, close: () => server.close() };
}
