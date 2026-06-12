import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PackagedSkillDirectory, PackagedSkillFile, SkillReference } from '@flue/runtime';
import { parseSkillMarkdown } from '@flue/runtime/internal';
import { normalizePath, type Plugin, transformWithOxc } from 'vite';

const PACKAGED_SKILLS_MODULE_ID = 'virtual:flue/packaged-skills';
const RESOLVED_PACKAGED_SKILLS_MODULE_ID = '\0virtual:flue/packaged-skills';
const SKILL_MODULE_PREFIX = '\0flue-skill:';
const ENCODED_SKILL_MODULE_PREFIX = '__x00__flue-skill:';
const SKILL_METADATA_QUERY = '?flue-skill-metadata';
const SKILL_FILE_QUERY = '?flue-skill-file';
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

export interface SkillReferencePluginOptions {
	root: string;
	bootstrapEntries?: readonly string[];
}

export function skillReferencePlugin(options: SkillReferencePluginOptions): Plugin {
	const projectRoot = canonicalPath(path.resolve(options.root));
	const bootstrapEntries = new Set(
		(options.bootstrapEntries ?? []).map((entry) => canonicalPath(path.resolve(entry))),
	);
	const internalModuleToken = randomUUID();
	const internalSkillModulePrefix = `${SKILL_MODULE_PREFIX}${internalModuleToken}:`;
	const encodedInternalSkillModulePrefix = `__x00__flue-skill:${internalModuleToken}:`;
	const trackedSkillDirectories = new Set<string>();

	return {
		name: 'flue-skill-reference',
		enforce: 'pre',
		async transform(code, id) {
			if (!/\.[cm]?[jt]sx?(?:\?|$)/i.test(id)) return null;
			const importerPath = id.split('?')[0] ?? id;
			const parseableCode = /\.[cm]?tsx?(?:\?|$)/i.test(id)
				? (await transformWithOxc(code, importerPath, {})).code
				: code;
			const ast = this.parse(parseableCode) as unknown as ModuleAst;
			assertNoDynamicSkillImports(ast);
			const declarations = collectAttributedSkillReferences(ast);
			if (declarations.length === 0) return null;
			let transformed = parseableCode;
			for (const declaration of declarations.sort((a, b) => b.start - a.start)) {
				const resolvedPath = await resolveSkillImport.call(
					this,
					declaration.specifier,
					importerPath,
					projectRoot,
				);
				const skillModuleId = `${internalSkillModulePrefix}${resolvedPath}`;
				transformed = `${transformed.slice(0, declaration.start)}${JSON.stringify(skillModuleId)}${transformed.slice(declaration.end)}`;
			}
			return { code: transformed, map: null };
		},
		resolveId(source, importer) {
			if (source === PACKAGED_SKILLS_MODULE_ID) {
				if (!isAuthorizedPackagedStoreImporter(importer, bootstrapEntries)) {
					throw new Error(
						"[flue] Packaged skill contents are runtime-owned and cannot be imported from application modules. Import SKILL.md with { type: 'skill' }.",
					);
				}
				return RESOLVED_PACKAGED_SKILLS_MODULE_ID;
			}
			const internalModuleId = decodeSkillModuleId(
				source,
				internalSkillModulePrefix,
				encodedInternalSkillModulePrefix,
			);
			if (internalModuleId) return internalModuleId;
			if (source.startsWith(SKILL_MODULE_PREFIX) || source.includes(ENCODED_SKILL_MODULE_PREFIX)) {
				throw new Error(
					"[flue] Internal packaged-skill module IDs cannot be imported directly. Use a static SKILL.md import with { type: 'skill' }.",
				);
			}
			if (source.endsWith(SKILL_METADATA_QUERY) || source.endsWith(SKILL_FILE_QUERY)) {
				if (!importer?.startsWith(internalSkillModulePrefix)) {
					throw new Error(
						"[flue] Internal packaged-skill resources cannot be imported directly. Import SKILL.md with { type: 'skill' }.",
					);
				}
				return source;
			}
			if (!importer) return null;
			if (isSkillMarkdownPath(source)) {
				throw new Error(
					`[flue] Markdown import "${source}" must use an import attribute: with { type: 'skill' }.`,
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
					this.environment.moduleGraph.getModuleById(`${changedPath}${SKILL_FILE_QUERY}`),
					this.environment.moduleGraph.getModuleById(`${skillPath}${SKILL_METADATA_QUERY}`),
					this.environment.moduleGraph.getModuleById(`${internalSkillModulePrefix}${skillPath}`),
				].filter((module) => module !== undefined);
				for (const module of modules) this.environment.moduleGraph.invalidateModule(module);
				return modules;
			}
			if (!/\.[cm]?[jt]sx?$/i.test(changedPath)) return;
			const registry = this.environment.moduleGraph.getModuleById(
				RESOLVED_PACKAGED_SKILLS_MODULE_ID,
			);
			if (!registry) return;
			this.environment.moduleGraph.invalidateModule(registry);
			return [registry, ...options.modules];
		},
		async load(id) {
			if (id === RESOLVED_PACKAGED_SKILLS_MODULE_ID) {
				return [
					'const packagedSkills = new Map();',
					'export function registerPackagedSkill(skill) { packagedSkills.set(skill.id, skill); }',
					'export function unregisterPackagedSkill(skill) { if (packagedSkills.get(skill.id) === skill) packagedSkills.delete(skill.id); }',
					'export function getPackagedSkills() { return Object.fromEntries(packagedSkills); }',
				].join('\n');
			}
			if (id.endsWith(SKILL_METADATA_QUERY)) {
				const skillPath = id.slice(0, -SKILL_METADATA_QUERY.length);
				const metadata = await readSkillMetadata(skillPath, projectRoot);
				return `export default ${JSON.stringify(metadata)};`;
			}
			if (id.endsWith(SKILL_FILE_QUERY)) {
				const filePath = id.slice(0, -SKILL_FILE_QUERY.length);
				const content = await fs.promises.readFile(filePath);
				if (content.byteLength > PACKAGED_FILE_WARNING_BYTES) {
					console.warn(
						`[flue] Skill file "${filePath}" exceeds 1MB and will be packaged into the deployed application for lazy access.`,
					);
				}
				const file: PackagedSkillFile = {
					encoding: 'base64',
					kind: isTextContent(content) ? 'text' : 'binary',
					content: content.toString('base64'),
				};
				return `export default ${JSON.stringify(file)};`;
			}
			if (!id.startsWith(internalSkillModulePrefix)) return null;
			const skillPath = id.slice(internalSkillModulePrefix.length);
			const directory = path.dirname(skillPath);
			trackedSkillDirectories.add(canonicalPath(directory));
			const metadata = await readSkillMetadata(skillPath, projectRoot);
			const files = await collectFiles(directory);
			const metadataModuleId = `${skillPath}${SKILL_METADATA_QUERY}`;
			const imports = [`import metadata from ${JSON.stringify(metadataModuleId)};`];
			const entries: string[] = [];
			for (const [index, absolutePath] of files.entries()) {
				const relativePath = normalizePath(path.relative(directory, absolutePath));
				const canonicalFilePath = canonicalPath(absolutePath);
				const fileModuleId = `${canonicalFilePath}${SKILL_FILE_QUERY}`;
				imports.push(`import file${index} from ${JSON.stringify(fileModuleId)};`);
				entries.push(`${JSON.stringify(relativePath)}: file${index}`);
			}
			const reference: SkillReference = {
				__flueSkillReference: true,
				id: metadata.id,
				name: metadata.name,
				description: metadata.description,
			};
			return [
				`import { registerPackagedSkill, unregisterPackagedSkill } from ${JSON.stringify(PACKAGED_SKILLS_MODULE_ID)};`,
				...imports,
				`const directory = { ...metadata, files: { ${entries.join(', ')} } };`,
				'registerPackagedSkill(directory);',
				'if (import.meta.hot) import.meta.hot.dispose(() => unregisterPackagedSkill(directory));',
				`const reference = ${JSON.stringify(reference)};`,
				'export default reference;',
			].join('\n');
		},
	};
}

