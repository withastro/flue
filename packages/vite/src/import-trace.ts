/**
 * Import-edge tracing for wrong-environment diagnostics.
 *
 * A cheap `enforce: 'pre'` resolveId hook records every resolution edge
 * (resolved child id → importer). When a load later fails on a module that
 * cannot exist in this environment — the motivating case is a `cloudflare:*`
 * import reaching a Node graph (`vite dev`, `vite build`, `flue run`) — the
 * recorded edges reconstruct the import chain from the user's entry down to
 * the offending specifier, so the diagnostic names the route to the problem
 * instead of just the problem:
 *
 *   src/app.ts imports
 *    src/lib/platform.ts imports
 *     cloudflare:workers
 */
import * as path from 'node:path';
import { normalizePath, type Plugin } from 'vite';

export interface ImportTrace {
	/** The edge-recording plugin; include it wherever chains should be explainable. */
	readonly plugin: Plugin;
	/**
	 * Render the entry-first import pyramid ending at `id` (a resolved module
	 * id or an unresolvable raw specifier), or `undefined` when no edge to it
	 * was ever recorded. The upward walk stops at the first module outside
	 * `root`, so framework bootstrap modules never appear in user diagnostics.
	 */
	explain(id: string, root: string): string | undefined;
}

const CLOUDFLARE_SPECIFIER_PATTERN = /cloudflare:[\w-]+(?:[./][\w-]+)*/;

export function createImportTrace(options: { enabled: () => boolean }): ImportTrace {
	// Resolved child id (or raw `cloudflare:*` specifier) → importer.
	// Last write wins so the map tracks the current module graph across edits.
	const importers = new Map<string, string>();

	const plugin: Plugin = {
		name: 'flue-import-trace',
		enforce: 'pre',
		buildStart() {
			// Build phases get fresh plugin drivers; stale edges from a previous
			// phase must not leak into this one's diagnostics.
			importers.clear();
		},
		async resolveId(source, importer) {
			if (!options.enabled()) return null;
			// Only real module files make trustworthy edges: the dep-optimizer
			// scanner resolves from synthetic roots (`index.html`) that would
			// otherwise clobber the true importer of an unresolvable specifier.
			if (!importer || !path.isAbsolute(importer)) return null;
			if (source.startsWith('\0') || importer.startsWith('\0')) return null;
			// Scheme specifiers never reach plugin resolution on the failing
			// path (Vite's import analysis treats them as external URLs), so
			// their edges are recorded from source text in `transform` instead.
			if (/^[a-z][a-z0-9+.-]*:/.test(source)) return null;
			let key = source;
			try {
				const resolved = await this.resolve(source, importer, { skipSelf: true });
				if (resolved?.id) key = resolved.id;
			} catch {
				// Unresolvable: keyed by the raw specifier — which is exactly what
				// failure diagnostics look up.
			}
			importers.set(key, importer);
			return null;
		},
		transform: {
			filter: { code: { include: [CLOUDFLARE_SPECIFIER_PATTERN] } },
			handler(code, id) {
				if (!options.enabled() || id.startsWith('\0')) return null;
				const importer = id.split('?')[0] ?? id;
				if (!path.isAbsolute(importer)) return null;
				for (const match of code.matchAll(
					new RegExp(`(['"])(${CLOUDFLARE_SPECIFIER_PATTERN.source})\\1`, 'g'),
				)) {
					const specifier = match[2];
					if (specifier !== undefined) importers.set(specifier, importer);
				}
				return null;
			},
		},
	};

	const explain = (id: string, root: string): string | undefined => {
		if (!importers.has(id)) return undefined;
		const chain: string[] = [id];
		const seen = new Set<string>([id]);
		let current = id;
		while (true) {
			const importer = importers.get(current);
			if (!importer || seen.has(importer) || !isWithinRoot(importer, root)) break;
			chain.unshift(importer);
			seen.add(importer);
			current = importer;
		}
		return chain
			.map((entry, index) => {
				const suffix = index === chain.length - 1 ? '' : ' imports';
				return `${' '.repeat(index + 1)}${displayModule(entry, root)}${suffix}`;
			})
			.join('\n');
	};

	return { plugin, explain };
}

/**
 * The `cloudflare:*` specifier mentioned by an error (or its cause chain),
 * if any — the signature of platform code reaching a Node module graph.
 */
export function findCloudflareSpecifier(error: unknown): string | undefined {
	let current: unknown = error;
	for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
		const match = current.message.match(/cloudflare:[\w-]+(?:[./][\w-]+)*/);
		if (match) return match[0];
		current = current.cause;
	}
	return undefined;
}

/**
 * Diagnostic text for a Node-graph load failure caused by a `cloudflare:*`
 * import: what does not exist here, the type-only escape hatch, and the
 * recorded import chain when one is known.
 */
export function explainCloudflareImport(
	error: unknown,
	trace: ImportTrace,
	root: string,
): string | undefined {
	const specifier = findCloudflareSpecifier(error);
	if (specifier === undefined) return undefined;
	const hint =
		`'${specifier}' does not exist on the Node target. ` +
		'If the import is only used for types, change it to `import type` so it is erased at build time.';
	const chain = trace.explain(specifier, root);
	return chain ? `${hint}\nImport chain:\n${chain}` : hint;
}

function isWithinRoot(filePath: string, root: string): boolean {
	if (!path.isAbsolute(filePath)) return false;
	const relative = path.relative(root, filePath.split('?')[0] ?? filePath);
	return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function displayModule(id: string, root: string): string {
	if (!path.isAbsolute(id)) return id;
	const bare = id.split('?')[0] ?? id;
	const relative = path.relative(root, bare);
	return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
		? normalizePath(relative)
		: normalizePath(bare);
}
