import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { cloudflare } from '@cloudflare/vite-plugin';
import { createBuilder, createServer } from 'vite';
import { describe, expect, it } from 'vitest';
import { ViteCloudflarePlugin } from '../../cli/src/lib/build-plugin-cloudflare.ts';
import { build } from '../../cli/src/lib/build.ts';
import { viteSkillReferencePlugin } from '../../cli/src/lib/vite-skill-reference-plugin.ts';

describe('Cloudflare Vite generated Worker prototype', () => {
	it('builds a generated Worker entry with Durable Objects and imported skills through the official plugin', async () => {
		const { root, output } = await createGeneratedFixture();
		const generatedConfig = path.join(output, 'wrangler.jsonc');
		const config = JSON.parse(fs.readFileSync(generatedConfig, 'utf8')) as { main?: string; durable_objects?: { bindings?: Array<{ class_name: string }> } };
		expect(config.main).toBe('_entry.ts');
		expect(config.durable_objects?.bindings?.map((binding) => binding.class_name)).toEqual(expect.arrayContaining(['Assistant', 'SmokeWorkflow', 'FlueRegistry']));

		const builder = await createBuilder({
			configFile: false,
			root,
			logLevel: 'silent',
			plugins: [viteSkillReferencePlugin(), ...cloudflare({ configPath: generatedConfig, persistState: false, inspectorPort: false })],
			build: { outDir: path.join(root, 'vite-dist'), emptyOutDir: true },
		});
		await builder.buildApp();
		expect(fs.existsSync(path.join(root, 'vite-dist'))).toBe(true);
	}, 90000);

	it('serves a deterministic generated workflow through workerd in Vite development', async () => {
		const { root, output } = await createGeneratedFixture();
		const server = await createServer({
			configFile: false,
			root,
			logLevel: 'silent',
			plugins: [viteSkillReferencePlugin(), ...cloudflare({ configPath: path.join(output, 'wrangler.jsonc'), persistState: false, inspectorPort: false })],
			server: { host: '127.0.0.1', port: 0 },
		});
		try {
			await server.listen();
			const localUrl = server.resolvedUrls?.local[0];
			if (!localUrl) throw new Error('Vite server URL unavailable');
			const response = await fetch(new URL('/workflows/smoke?wait=result', localUrl), { method: 'POST' });
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({
				result: {
					ok: true,
					reference: { __flueSkillReference: true, name: 'review', description: 'Reviews requested work.' },
					hasBody: false,
					hasFiles: false,
				},
			});
		} finally {
			await server.close();
		}
	}, 90000);
});

async function createGeneratedFixture(): Promise<{ root: string; output: string }> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flue-vite-cloudflare-'));
	const output = path.join(root, 'generated');
	fs.mkdirSync(path.join(root, 'node_modules', '@flue'), { recursive: true });
	fs.symlinkSync(process.cwd(), path.join(root, 'node_modules', '@flue', 'runtime'), 'dir');
	fs.symlinkSync(
		path.resolve(process.cwd(), '../../examples/cloudflare-websocket/node_modules/agents'),
		path.join(root, 'node_modules', 'agents'),
		'dir',
	);
	fs.symlinkSync(path.resolve(process.cwd(), 'node_modules/just-bash'), path.join(root, 'node_modules', 'just-bash'), 'dir');
	fs.mkdirSync(path.join(root, 'agents'));
	fs.mkdirSync(path.join(root, 'workflows'));
	fs.mkdirSync(path.join(root, 'skills', 'review'), { recursive: true });
	fs.writeFileSync(path.join(root, 'wrangler.jsonc'), JSON.stringify({ name: 'vite-cloudflare-spike', compatibility_date: '2026-04-01', compatibility_flags: ['nodejs_compat'] }));
	fs.writeFileSync(path.join(root, 'skills', 'review', 'SKILL.md'), `---\nname: review\ndescription: Reviews requested work.\n---\nReview it.\n`);
	fs.writeFileSync(path.join(root, 'skills', 'review', 'LICENSE.txt'), 'License terms.\n');
	fs.writeFileSync(path.join(root, 'agents', 'assistant.ts'), `import { createAgent } from '@flue/runtime';\nimport review from '../skills/review/SKILL.md' with { type: 'skill' };\nexport default createAgent(() => ({ model: false, skills: [review] }));\n`);
	fs.writeFileSync(path.join(root, 'workflows', 'smoke.ts'), `import { http } from '@flue/runtime';\nimport review from '../skills/review/SKILL.md' with { type: 'skill' };\nexport const channels = [http()];\nexport async function run() { return { ok: true, reference: review, hasBody: 'body' in review, hasFiles: 'files' in review }; }\n`);
	await build({ root, output, plugin: new ViteCloudflarePlugin() });
	return { root, output };
}
