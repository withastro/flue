import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { packageUpSync } from 'package-up';
import { parseAgentFile } from './agent-parser.ts';
import { parseFrontmatterFile } from './context.ts';
import { CloudflarePlugin } from './build-plugin-cloudflare.ts';
import { NodePlugin } from './build-plugin-node.ts';
import type {
	AgentInfo,
	BuildContext,
	BuildOptions,
	BuildPlugin,
	Role,
	ThinkingLevel,
} from './types.ts';

// Exhaustive list of valid thinking levels. The `satisfies` clause ensures this
// stays in lockstep with `ThinkingLevel` from pi-agent-core: if a level is added
// or removed upstream, this assignment fails to type-check.
const VALID_THINKING_LEVELS = {
	off: true,
	minimal: true,
	low: true,
	medium: true,
	high: true,
	xhigh: true,
} as const satisfies Record<ThinkingLevel, true>;

function parseThinkingLevel(value: string | undefined, source: string): ThinkingLevel | undefined {
	if (value === undefined) return undefined;
	const normalized = value.trim();
	if (!normalized) return undefined;
	if (!(normalized in VALID_THINKING_LEVELS)) {
		throw new Error(
			`[flue] Invalid thinkingLevel ${JSON.stringify(value)} in ${source}. ` +
				`Expected one of: ${Object.keys(VALID_THINKING_LEVELS).join(', ')}.`,
		);
	}
	return normalized as ThinkingLevel;
}

/**
 * Result returned by {@link build}. `changed` indicates whether any file in
 * `dist/` was actually modified. Callers (notably the dev server) use this to
 * skip restarting downstream processes for no-op rebuilds on agent body edits.
 */
export interface BuildResult {
	changed: boolean;
}

/**
 * Build a workspace into a deployable artifact.
 *
 * `options.workspaceDir` is treated as an explicit workspace root — the directory
 * directly containing agents/ and roles/. No .flue/ waterfall is performed here;
 * callers that want waterfall behavior (e.g. the CLI when --workspace is omitted)
 * should use `resolveWorkspaceFromCwd` first.
 *
 * AGENTS.md and .agents/skills/ are NOT bundled — discovered at runtime from session cwd.
 */