async function readSkillMetadata(
	skillPath: string,
	projectRoot: string,
): Promise<Omit<PackagedSkillDirectory, 'files'>> {
	const directory = path.dirname(skillPath);
	const identityPath = stableSkillIdentityPath(directory, projectRoot);
	const raw = await fs.promises.readFile(skillPath, 'utf8');
	const parsed = parseSkillMarkdown(raw, {
		directoryName: path.basename(directory),
		path: skillPath,
	});
	return {
		id: `skill:${parsed.name}:${createHash('sha256').update(identityPath).digest('hex').slice(0, 16)}`,
		name: parsed.name,
		description: parsed.description,
	};
}

async function resolveSkillImport(
	this: PluginContext,
	specifier: string,
	importerPath: string,
	projectRoot: string,
): Promise<string> {
	if (isRelativeSpecifier(specifier)) {
		const authoredPath = path.resolve(path.dirname(importerPath), specifier);
		assertPackagedSkillPath(authoredPath, projectRoot);
		return canonicalPath(authoredPath);
	}

	const resolved = await this.resolve(specifier, importerPath, { skipSelf: true });
	if (!resolved) {
		throw new Error(`[flue] Unable to resolve skill import "${specifier}" from "${importerPath}".`);
	}

	const resolvedPath = canonicalPath(resolved.id.split(/[?#]/, 1)[0] ?? resolved.id);
	if (!isSkillMarkdownPath(resolvedPath)) {
		throw new Error(`[flue] Skill imports must target a SKILL.md file: ${specifier}`);
	}
	return resolvedPath;
}

function stableSkillIdentityPath(directory: string, projectRoot: string): string {
	const relativePath = normalizePath(path.relative(projectRoot, canonicalPath(directory)));
	if (relativePath !== '' && relativePath !== '..' && !relativePath.startsWith('../')) {
		return `project:${relativePath}`;
	}

	const packageRoot = findPackageRoot(directory);
	if (packageRoot) {
		const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as {
			name?: unknown;
			version?: unknown;
		};
		const packageName = typeof pkg.name === 'string' && pkg.name ? pkg.name : packageRoot;
		const packageVersion = typeof pkg.version === 'string' && pkg.version ? pkg.version : '';
		const packageRelativePath = normalizePath(path.relative(packageRoot, directory));
		return `package:${packageName}@${packageVersion}:${packageRelativePath}`;
	}

	return `external:${canonicalPath(directory)}`;
}

function assertPackagedSkillPath(skillPath: string, projectRoot: string): void {
	const normalizedSkillPath = normalizePath(path.resolve(skillPath));
	const relativePath = normalizePath(path.relative(projectRoot, normalizedSkillPath));
	if (relativePath === '..' || relativePath.startsWith('../')) {
		throw new Error(
			`[flue] Imported skill "${skillPath}" must be inside project root "${projectRoot}" because imported skills are packaged into the deployed application.`,
		);
	}
	let currentPath = projectRoot;
	for (const segment of relativePath.split('/')) {
		if (!segment) continue;
		currentPath = path.join(currentPath, segment);
		if (fs.existsSync(currentPath) && fs.lstatSync(currentPath).isSymbolicLink()) {
			throw new Error(
				`[flue] Skill import "${skillPath}" traverses symbolic link "${currentPath}", which cannot be packaged. Replace it with a regular file or directory.`,
			);
		}
	}
}

function canonicalPath(filePath: string): string {
	let unresolvedPath = filePath;
	const suffixes: string[] = [];
	while (!fs.existsSync(unresolvedPath)) {
		const parentPath = path.dirname(unresolvedPath);
		if (parentPath === unresolvedPath) return normalizePath(filePath);
		suffixes.unshift(path.basename(unresolvedPath));
		unresolvedPath = parentPath;
	}
	return normalizePath(path.join(fs.realpathSync.native(unresolvedPath), ...suffixes));
}

function findPackageRoot(directory: string): string | undefined {
	let currentPath = canonicalPath(directory);
	while (currentPath !== path.dirname(currentPath)) {
		if (fs.existsSync(path.join(currentPath, 'package.json'))) return currentPath;
		currentPath = path.dirname(currentPath);
	}
	return undefined;
}

function isRelativeSpecifier(specifier: string): boolean {
	return specifier.startsWith('.') || specifier.startsWith('/');
}

function isWithinDirectory(filePath: string, directory: string): boolean {
	return filePath === directory || filePath.startsWith(`${directory}/`);
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

function isTextContent(content: Buffer): boolean {
	if (content.includes(0)) return false;
	const text = content.toString('utf8');
	return Buffer.from(text, 'utf8').equals(content) && !text.includes('\uFFFD');
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

function isAuthorizedPackagedStoreImporter(
	importer: string | undefined,
	bootstrapEntries: Set<string>,
): boolean {
	if (!importer) return false;
	if (importer.startsWith(SKILL_MODULE_PREFIX)) return true;
	return bootstrapEntries.has(canonicalPath(importer.split('?')[0] ?? importer));
}

function isSkillMarkdownPath(specifier: string): boolean {
	return path.basename(specifier.split(/[?#]/, 1)[0] ?? '') === 'SKILL.md';
}

interface ModuleAst {
	body: unknown[];
}

interface PluginContext {
	resolve(
		source: string,
		importer?: string,
		options?: { skipSelf?: boolean },
	): Promise<{ id: string } | null>;
}

interface AstNode {
	type?: string;
	source?: { value?: unknown; start?: number; end?: number };
	attributes?: Array<{ key?: { name?: unknown; value?: unknown }; value?: { value?: unknown } }>;
}

interface AttributedSkillReference {
	specifier: string;
	start: number;
	end: number;
}

function collectAttributedSkillReferences(ast: ModuleAst): AttributedSkillReference[] {
	const references: AttributedSkillReference[] = [];
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
		const skillAttribute = declaration.attributes?.some((attribute) => {
			const key = attribute.key?.name ?? attribute.key?.value;
			return key === 'type' && attribute.value?.value === 'skill';
		});
		if (!skillAttribute) continue;
		if (!isSkillMarkdownPath(specifier)) {
			throw new Error(`[flue] Skill imports must target a SKILL.md file: ${specifier}`);
		}
		const start = declaration.source?.start;
		const end = declaration.source?.end;
		if (typeof start !== 'number' || typeof end !== 'number') {
			throw new Error(`[flue] Unable to transform skill import: ${specifier}`);
		}
		references.push({ specifier, start, end });
	}
	return references;
}

function assertNoDynamicSkillImports(ast: ModuleAst): void {
	visitAst(ast, (node) => {
		if (node.type !== 'ImportExpression') return;
		const specifier = node.source?.value;
		if (typeof specifier === 'string' && isSkillMarkdownPath(specifier)) {
			throw new Error(
				`[flue] Dynamic SKILL.md import "${specifier}" is unsupported. Use a static import with { type: 'skill' }.`,
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
