/**
 * Flue's markdown/skill import transform.
 *
 * Detection is by SPECIFIER, not by import attribute — TypeScript already
 * types these imports purely by suffix (the ambient `*.md` and `SKILL.md`
 * module declarations), so the specifier carries all the information and an
 * attribute would duplicate it:
 *
 *   - an import that resolves to a file named `SKILL.md` packages the whole
 *     skill directory (bundle, metadata, reference);
 *   - every other bare `.md` import loads as a markdown text module;
 *   - Vite-native queries (`?raw`, `?url`, ...) are left to Vite.
 *
 * Those are the only two Flue forms. An odd-named markdown file becomes a
 * skill in userland, not here: import it as markdown text and pass it to
 * `defineSkill({ name, description, instructions })`. The legacy
 * `with { type: 'skill' | 'markdown' }` attributes are rejected with a
 * pointer at that pattern.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PackagedSkillDirectory } from '@flue/runtime';
import { buildPackagedSkill, parseSkillMarkdown } from '@flue/runtime/internal';
import MagicString from 'magic-string';
import { ulid } from 'ulidx';
import { normalizePath, type Plugin, parseAstAsync } from 'vite';
import { parserLangForFile } from './agent-scan.ts';
import { canonicalizePath, isWithinDirectory } from './paths.ts';

const MARKDOWN_MODULE_PREFIX = '\0flue-markdown:';
const SKILL_MODULE_PREFIX = '\0flue-skill:';
const ENCODED_SKILL_MODULE_PREFIX = '__x00__flue-skill:';
const PACKAGED_FILE_WARNING_BYTES = 1024 * 1024;
const EXCLUDED_DIRECTORIES = new Set([
	'.git',
	'.cache',
	'.turbo',
	'.wrangler',
	'dist',
	'node_modules',
]);
const SENSITIVE_DIRECTORIES = new Set(['.aws', '.gnupg', '.ssh']);
const EXCLUDED_FILES = new Set(['.netrc', '.npmrc', '.pypirc', '_netrc', 'credentials.json']);
const SENSITIVE_FILE_PATTERNS = [/\.key$/i, /\.pem$/i, /\.p12$/i, /\.pfx$/i, /^secrets?(?:\.|$)/i];

/**
 * Handles Flue's markdown and skill imports in one plugin so each module in
 * the graph is type-stripped and parsed once per (re)build, and so the two
 * module kinds cannot drift apart.
 */
