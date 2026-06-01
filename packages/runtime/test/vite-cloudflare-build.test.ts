import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createServer } from 'vite';
import { describe, expect, it } from 'vitest';
import {
	build,
	cloudflareViteConfigPath,
	cloudflareViteInputDir,
	createCloudflareViteConfig,
} from '../../cli/src/lib/build.ts';

const AUTHORED_MIGRATIONS = [
	{
		tag: 'v1',
		new_sqlite_classes: [
			'Assistant',
			'SmokeWorkflow',
			'UseSkillWorkflow',
			'UseNamedSkillWorkflow',
			'FlueRegistry',
		],
	},
];

describe('Cloudflare Vite production Worker', () => {
	it('builds deployable official-plugin output from the production Cloudflare target', async () => {
		const { root, output } = await createGeneratedFixture('build');
		const inputConfig = JSON.parse(fs.readFileSync(cloudflareViteConfigPath(root), 'utf8')) as {
			main?: string;
			migrations?: unknown;
			durable_objects?: { bindings?: Array<{ class_name: string }> };
		};
		expect(inputConfig.main).toBe('.flue-vite/_entry.ts');
		expect(inputConfig.durable_objects?.bindings?.map((binding) => binding.class_name)).toEqual(
			expect.arrayContaining(['Assistant', 'SmokeWorkflow', 'FlueRegistry']),
		);
		expect(inputConfig.migrations).toEqual(AUTHORED_MIGRATIONS);
		const outputConfigs = fs
			.readdirSync(output, { recursive: true })
			.filter((entry) => String(entry).endsWith('wrangler.json'));
		expect(outputConfigs).not.toHaveLength(0);
		const outputConfigPath = path.join(output, String(outputConfigs[0]));
		const outputConfig = JSON.parse(fs.readFileSync(outputConfigPath, 'utf8')) as {
			migrations?: unknown;
		};
		expect(outputConfig.migrations).toEqual(AUTHORED_MIGRATIONS);
		const outputEntry = fs.readFileSync(
			path.join(path.dirname(outputConfigPath), 'index.mjs'),
			'utf8',
		);
		expect(outputEntry).toContain('devMode: false,');
		expect(outputEntry).not.toContain('devMode: true,');
		const emittedJavaScript = fs
			.readdirSync(path.dirname(outputConfigPath), { recursive: true })
			.filter((entry) => /\.[cm]?js$/.test(String(entry)))
			.map((entry) => fs.readFileSync(path.join(path.dirname(outputConfigPath), String(entry)), 'utf8'))
			.join('\n');
		expect(emittedJavaScript).not.toContain('@anthropic-ai/sdk');
		expect(emittedJavaScript).not.toContain('@google/genai');
		expect(emittedJavaScript).not.toContain('@mistralai/mistralai');
		expect(JSON.stringify(outputConfig.migrations)).not.toContain('flue-class-');
		const deployRedirect = JSON.parse(
			fs.readFileSync(path.join(root, '.wrangler', 'deploy', 'config.json'), 'utf8'),
		) as { configPath?: string };
		expect(deployRedirect.configPath).toContain('wrangler.json');
		expect(deployRedirect.configPath).not.toContain('wrangler.jsonc');
	}, 90000);

	it('does not retain Cloudflare environment selection after building', async () => {
		const previous = process.env.CLOUDFLARE_ENV;
		delete process.env.CLOUDFLARE_ENV;
		try {
			await createGeneratedFixture('development');
			expect(process.env.CLOUDFLARE_ENV).toBeUndefined();
		} finally {
			if (previous === undefined) delete process.env.CLOUDFLARE_ENV;
			else process.env.CLOUDFLARE_ENV = previous;
		}
	}, 90000);

	it('preserves the source Worker name when the Vite plugin selects an environment', async () => {
		const previous = process.env.CLOUDFLARE_ENV;
		delete process.env.CLOUDFLARE_ENV;
		const wranglerConfig = {
			name: 'support-seal-flue',
			compatibility_date: '2026-04-01',
			compatibility_flags: ['nodejs_compat'],
			migrations: AUTHORED_MIGRATIONS,
			env: { staging: { name: 'support-seal-flue-staging' } },
		};
		try {
			const production = await createGeneratedFixture('build', {
				wranglerConfig,
				cloudflareEnv: null,
			});
			const productionConfigPath = path.join(
				production.output,
				'support_seal_flue',
				'wrangler.json',
			);
			expect(JSON.parse(fs.readFileSync(productionConfigPath, 'utf8')).name).toBe(
				'support-seal-flue',
			);
			expect(fs.existsSync(path.join(production.output, 'support_seal_flue_staging'))).toBe(false);

			const staging = await createGeneratedFixture('build', {
				wranglerConfig,
				cloudflareEnv: 'staging',
			});
			const inputConfig = JSON.parse(
				fs.readFileSync(cloudflareViteConfigPath(staging.root), 'utf8'),
			) as {
				name: string;
				migrations: unknown;
				env: {
					staging: {
						name: string;
						main: string;
						migrations?: unknown;
						durable_objects: { bindings: Array<{ class_name: string }> };
					};
				};
			};
			expect(inputConfig.name).toBe('support-seal-flue');
			expect(inputConfig.migrations).toEqual(AUTHORED_MIGRATIONS);
			expect(inputConfig.env.staging.name).toBe('support-seal-flue-staging');
			expect(inputConfig.env.staging.main).toBe('.flue-vite/_entry.ts');
			expect(inputConfig.env.staging).not.toHaveProperty('migrations');
			expect(
				inputConfig.env.staging.durable_objects.bindings.map((binding) => binding.class_name),
			).toEqual(expect.arrayContaining(['Assistant', 'SmokeWorkflow', 'FlueRegistry']));
			const stagingConfigPath = path.join(staging.output, 'support_seal_flue', 'wrangler.json');
			const stagingConfig = JSON.parse(fs.readFileSync(stagingConfigPath, 'utf8')) as {
				name: string;
				migrations?: unknown;
			};
			expect(stagingConfig.name).toBe('support-seal-flue-staging');
			expect(stagingConfig.migrations).toEqual(AUTHORED_MIGRATIONS);
			expect(fs.existsSync(path.join(staging.output, 'support_seal_flue_staging'))).toBe(false);
		} finally {
			if (previous === undefined) delete process.env.CLOUDFLARE_ENV;
			else process.env.CLOUDFLARE_ENV = previous;
		}
	}, 90000);

	it('serves workflows and activates packaged skills through workerd in Vite development', async () => {
		const { root } = await createGeneratedFixture('development');
		const entryPath = path.join(cloudflareViteInputDir(root), '_entry.ts');
		const viteConfig = createCloudflareViteConfig(
			root,
			cloudflareViteConfigPath(root),
			[entryPath],
			{ persistState: false },
		);
		const server = await createServer({
			...viteConfig,
			logLevel: 'silent',
			server: { host: '127.0.0.1', port: 0 },
		});
		try {
			await server.listen();
			const localUrl = server.resolvedUrls?.local[0];
			if (!localUrl) throw new Error('Vite server URL unavailable');
			const response = await fetch(new URL('/workflows/smoke?wait=result', localUrl), {
				method: 'POST',
			});
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({
				result: {
					ok: true,
					instructions: '# Cloudflare instructions\n',
					reference: {
						__flueSkillReference: true,
						name: 'review',
						description: 'Reviews requested work.',
					},
					hasBody: false,
					hasFiles: false,
				},
			});
			const missingWorkflowResponse = await fetch(new URL('/workflows/missing', localUrl), {
				method: 'POST',
			});
			expect(missingWorkflowResponse.status).toBe(404);
			expect(await missingWorkflowResponse.json()).toMatchObject({
				error: {
					type: 'workflow_not_found',
					dev: expect.stringContaining('Available workflows: "smoke"'),
				},
			});
			const skillResponse = await fetch(new URL('/workflows/use-skill?wait=result', localUrl), {
				method: 'POST',
			});
			expect(skillResponse.status).toBe(200);
			expect(await skillResponse.json()).toMatchObject({ result: { text: 'License terms.\n' } });
			const namedSkillResponse = await fetch(
				new URL('/workflows/use-named-skill?wait=result', localUrl),
				{ method: 'POST' },
			);
			expect(namedSkillResponse.status).toBe(200);
			expect(await namedSkillResponse.json()).toMatchObject({
				result: { text: 'License terms.\n' },
			});
		} finally {
			await server.close();
		}
	}, 90000);
});