export async function build(options: BuildOptions): Promise<BuildResult> {
	const workspaceDir = path.resolve(options.workspaceDir);
	const outputDir = path.resolve(options.outputDir);

	const plugin = resolvePlugin(options);

	console.log(`[flue] Building workspace: ${workspaceDir}`);
	console.log(`[flue] Output: ${outputDir}/dist`);
	console.log(`[flue] Target: ${plugin.name}`);

	const roles = discoverRoles(workspaceDir);
	const agents = discoverAgents(workspaceDir);

	if (agents.length === 0) {
		throw new Error(
			`[flue] No agent files found.\n\n` +
				`Expected at: ${path.join(workspaceDir, 'agents')}/\n` +
				`Add at least one agent file (e.g. hello.ts).`,
		);
	}

	// NOTE: agents without triggers are valid. They aren't exposed as HTTP
	// routes in deployed builds, but the `flue run` CLI can still invoke them
	// locally (see FLUE_MODE=local in the Node plugin). This supports the
	// "CI-only agent" pattern documented in the README.
	const webhookAgents = agents.filter((a) => a.triggers.webhook);
	const triggerlessAgents = agents.filter((a) => !a.triggers.webhook);

	console.log(
		`[flue] Found ${Object.keys(roles).length} role(s): ${Object.keys(roles).join(', ') || '(none)'}`,
	);
	console.log(`[flue] Found ${agents.length} agent(s): ${agents.map((a) => a.name).join(', ')}`);
	if (webhookAgents.length > 0) {
		console.log(`[flue] Webhook agents: ${webhookAgents.map((a) => a.name).join(', ')}`);
	}
	if (triggerlessAgents.length > 0) {
		console.log(
			`[flue] CLI-only agents (no HTTP route in deployed build): ${triggerlessAgents.map((a) => a.name).join(', ')}`,
		);
	}
	console.log(
		`[flue] AGENTS.md and .agents/skills/ will be discovered at runtime from session cwd`,
	);

	const distDir = path.join(outputDir, 'dist');
	fs.mkdirSync(distDir, { recursive: true });

	const manifest = {
		agents: agents.map((a) => ({
			name: a.name,
			triggers: a.triggers,
		})),
	};
	const manifestPath = path.join(distDir, 'manifest.json');
	fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
	console.log(`[flue] Generated: ${manifestPath}`);

	const ctx: BuildContext = {
		agents,
		roles,
		workspaceDir,
		outputDir,
		options,
	};

	const serverCode = await plugin.generateEntryPoint(ctx);
	const bundleStrategy = plugin.bundle ?? 'esbuild';
	let anyChanged = false;

	if (bundleStrategy === 'esbuild') {
		// Single-bundle mode: the plugin produces a TS entry, esbuild
		// inlines/externalizes deps, output is dist/server.mjs.
		const entryPath = path.join(distDir, '_entry_server.ts');
		const outPath = path.join(distDir, 'server.mjs');

		fs.writeFileSync(entryPath, serverCode, 'utf-8');

		try {
			const nodePathsSet = collectNodePaths(workspaceDir);
			const { external: pluginExternal = [], ...pluginEsbuildOpts } = plugin.esbuildOptions
				? plugin.esbuildOptions(ctx)
				: {};

			// User's direct deps are externalized (resolved at runtime); Flue infra gets bundled
			const userExternals = getUserExternals(workspaceDir);

			await esbuild.build({
				entryPoints: [entryPath],
				bundle: true,
				outfile: outPath,
				format: 'esm',
				external: [...pluginExternal, ...userExternals],
				nodePaths: [...nodePathsSet],
				logLevel: 'warning',
				loader: { '.ts': 'ts', '.node': 'empty' },
				treeShaking: true,
				sourcemap: true,
				...pluginEsbuildOpts,
			});
			console.log(`[flue] Built: ${outPath}`);
			// esbuild always writes; we treat this path as "changed" without
			// trying to compute byte-equality across reloads.
			anyChanged = true;
		} finally {
			try {
				fs.unlinkSync(entryPath);
			} catch {
				/* ignore */
			}
		}
	} else if (bundleStrategy === 'none') {
		// Pass-through mode: write the entry as-is. A downstream tool (e.g.
		// wrangler) handles bundling. We don't even glance at `esbuildOptions`.
		if (!plugin.entryFilename) {
			throw new Error(
				`[flue] Plugin "${plugin.name}" set bundle: 'none' but did not provide entryFilename.`,
			);
		}
		const outPath = path.join(distDir, plugin.entryFilename);
		// Skip the write if content is byte-identical to what's already on
		// disk. This matters for `flue dev`, where downstream watchers (like
		// wrangler's bundler) may key on file mtime and would otherwise reload
		// the worker for a no-op rebuild on agent body edits.
		const writeIfChanged =
			!fs.existsSync(outPath) || fs.readFileSync(outPath, 'utf-8') !== serverCode;
		if (writeIfChanged) {
			fs.writeFileSync(outPath, serverCode, 'utf-8');
			console.log(`[flue] Wrote entry: ${outPath} (no bundle — downstream tool handles it)`);
			anyChanged = true;
		} else {
			console.log(`[flue] Entry unchanged: ${outPath}`);
		}
	} else {
		throw new Error(`[flue] Unknown bundle strategy: ${bundleStrategy}`);
	}

	if (plugin.additionalOutputs) {
		const outputs = await plugin.additionalOutputs(ctx);
		for (const [filename, content] of Object.entries(outputs)) {
			const filePath = path.join(distDir, filename);
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			// As with the entry above: avoid touching the file if content is
			// unchanged so downstream watchers (e.g. wrangler) don't see
			// spurious mtime updates and reload for no reason.
			const changed =
				!fs.existsSync(filePath) || fs.readFileSync(filePath, 'utf-8') !== content;
			if (changed) {
				fs.writeFileSync(filePath, content, 'utf-8');
				console.log(`[flue] Generated: ${filePath}`);
				anyChanged = true;
			}
		}
	}

	console.log(`[flue] Build complete. Output: ${distDir}`);
	return { changed: anyChanged };
}

