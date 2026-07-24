import path from 'node:path';

/**
 * `flue init` scaffolding: pure file planning, no filesystem access.
 *
 * The CLI resolves the target and the deploy choice (from flags or
 * interactively) and hands them here; `planInitFiles` returns every file the
 * skeleton needs and the write loop in `src/commands/init.ts` decides what
 * actually lands on disk: create-if-absent, or overwrite too when `--force`
 * is passed.
 */

export type InitTarget = 'node' | 'cloudflare';
export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

export interface InitPlanOptions {
	/** Build target. Local-only projects run on Node. */
	target: InitTarget;
	/** Include the HTTP server setup (Vite, Hono, app.ts) for deployment. */
	deploy: boolean;
	/** Absolute directory being scaffolded into; its basename names the project. */
	targetDir: string;
	/** The CLI's own version — `@flue/*` dependencies pin to it. */
	cliVersion: string;
	/** Package manager used in README/next-step commands. */
	packageManager: PackageManager;
}

export interface ScaffoldFile {
	relPath: string;
	content: string;
}

/**
 * Third-party dependency ranges written into scaffolded package.json files.
 * Kept in sync with the ranges the repo's own examples use.
 */
const DEPENDENCY_VERSIONS = {
	agents: '^0.14.2',
	cloudflareVitePlugin: '^1.39.2',
	hono: '^4.7.0',
	typescript: '^7.0.2',
	typesNode: '^22.10.10',
	vite: '^8.0.14',
	wrangler: '^4.97.0',
} as const;

/** `npm` unless the invoking package manager identifies itself otherwise. */
export function detectPackageManager(
	userAgent = process.env.npm_config_user_agent,
): PackageManager {
	for (const pm of ['pnpm', 'yarn', 'bun'] as const) {
		if (userAgent?.startsWith(pm)) return pm;
	}
	return 'npm';
}

function execCommand(pm: PackageManager, command: string): string {
	switch (pm) {
		case 'pnpm':
			return `pnpm exec ${command}`;
		case 'yarn':
			return `yarn ${command}`;
		case 'bun':
			return `bunx ${command}`;
		default:
			return `npx ${command}`;
	}
}

/**
 * Project name derived from the target directory. Restricted to
 * `[a-z0-9-]` so one name is valid as both a package name and a
 * Cloudflare Worker name.
 */
function projectNameFrom(targetDir: string): string {
	const name = path
		.basename(path.resolve(targetDir))
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, '-')
		.replace(/^-+|-+$/g, '');
	return name || 'my-flue-app';
}