async function createGeneratedFixture(
	mode: 'build' | 'development',
	options: { wranglerConfig?: Record<string, unknown>; cloudflareEnv?: string | null } = {},
): Promise<{ root: string; output: string }> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flue-vite-cloudflare-'));
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
	fs.mkdirSync(path.join(root, 'src', 'workflows'), { recursive: true });
	fs.mkdirSync(path.join(root, 'src', 'skills', 'review'), { recursive: true });
	fs.mkdirSync(path.join(root, 'src', 'instructions'), { recursive: true });
	fs.writeFileSync(
		path.join(root, 'wrangler.jsonc'),
		JSON.stringify(
			options.wranglerConfig ?? {
				name: 'vite-cloudflare-integration',
				compatibility_date: '2026-04-01',
				compatibility_flags: ['nodejs_compat'],
				migrations: AUTHORED_MIGRATIONS,
			},
		),
	);
	if (options.cloudflareEnv !== null) {
		fs.writeFileSync(
			path.join(root, mode === 'development' ? '.env.development' : '.env.production'),
			`CLOUDFLARE_ENV=${options.cloudflareEnv ?? 'fixture-env'}\n`,
		);
	}
	fs.writeFileSync(
		path.join(root, 'src', 'skills', 'review', 'SKILL.md'),
		`---\nname: review\ndescription: Reviews requested work.\n---\nReview it.\n`,
	);
	fs.writeFileSync(path.join(root, 'src', 'skills', 'review', 'LICENSE.txt'), 'License terms.\n');
	fs.writeFileSync(
		path.join(root, 'src', 'instructions', 'cloudflare.md'),
		'# Cloudflare instructions\n',
	);
	fs.writeFileSync(
		path.join(root, 'src', 'agents', 'assistant.ts'),
		`import { createAgent } from '@flue/runtime';\nimport review from '../skills/review/SKILL.md' with { type: 'skill' };\nexport default createAgent(() => ({ model: 'fixture/reader', skills: [review] }));\n`,
	);
	fs.writeFileSync(
		path.join(root, 'src', 'workflows', 'smoke.ts'),
		`import review from '../skills/review/SKILL.md' with { type: 'skill' };\nimport instructions from '../instructions/cloudflare.md' with { type: 'markdown' };\nexport const route = async (_c, next) => next();\nexport async function run() { return { ok: true, instructions, reference: review, hasBody: 'body' in review, hasFiles: 'files' in review }; }\n`,
	);
	fs.writeFileSync(
		path.join(root, 'src', 'workflows', 'use-skill.ts'),
		`import { fauxAssistantMessage, fauxText, fauxToolCall, registerFauxProvider } from '@earendil-works/pi-ai';\nimport { createAgent, registerProvider, type FlueContext } from '@flue/runtime';\nimport review from '../skills/review/SKILL.md' with { type: 'skill' };\nexport const route = async (_c, next) => next();\nconst agent = createAgent(() => ({ model: 'fixture/reader' }));\nexport async function run({ init }: FlueContext) { const faux = registerFauxProvider({ api: 'fixture-skill-api', provider: 'fixture' }); registerProvider('fixture', { api: faux.api, baseUrl: 'https://fixture.invalid' }); faux.setResponses([fauxAssistantMessage(fauxToolCall('read', { path: '/.flue/packaged-skills/' + encodeURIComponent(review.id) + '/LICENSE.txt' }), { stopReason: 'toolUse' }), (context) => { const toolResult = context.messages[context.messages.length - 1]; const content = toolResult?.role === 'toolResult' && toolResult.content[0]?.type === 'text' ? toolResult.content[0].text : 'missing packaged content'; return fauxAssistantMessage(fauxText(content)); }]); const harness = await init(agent); const session = await harness.session(); const result = await session.skill(review); faux.unregister(); return { text: result.text }; }\n`,
	);
	fs.writeFileSync(
		path.join(root, 'src', 'workflows', 'use-named-skill.ts'),
		`import { fauxAssistantMessage, fauxText, fauxToolCall, registerFauxProvider } from '@earendil-works/pi-ai';\nimport { createAgent, registerProvider, type FlueContext } from '@flue/runtime';\nimport review from '../skills/review/SKILL.md' with { type: 'skill' };\nexport const route = async (_c, next) => next();\nconst agent = createAgent(() => ({ model: 'fixture/reader', skills: [review] }));\nexport async function run({ init }: FlueContext) { const faux = registerFauxProvider({ api: 'fixture-named-skill-api', provider: 'fixture' }); registerProvider('fixture', { api: faux.api, baseUrl: 'https://fixture.invalid' }); faux.setResponses([fauxAssistantMessage(fauxToolCall('read', { path: '/.flue/packaged-skills/' + encodeURIComponent(review.id) + '/LICENSE.txt' }), { stopReason: 'toolUse' }), (context) => { const toolResult = context.messages[context.messages.length - 1]; const content = toolResult?.role === 'toolResult' && toolResult.content[0]?.type === 'text' ? toolResult.content[0].text : 'missing packaged content'; return fauxAssistantMessage(fauxText(content)); }]); const harness = await init(agent); const session = await harness.session(); const result = await session.skill('review'); faux.unregister(); return { text: result.text }; }\n`,
	);
	await build({ root, sourceRoot: path.join(root, 'src'), output, target: 'cloudflare', mode });
	return { root, output };
}