export function markdownImportPlugin(): Plugin {
	let viteRoot = '';
	const internalModuleToken = ulid();
	const internalSkillModulePrefix = `${SKILL_MODULE_PREFIX}${internalModuleToken}:`;
	const encodedInternalSkillModulePrefix = `__x00__flue-skill:${internalModuleToken}:`;
	const trackedSkillDirectories = new Set<string>();

	return {
		name: 'flue-markdown-imports',
		enforce: 'pre',
		configResolved(config) {
			viteRoot = config.root;
		},
		buildStart() {
			// Vite app builds can run multiple build phases with fresh plugin
			// drivers; per-build bookkeeping must not leak across phases.
			trackedSkillDirectories.clear();
		},
		transform: {
			// Only modules that could carry a `.md` import (including legacy
			// attribute forms) reach the handler, which type-strips and parses
			// — by far this plugin's hottest path.
			filter: {
				id: { include: /\.[cm]?[jt]sx?(?:\?|$)/i },
				code: { include: [/\.md/] },
			},
			async handler(code, id) {
				if (!/\.[cm]?[jt]sx?(?:\?|$)/i.test(id)) return null;
				const importerPath = id.split('?')[0] ?? id;
				const program = await parseAstAsync(
					code,
					{ lang: parserLangForFile(importerPath) },
					importerPath,
				);
				const ast = program as unknown as ModuleAst;
				assertNoDynamicSkillImports(ast);
				const markdownImports = collectMarkdownImports(ast);
				if (markdownImports.length === 0) return null;
				const replacements: Array<MarkdownImport & { moduleId: string }> = [];
				for (const declaration of markdownImports) {
					const query = importQuery(declaration.specifier);
					if (query !== undefined) continue; // ?raw, ?url, ... — Vite's
					const bareSpecifier = stripQueryAndHash(declaration.specifier);
					const rootRelativePath = bareSpecifier.startsWith('/')
						? path.resolve(viteRoot, bareSpecifier.slice(1))
						: undefined;
					const resolved = rootRelativePath
						? { id: rootRelativePath, external: false }
						: await this.resolve(bareSpecifier, importerPath, { skipSelf: true });
					if (!resolved || resolved.external) {
						throw new Error(`[flue] Unable to resolve markdown import: ${declaration.specifier}`);
					}
					const filesystemPath = stripQueryAndHash(resolved.id);
					if (!path.isAbsolute(filesystemPath)) {
						throw new Error(
							`[flue] Markdown imports must resolve to a filesystem path: ${declaration.specifier}`,
						);
					}
					const resolvedPath = canonicalPath(filesystemPath);
					// A skill: any import that RESOLVES to a file named SKILL.md
					// (aliases included).
					if (isSkillMarkdownPath(resolvedPath)) {
						replacements.push({
							...declaration,
							moduleId: `${internalSkillModulePrefix}${resolvedPath}`,
						});
						continue;
					}
					replacements.push({
						...declaration,
						moduleId: `${MARKDOWN_MODULE_PREFIX}${resolvedPath}`,
					});
				}
				if (replacements.length === 0) return null;
				const ms = new MagicString(code);
				for (const replacement of replacements) {
					ms.overwrite(replacement.start, replacement.end, JSON.stringify(replacement.moduleId));
				}
				return {
					code: ms.toString(),
					map: ms.generateMap({ hires: 'boundary', source: id, includeContent: true }),
				};
			},
		},
		resolveId(source, importer) {
			if (source.startsWith(MARKDOWN_MODULE_PREFIX)) return source;
			const internalModuleId = decodeSkillModuleId(
				source,
				internalSkillModulePrefix,
				encodedInternalSkillModulePrefix,
			);
			if (internalModuleId) return internalModuleId;
			if (source.startsWith(SKILL_MODULE_PREFIX) || source.includes(ENCODED_SKILL_MODULE_PREFIX)) {
				throw new Error(
					'[flue] Internal packaged-skill module IDs cannot be imported directly. Use a static SKILL.md import.',
				);
			}
			if (!importer) return null;
			if (isSkillMarkdownPath(source)) {
				// The transform packages these automatically; reaching raw
				// resolution means the importer was outside the transform's
				// module filter (a non-JS/TS importer, say).
				throw new Error(
					`[flue] Skill import "${source}" reached resolution untransformed. Skill imports are packaged automatically from .ts/.js importers; import it from a module the Flue transform processes.`,
				);
			}
			return null;
		},
		hotUpdate(options) {
			const changedPath = canonicalPath(options.file);
			const directory = [...trackedSkillDirectories].find((trackedDirectory) =>
				isWithinDirectory(changedPath, trackedDirectory),
			);
			if (directory) {
				const skillPath = `${directory}/SKILL.md`;
				const modules = [
					this.environment.moduleGraph.getModuleById(`${internalSkillModulePrefix}${skillPath}`),
				].filter((module) => module !== undefined);
				for (const module of modules) this.environment.moduleGraph.invalidateModule(module);
				return modules;
			}
		},
		async load(id) {
			if (id.startsWith(MARKDOWN_MODULE_PREFIX)) {
				const markdownPath = id.slice(MARKDOWN_MODULE_PREFIX.length);
				this.addWatchFile(markdownPath);
				return `export default ${JSON.stringify(await fs.promises.readFile(markdownPath, 'utf8'))};`;
			}
			if (!id.startsWith(internalSkillModulePrefix)) return null;
			const skillPath = id.slice(internalSkillModulePrefix.length);
			// Dev invalidation needs no addWatchFile: the dev watcher covers the
			// source root, and hotUpdate maps changed files back to skill modules
			// by directory.
			trackedSkillDirectories.add(canonicalPath(path.dirname(skillPath)));
			const packagedSkill = await packageSkill(skillPath);
			return [
				`import { createSkillReference } from '@flue/runtime/internal';`,
				`const directory = ${JSON.stringify(packagedSkill)};`,
				'export default createSkillReference(directory);',
			].join('\n');
		},
	};
}

