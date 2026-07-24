/**
 * Dependency and externalization policy for the generated Node application,
 * ported from the CLI's build pipeline (packages/cli/src/lib/build.ts, which
 * keeps its own copy until Phase 6).
 *
 * The invariant this file protects: exactly ONE `@flue/runtime` instance in
 * the loaded application graph. The runtime keeps module-scoped registries
 * (agent registration, runtime config, providers), so a second copy — e.g.
 * `@flue/vite`'s own nested install resolved from the bootstrap modules —
 * would split the app's state in half. Every bare specifier the bootstrap
 * graph imports is therefore resolved through an explicit `node_modules`
 * chain seeded from the *project root first*, so the user's install always
 * wins.
 *
 * In a build, user dependencies and Node builtins are externalized (see
 * {@link getUserExternals}) while `@flue/runtime` is bundled into
 * `server.mjs`. In dev, the resolver marks its resolutions `external` so the
 * SSR module runner imports the canonical files natively.
 */
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

/**
 * Externalize the user's direct deps (bare name + subpath wildcard) in the
 * production build. `@flue/runtime` and `debug` are bundled into the
 * generated entry even when the user lists them.
 */
export function getUserExternals(root: string): string[] {
	const pkgPath = findPackageJson(root);
	if (!pkgPath) return [];

	try {
		const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
		const bundledGeneratedEntryDependencies = new Set(['@flue/runtime', 'debug']);
		const deps = Object.keys({
			...pkg.dependencies,
			...pkg.devDependencies,
			...pkg.peerDependencies,
		}).filter((name) => !bundledGeneratedEntryDependencies.has(name));
		return deps.flatMap((name) => [name, `${name}/*`]);
	} catch {
		return [];
	}
}

function findPackageJson(startDir: string): string | undefined {
	let dir = path.resolve(startDir);
	while (true) {
		const candidate = path.join(dir, 'package.json');
		if (fs.existsSync(candidate)) return candidate;
		const parent = path.dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

/**
 * Mutable state shared with the core `flue` plugin, which fills it in during
 * Vite config resolution (the project root and the dev/build mode aren't
 * known when `flue()` constructs its plugin array).
 */
export interface DependencyResolverState {
	/** Absolute project root; unset until the core plugin resolves config. */
	root: string | undefined;
	/** Mark resolutions external (dev SSR) instead of bundling them (build). */
	external: boolean;
	/**
	 * Restrict resolution to these importers. `@flue/runtime`(/*),
	 * `@hono/node-server`, and `debug` are always canonicalized regardless of
	 * importer, because a second runtime instance anywhere in the graph breaks
	 * the module-scoped registries.
	 */
	importers: readonly string[] | undefined;
}

/**
 * Resolve bare specifiers imported by the generated/bootstrap modules through
 * the seeded `node_modules` chain ({@link collectNodePaths}). Ported from the
 * CLI's `viteGeneratedEntryDependencyResolver`.
 */
export function flueDependencyResolverPlugin(state: DependencyResolverState): Plugin {
	let resolvers: NodeJS.Require[] | undefined;
	let resolversRoot: string | undefined;
	const getResolvers = (root: string): NodeJS.Require[] => {
		if (!resolvers || resolversRoot !== root) {
			resolversRoot = root;
			resolvers = [...collectNodePaths(root)].map((nodePath) =>
				createRequire(path.join(nodePath, '__flue_vite_resolve__.mjs')),
			);
		}
		return resolvers;
	};
	return {
		name: 'flue-generated-entry-dependency-resolver',
		enforce: 'pre',
		resolveId(source: string, importer?: string) {
			const root = state.root;
			if (!root) return null;
			if (
				state.importers &&
				(!importer || !state.importers.includes(importer)) &&
				source !== '@flue/runtime' &&
				!source.startsWith('@flue/runtime/') &&
				source !== '@hono/node-server' &&
				source !== 'debug'
			)
				return null;
			if (
				source.startsWith('.') ||
				source.startsWith('/') ||
				source.startsWith('\0') ||
				source.startsWith('virtual:') ||
				source.startsWith('node:')
			)
				return null;
			if (source === '@hono/node-server' && state.external) {
				for (const nodePath of collectNodePaths(root)) {
					const packageDir = path.join(nodePath, '@hono', 'node-server');
					if (fs.existsSync(packageDir)) {
						return { id: path.join(packageDir, 'dist', 'index.mjs'), external: true };
					}
				}
			}
			for (const resolve of getResolvers(root)) {
				try {
					const id = resolve.resolve(source);
					return state.external ? { id, external: true } : id;
				} catch {}
			}
			return null;
		},
	};
}

function collectNodePaths(root: string): Set<string> {
	const nodePathsSet = new Set<string>();
	// Walk up from the project root (user's deps), this package's own location
	// (so workspace-linked installs reach `@flue/vite`'s helpers), and
	// `@flue/runtime`'s install location as resolved from the project. The
	// latter is what surfaces the runtime deps (`@hono/node-server`, `hono`,
	// `pi-ai`, etc.) that the generated `server.mjs` imports — `@flue/runtime`
	// is the package that lists them, so the Vite build must be able to reach
	// its `node_modules/` subtree.
	const seeds = [root, getPackageDir()];
	const runtimeDir = resolveRuntimeDir(root);
	if (runtimeDir) seeds.push(runtimeDir);
	for (const startDir of seeds) {
		let dir = startDir;
		while (dir !== path.dirname(dir)) {
			const nm = path.join(dir, 'node_modules');
			if (fs.existsSync(nm)) nodePathsSet.add(nm);
			dir = path.dirname(dir);
		}
	}
	return nodePathsSet;
}

function getPackageDir(): string {
	return path.dirname(fileURLToPath(import.meta.url));
}

/**
 * Resolve the install directory of `@flue/runtime` as seen from the project
 * `root`. We walk up from `root` looking for `node_modules/@flue/runtime` —
 * `require.resolve` would be cleaner, but `@flue/runtime`'s `package.json`
 * isn't part of the package's `exports` map and its subpaths are ESM-only,
 * both of which trip up `createRequire`. Walking the `node_modules` chain is
 * what npm/pnpm/yarn all do internally for resolution anyway. Returns the
 * package directory, or `undefined` if the project doesn't have
 * `@flue/runtime` installed yet.
 */
function resolveRuntimeDir(root: string): string | undefined {
	let dir = root;
	while (dir !== path.dirname(dir)) {
		const candidate = path.join(dir, 'node_modules', '@flue', 'runtime');
		if (fs.existsSync(candidate)) return candidate;
		dir = path.dirname(dir);
	}
	return undefined;
}