function resolvePlugin(options: BuildOptions): BuildPlugin {
	if (options.plugin) return options.plugin;

	if (!options.target) {
		throw new Error(
			'[flue] No build target specified. Use --target to choose a target:\n' +
				'  flue build --target node\n' +
				'  flue build --target cloudflare',
		);
	}

	switch (options.target) {
		case 'node':
			return new NodePlugin();
		case 'cloudflare':
			return new CloudflarePlugin();
		default:
			throw new Error(
				`[flue] Unknown target: "${options.target}". Supported targets: node, cloudflare`,
			);
	}
}

/**
 * Resolve a Flue workspace directory from the current working directory,
 * using the two-layout convention. Intended for the CLI when `--workspace` is
 * not provided — callers that pass an explicit workspace path should skip this
 * and pass the path straight to `build()`.
 *
 * Two supported layouts, checked in order:
 *   1. `<cwd>/.flue/` — use this when Flue is embedded in an existing project.
 *   2. `<cwd>/` — use this when the project itself is the Flue workspace.
 *
 * If `.flue/` exists, it wins unconditionally — no mixing with the bare layout.
 * Returns null if neither is present so the caller can produce a helpful error.
 */
export function resolveWorkspaceFromCwd(cwd: string): string | null {
	const dotFlue = path.join(cwd, '.flue');
	if (fs.existsSync(dotFlue)) return dotFlue;
	if (fs.existsSync(path.join(cwd, 'agents'))) return cwd;
	return null;
}

function discoverRoles(workspaceRoot: string): Record<string, Role> {
	const rolesDir = path.join(workspaceRoot, 'roles');
	if (!fs.existsSync(rolesDir)) return {};

	const roles: Record<string, Role> = {};

	for (const entry of fs.readdirSync(rolesDir)) {
		if (!/\.(md|markdown)$/i.test(entry)) continue;

		const filePath = path.join(rolesDir, entry);
		const content = fs.readFileSync(filePath, 'utf-8');
		const name = entry.replace(/\.(md|markdown)$/i, '');
		const parsed = parseFrontmatterFile(content, name);
		const thinkingLevel = parseThinkingLevel(
			parsed.frontmatter.thinkingLevel,
			`role "${name}" frontmatter`,
		);
		roles[name] = {
			name,
			description: parsed.description,
			instructions: parsed.body,
			model: parsed.frontmatter.model,
			thinkingLevel,
		};
	}

	return roles;
}

function discoverAgents(workspaceRoot: string): AgentInfo[] {
	const agentsDir = path.join(workspaceRoot, 'agents');
	if (!fs.existsSync(agentsDir)) return [];

	return fs
		.readdirSync(agentsDir)
		.filter((f) => /\.(ts|js|mts|mjs)$/.test(f))
		.map((f) => {
			const filePath = path.join(agentsDir, f);
			const { triggers } = parseAgentFile(filePath);
			return {
				name: f.replace(/\.(ts|js|mts|mjs)$/, ''),
				filePath,
				triggers,
			};
		});
}

/** Externalize user's direct deps (bare name + subpath wildcard). */
function getUserExternals(workspaceDir: string): string[] {
	const pkgPath = packageUpSync({ cwd: workspaceDir });
	if (!pkgPath) return [];

	try {
		const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
		const deps = Object.keys({
			...pkg.dependencies,
			...pkg.devDependencies,
			...pkg.peerDependencies,
		});
		return deps.flatMap((name) => [name, `${name}/*`]);
	} catch {
		return [];
	}
}

function collectNodePaths(workspaceDir: string): Set<string> {
	const nodePathsSet = new Set<string>();
	for (const startDir of [workspaceDir, getSDKDir()]) {
		let dir = startDir;
		while (dir !== path.dirname(dir)) {
			const nm = path.join(dir, 'node_modules');
			if (fs.existsSync(nm)) nodePathsSet.add(nm);
			dir = path.dirname(dir);
		}
	}
	return nodePathsSet;
}

function getSDKDir(): string {
	try {
		return path.dirname(new URL(import.meta.url).pathname);
	} catch {
		return __dirname;
	}
}