async function packageSkill(skillPath: string): Promise<PackagedSkillDirectory> {
	const directory = path.dirname(skillPath);
	const parsed = parseSkillMarkdown(await fs.promises.readFile(skillPath, 'utf8'), {
		directoryName: path.basename(directory),
		path: skillPath,
	});
	const files = [];
	for (const filePath of await collectFiles(directory)) {
		const content = await fs.promises.readFile(filePath);
		if (content.byteLength > PACKAGED_FILE_WARNING_BYTES) {
			console.warn(
				`[flue] Skill file "${filePath}" exceeds 1MB and will be packaged into the deployed application for lazy access.`,
			);
		}
		files.push({
			path: normalizePath(path.relative(directory, filePath)),
			content: new Uint8Array(content),
		});
	}
	return buildPackagedSkill({ name: parsed.name, description: parsed.description, files });
}

function canonicalPath(filePath: string): string {
	return normalizePath(canonicalizePath(filePath));
}

async function collectFiles(directory: string, skillRoot = directory): Promise<string[]> {
	const files: string[] = [];
	for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
		const absolutePath = path.join(directory, entry.name);
		const relativePath = normalizePath(path.relative(skillRoot, absolutePath));
		if (entry.isSymbolicLink()) {
			throw new Error(
				`[flue] Skill directory "${skillRoot}" contains symbolic link "${relativePath}", which cannot be packaged. Replace it with a regular file or directory.`,
			);
		}
		if (entry.isDirectory()) {
			if (EXCLUDED_DIRECTORIES.has(entry.name)) {
				console.warn(
					`[flue] Excluding skill directory "${relativePath}" from the deployed application package because it is generated or repository metadata.`,
				);
				continue;
			}
			if (SENSITIVE_DIRECTORIES.has(entry.name.toLowerCase())) {
				throw new Error(
					`[flue] Imported skill directory "${skillRoot}" contains sensitive directory "${relativePath}", which cannot be packaged. Remove credentials and private keys from the skill directory.`,
				);
			}
			files.push(...(await collectFiles(absolutePath, skillRoot)));
		} else if (entry.isFile()) {
			if (isSensitiveFile(entry.name)) {
				throw new Error(
					`[flue] Imported skill directory "${skillRoot}" contains sensitive file "${relativePath}", which cannot be packaged. Remove credentials and private keys from the skill directory.`,
				);
			}
			if (isExcludedFile(entry.name)) {
				console.warn(
					`[flue] Excluding skill file "${relativePath}" from the deployed application package because it is generated content.`,
				);
				continue;
			}
			files.push(absolutePath);
		}
	}
	return files.sort();
}

function isSensitiveFile(filename: string): boolean {
	const lowerFilename = filename.toLowerCase();
	return (
		EXCLUDED_FILES.has(lowerFilename) ||
		lowerFilename === '.dev.vars' ||
		lowerFilename.startsWith('.dev.vars.') ||
		lowerFilename === '.env' ||
		lowerFilename.startsWith('.env.') ||
		SENSITIVE_FILE_PATTERNS.some((pattern) => pattern.test(filename))
	);
}

function isExcludedFile(filename: string): boolean {
	const lowerFilename = filename.toLowerCase();
	return (
		lowerFilename === '.ds_store' ||
		lowerFilename.endsWith('.swp') ||
		lowerFilename.endsWith('.swo') ||
		lowerFilename.endsWith('~')
	);
}