function sortedRecord(record: Record<string, string>): Record<string, string> {
	return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

function renderPackageJson(opts: InitPlanOptions): string {
	const cloudflare = opts.target === 'cloudflare';
	// Nightly (prerelease) versions pin exactly; caret ranges resolve
	// prereleases too loosely to be meaningful there.
	const flueRange = opts.cliVersion.includes('-') ? opts.cliVersion : `^${opts.cliVersion}`;

	const scripts: Record<string, string> = {};
	if (opts.deploy) {
		scripts.dev = 'vite dev';
		scripts.build = 'vite build';
		if (cloudflare) scripts.deploy = 'vite build && wrangler deploy';
		else scripts.start = 'node dist/server.mjs';
	}
	scripts['check:types'] = 'tsc --noEmit';

	const dependencies: Record<string, string> = { '@flue/runtime': flueRange };
	const devDependencies: Record<string, string> = {
		'@flue/cli': flueRange,
		'@types/node': DEPENDENCY_VERSIONS.typesNode,
		typescript: DEPENDENCY_VERSIONS.typescript,
	};
	if (opts.deploy) {
		dependencies.hono = DEPENDENCY_VERSIONS.hono;
		devDependencies['@flue/vite'] = flueRange;
		devDependencies.vite = DEPENDENCY_VERSIONS.vite;
		if (cloudflare) {
			dependencies.agents = DEPENDENCY_VERSIONS.agents;
			devDependencies['@cloudflare/vite-plugin'] = DEPENDENCY_VERSIONS.cloudflareVitePlugin;
			devDependencies.wrangler = DEPENDENCY_VERSIONS.wrangler;
		}
	}

	const manifest = {
		name: projectNameFrom(opts.targetDir),
		private: true,
		type: 'module',
		scripts,
		dependencies: sortedRecord(dependencies),
		devDependencies: sortedRecord(devDependencies),
	};
	return `${JSON.stringify(manifest, null, '\t')}\n`;
}

function renderFlueConfig(target: InitTarget): string {
	return [
		`import { defineConfig } from '@flue/runtime/config';`,
		``,
		`export default defineConfig({`,
		`\ttarget: '${target}',`,
		`});`,
		``,
	].join('\n');
}

function renderViteConfig(target: InitTarget): string {
	if (target === 'cloudflare') {
		return [
			`import { cloudflare } from '@cloudflare/vite-plugin';`,
			`import { flue, flueWorkerConfig } from '@flue/vite';`,
			`import { defineConfig } from 'vite';`,
			``,
			`export default defineConfig({`,
			`\tplugins: [flue(), cloudflare({ config: flueWorkerConfig() })],`,
			`});`,
			``,
		].join('\n');
	}
	return [
		`import { flue } from '@flue/vite';`,
		`import { defineConfig } from 'vite';`,
		``,
		`export default defineConfig({`,
		`\tplugins: [flue()],`,
		`});`,
		``,
	].join('\n');
}

function renderHelloAgent(target: InitTarget): string {
	const model = [`\tuseModel('anthropic/claude-haiku-4-5');`];
	if (target === 'cloudflare') {
		model.unshift(
			`\t// Cloudflare's built-in models need no API key — swap in e.g.`,
			`\t// useModel('cloudflare/@cf/moonshotai/kimi-k2.6') to go keyless.`,
		);
	}
	return [
		`'use agent';`,
		`import { useModel } from '@flue/runtime';`,
		``,
		`// Every exported capitalized function in a 'use agent' module is an agent,`,
		`// and the function's name is its durable identity. The return value is the`,
		`// agent's system prompt.`,
		`export function Hello() {`,
		...model,
		`\treturn 'You are a helpful assistant. Keep replies short.';`,
		`}`,
		``,
	].join('\n');
}

function renderApp(): string {
	return [
		`import { createAgentRouter } from '@flue/runtime/routing';`,
		`import { Hono } from 'hono';`,
		`import { Hello } from './agents/hello.ts';`,
		``,
		`const app = new Hono();`,
		``,
		`// The route map: every agent, channel, and custom route is mounted here`,
		`// explicitly. Talk to Hello with one POST per message:`,
		`//`,
		`//   curl -X POST http://localhost:5173/agents/hello/my-first-chat \\`,
		`//     -H 'content-type: application/json' \\`,
		`//     -d '{"kind":"user","body":"Tell me a joke."}'`,
		`app.route('/agents/hello', createAgentRouter(Hello));`,
		``,
		`export default app;`,
		``,
	].join('\n');
}

function renderDb(): string {
	return [
		`import { sqlite } from '@flue/runtime/node';`,
		``,
		`// Conversations, attachments, and accepted submissions are stored here so`,
		`// they survive a restart. Swap in another adapter (Postgres, libSQL, ...)`,
		`// when one host's SQLite file is no longer enough:`,
		`// https://flueframework.com/docs/guide/database/`,
		`export default sqlite('./data/flue.db');`,
		``,
	].join('\n');
}

function renderCloudflareEntry(): string {
	return [
		`// Worker-level Cloudflare code lives here; HTTP routing stays in src/app.ts.`,
		`//`,
		`//   - Named exports become top-level Worker exports — e.g. application-owned`,
		`//     Durable Object classes (declare their bindings in wrangler.jsonc).`,
		`//   - An optional default export adds non-HTTP handlers: scheduled (cron),`,
		`//     queue consumers, inbound email, etc. (never \`fetch\`).`,
		`//`,
		`// https://flueframework.com/docs/guide/cloudflare-target/#extending-cloudflarets-entrypoint`,
		``,
		`export {};`,
		``,
	].join('\n');
}

function renderWrangler(opts: InitPlanOptions): string {
	return [
		`{`,
		`\t"$schema": "./node_modules/wrangler/config-schema.json",`,
		`\t"name": "${projectNameFrom(opts.targetDir)}",`,
		`\t"compatibility_date": "2026-06-01",`,
		`\t"compatibility_flags": ["nodejs_compat"],`,
		`\t// Every agent generates a Durable Object class named after its identity`,
		`\t// (Hello -> FlueHelloAgent), and Cloudflare requires a migration entry`,
		`\t// for each one. Append a new tag when you add an agent:`,
		`\t// https://flueframework.com/docs/guide/cloudflare-target/#managing-migrations`,
		`\t"migrations": [{ "tag": "v1", "new_sqlite_classes": ["FlueHelloAgent"] }]`,
		`}`,
		``,
	].join('\n');
}

function renderTsconfig(): string {
	const tsconfig = {
		compilerOptions: {
			target: 'ES2022',
			module: 'ESNext',
			moduleResolution: 'Bundler',
			lib: ['ESNext'],
			types: ['node'],
			allowImportingTsExtensions: true,
			verbatimModuleSyntax: true,
			strict: true,
			skipLibCheck: true,
			noEmit: true,
		},
		include: ['src'],
	};
	return `${JSON.stringify(tsconfig, null, '\t')}\n`;
}

function renderGitignore(opts: InitPlanOptions): string {
	const lines = ['node_modules/', 'dist/', '.env'];
	if (opts.target === 'cloudflare') {
		// wrangler/workerd local state (miniflare SQLite, deploy redirect).
		lines.push('.wrangler/');
	} else {
		lines.push('data/');
	}
	return `${lines.join('\n')}\n`;
}

function renderEnv(): string {
	return [
		`# Model provider API keys, loaded automatically by \`flue run\` and \`vite dev\`.`,
		`# Any provider Pi supports works: https://pi.dev/docs/latest/providers#api-keys`,
		`ANTHROPIC_API_KEY=""`,
		``,
	].join('\n');
}

function renderAgentsMd(opts: InitPlanOptions): string {
	const pm = opts.packageManager;
	const layout = [
		`- \`src/agents/\` — agent modules. A module whose first line is the \`'use agent'\` directive exports agents: every exported capitalized function is one, and the function name is its durable identity.`,
	];
	if (opts.deploy) {
		layout.push(`- \`src/app.ts\` — the route map; every route is mounted here explicitly.`);
	}
	if (opts.target === 'cloudflare') {
		layout.push(
			`- \`src/cloudflare.ts\` — Worker-level exports and non-HTTP handlers.`,
			`- \`wrangler.jsonc\` — Worker config; every agent needs a Durable Object migration entry.`,
		);
	} else {
		layout.push(`- \`src/db.ts\` — the persistence adapter for durable conversations.`);
	}

	const commands = [
		`- \`${execCommand(pm, 'flue run src/agents/hello.ts --message "Hi"')}\` — run an agent locally, no server.`,
	];
	if (opts.deploy) {
		commands.push(`- \`${pm} run dev\` — start the dev server.`);
		if (opts.target === 'cloudflare') {
			commands.push(`- \`${pm} run deploy\` — build and deploy the Worker.`);
		} else {
			commands.push(
				`- \`${pm} run build\` — build \`dist/server.mjs\` (start it with \`${pm} run start\`).`,
			);
		}
	}
	commands.push(
		`- \`${pm} run check:types\` — typecheck.`,
		`- \`${execCommand(pm, 'flue docs search <query>')}\` — search the Flue docs from the terminal (then \`flue docs read <path>\`).`,
		`- \`${execCommand(pm, 'flue add')}\` — list blueprints for adding channels, sandboxes, and databases.`,
	);

	return [
		`# AGENTS.md`,
		``,
		`This is a [Flue](https://flueframework.com) project: agents are TypeScript functions.`,
		``,
		`## Layout`,
		``,
		...layout,
		``,
		`## Commands`,
		``,
		...commands,
		``,
	].join('\n');
}

function renderReadme(opts: InitPlanOptions): string {
	const pm = opts.packageManager;
	const lines = [
		`# ${projectNameFrom(opts.targetDir)}`,
		``,
		`A [Flue](https://flueframework.com) agent project.`,
		``,
		`## Setup`,
		``,
		'```sh',
		`${pm} install`,
		'```',
		``,
		`Then add a model provider API key to \`.env\` (any [provider Pi supports](https://pi.dev/docs/latest/providers#api-keys)).`,
		``,
		`## Talk to your agent`,
		``,
		'```sh',
		execCommand(pm, `flue run src/agents/hello.ts --message "Say hello!"`),
		'```',
		``,
		`Conversations are durable — pass \`--id <id>\` to continue one.`,
	];

	if (opts.deploy) {
		lines.push(
			``,
			`## Develop`,
			``,
			'```sh',
			`${pm} run dev`,
			'```',
			``,
			`The Hello agent is served at \`http://localhost:5173/agents/hello\` — see \`src/app.ts\` for the route map and an example request.`,
			``,
			`## Deploy`,
			``,
			'```sh',
		);
		if (opts.target === 'cloudflare') {
			lines.push(`${pm} run deploy`);
		} else {
			lines.push(`${pm} run build`, `node dist/server.mjs`);
		}
		lines.push('```');
	}

	lines.push(
		``,
		`## Learn more`,
		``,
		`- [Flue docs](https://flueframework.com/docs/) — or \`${execCommand(pm, 'flue docs')}\` from the terminal.`,
		``,
	);
	return lines.join('\n');
}

/** The full skeleton for the chosen target and deploy choice, in write order. */
export function planInitFiles(opts: InitPlanOptions): ScaffoldFile[] {
	const files: ScaffoldFile[] = [
		{ relPath: 'flue.config.ts', content: renderFlueConfig(opts.target) },
		{ relPath: 'package.json', content: renderPackageJson(opts) },
		{ relPath: 'tsconfig.json', content: renderTsconfig() },
		{ relPath: '.gitignore', content: renderGitignore(opts) },
		{ relPath: '.env', content: renderEnv() },
		{ relPath: path.join('src', 'agents', 'hello.ts'), content: renderHelloAgent(opts.target) },
	];
	if (opts.deploy) {
		files.push(
			{ relPath: 'vite.config.ts', content: renderViteConfig(opts.target) },
			{ relPath: path.join('src', 'app.ts'), content: renderApp() },
		);
	}
	if (opts.target === 'cloudflare') {
		files.push(
			{ relPath: path.join('src', 'cloudflare.ts'), content: renderCloudflareEntry() },
			{ relPath: 'wrangler.jsonc', content: renderWrangler(opts) },
		);
	} else {
		files.push({ relPath: path.join('src', 'db.ts'), content: renderDb() });
	}
	files.push(
		{ relPath: 'AGENTS.md', content: renderAgentsMd(opts) },
		{ relPath: 'README.md', content: renderReadme(opts) },
	);
	return files;
}

/** Post-scaffold guidance, one step per line. */
export function initNextSteps(opts: InitPlanOptions): string[] {
	const pm = opts.packageManager;
	const steps = [
		`${pm} install`,
		`add a model provider API key to .env`,
		execCommand(pm, `flue run src/agents/hello.ts --message "Say hello!"`),
	];
	if (opts.deploy) {
		steps.push(`${pm} run dev — the Hello agent listens at /agents/hello`);
	}
	return steps;
}