function decodeSkillModuleId(
	source: string,
	internalPrefix: string,
	encodedInternalPrefix: string,
): string | undefined {
	if (source.startsWith(internalPrefix)) return source;
	const encodedIndex = source.indexOf(encodedInternalPrefix);
	if (encodedIndex !== -1)
		return `${internalPrefix}${source.slice(encodedIndex + encodedInternalPrefix.length)}`;
	return undefined;
}

function stripQueryAndHash(specifier: string): string {
	return specifier.split(/[?#]/, 1)[0] ?? specifier;
}

function isSkillMarkdownPath(specifier: string): boolean {
	return path.basename(stripQueryAndHash(specifier)) === 'SKILL.md';
}

interface ModuleAst {
	body: unknown[];
}

interface AstNode {
	type?: string;
	source?: { value?: unknown; start?: number; end?: number };
	attributes?: Array<{ key?: { name?: unknown; value?: unknown }; value?: { value?: unknown } }>;
}

interface MarkdownImport {
	specifier: string;
	start: number;
	end: number;
}

/** The query string of an import specifier (`'./a.md?raw'` → `'raw'`), if any. */
function importQuery(specifier: string): string | undefined {
	const index = specifier.indexOf('?');
	if (index === -1) return undefined;
	return specifier.slice(index + 1).split('#', 1)[0];
}

/**
 * Every static import whose specifier targets a `.md` file (queries included).
 * A legacy `with { type: 'markdown' | 'skill' }` attribute throws with the
 * replacement forms; other attribute types (`json`, ...) are none of ours.
 */
function collectMarkdownImports(ast: ModuleAst): MarkdownImport[] {
	const imports: MarkdownImport[] = [];
	for (const entry of ast.body) {
		const declaration = entry as AstNode;
		if (
			declaration.type !== 'ImportDeclaration' &&
			declaration.type !== 'ExportNamedDeclaration' &&
			declaration.type !== 'ExportAllDeclaration'
		)
			continue;
		const specifier = declaration.source?.value;
		if (typeof specifier !== 'string') continue;
		const legacyAttribute = declaration.attributes?.find((attribute) => {
			const key = attribute.key?.name ?? attribute.key?.value;
			const value = attribute.value?.value;
			return key === 'type' && (value === 'markdown' || value === 'skill');
		});
		if (legacyAttribute) {
			throw new Error(
				`[flue] Import attributes are no longer used for "${specifier}". ` +
					'SKILL.md imports are packaged automatically, and any other .md import loads as markdown text — ' +
					'pass it to `defineSkill({ name, description, instructions })` to build a skill from it. ' +
					'Remove the `with { type: ... }` clause.',
			);
		}
		if (!/\.md$/i.test(stripQueryAndHash(specifier))) continue;
		const start = declaration.source?.start;
		const end = declaration.source?.end;
		if (typeof start !== 'number' || typeof end !== 'number') {
			throw new Error(`[flue] Unable to transform markdown import: ${specifier}`);
		}
		imports.push({ specifier, start, end });
	}
	return imports;
}

function assertNoDynamicSkillImports(ast: ModuleAst): void {
	visitAst(ast, (node) => {
		if (node.type !== 'ImportExpression') return;
		const specifier = node.source?.value;
		if (typeof specifier === 'string' && isSkillMarkdownPath(specifier)) {
			throw new Error(
				`[flue] Dynamic skill import "${specifier}" is unsupported. Use a static SKILL.md import.`,
			);
		}
	});
}

function visitAst(value: unknown, visit: (node: AstNode) => void): void {
	if (!value || typeof value !== 'object') return;
	if (Array.isArray(value)) {
		for (const item of value) visitAst(item, visit);
		return;
	}
	const node = value as AstNode & Record<string, unknown>;
	if (typeof node.type === 'string') visit(node);
	for (const [key, child] of Object.entries(node)) {
		if (key !== 'start' && key !== 'end' && key !== 'loc') visitAst(child, visit);
	}
}
