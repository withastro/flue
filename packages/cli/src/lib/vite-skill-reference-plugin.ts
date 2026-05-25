import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseSkillMarkdown } from '@flue/runtime/internal';
import { normalizePath, type Plugin } from 'vite';

const PACKAGED_SKILLS_MODULE_ID = 'virtual:flue/packaged-skills';
const RESOLVED_PACKAGED_SKILLS_MODULE_ID = '\0virtual:flue/packaged-skills';
const SKILL_MODULE_PREFIX = '\0flue-skill:';
const SKILL_METADATA_QUERY = '?flue-skill-metadata';
const SKILL_FILE_QUERY = '?flue-skill-file';
const PACKAGED_FILE_WARNING_BYTES = 1024 * 1024;

export interface SkillReferencePrototype {
	readonly __flueSkillReference: true;
	readonly id: string;
	readonly name: string;
	readonly description: string;
}

export interface PackagedSkillFilePrototype {
	readonly encoding: 'base64';
	readonly content: string;
}

export interface PackagedSkillDirectoryPrototype {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly files: Record<string, PackagedSkillFilePrototype>;
}

export interface ViteSkillReferencePlugin extends Plugin {
	getObservedSkillImports(): readonly string[];
	getTrackedSkillFiles(): readonly string[];
}

export function viteSkillReferencePlugin(): ViteSkillReferencePlugin {
	const observedSkillImports = new Set<string>();
	const trackedSkillFiles = new Set<string>();
	const trackedSkillDirectories = new Set<string>();

	return {
		name: 'flue-skill-reference-prototype',
		enforce: 'pre',
		transform(code, id) {
			if (!/\.[cm]?[jt]sx?(?:\?|$)/i.test(id)) return null;
			const declarations = collectAttributedSkillReferences(this.parse(code) as unknown as ModuleAst);
			if (declarations.length === 0) return null;
			const importerPath = id.split('?')[0] ?? id;
			let transformed = code;
			for (const declaration of declarations.sort((a, b) => b.start - a.start)) {
				const resolvedPath = canonicalPath(path.resolve(path.dirname(importerPath), declaration.specifier));
				observedSkillImports.add(resolvedPath);
				transformed = `${transformed.slice(0, declaration.start)}${JSON.stringify(`${SKILL_MODULE_PREFIX}${resolvedPath}`)}${transformed.slice(declaration.end)}`;
			}
			return { code: transformed, map: null };
		},
		resolveId(source, importer) {
			if (source === PACKAGED_SKILLS_MODULE_ID) return RESOLVED_PACKAGED_SKILLS_MODULE_ID;
			if (source.includes('__x00__flue-skill:')) {
				return `${SKILL_MODULE_PREFIX}${source.slice(source.indexOf('__x00__flue-skill:') + '__x00__flue-skill:'.length)}`;
			}
			if (source.endsWith(SKILL_METADATA_QUERY) || source.endsWith(SKILL_FILE_QUERY)) {
				return source;
			}
			if (!importer) return null;
			if (source.startsWith(SKILL_MODULE_PREFIX)) return source;
			if (/SKILL\.md(?:[?#].*)?$/i.test(source)) {
				throw new Error(
					`[flue] Markdown import "${source}" must use an import attribute: with { type: 'skill' }.`,
				);
			}
			return null;
		},
		hotUpdate(options) {
			const changedPath = canonicalPath(options.file);

			const directory = [...trackedSkillDirectories].find((trackedDirectory) => isWithinDirectory(changedPath, trackedDirectory));
			if (directory) {
				const skillPath = `${directory}/SKILL.md`;
				const modules = [
					this.environment.moduleGraph.getModuleById(`${changedPath}${SKILL_FILE_QUERY}`),
					this.environment.moduleGraph.getModuleById(`${skillPath}${SKILL_METADATA_QUERY}`),
					this.environment.moduleGraph.getModuleById(`${SKILL_MODULE_PREFIX}${skillPath}`),
				].filter((module) => module !== undefined);
				for (const module of modules) this.environment.moduleGraph.invalidateModule(module);
				return modules;
			}
			if (!/\.[cm]?[jt]sx?$/i.test(changedPath)) return;
			const registry = this.environment.moduleGraph.getModuleById(RESOLVED_PACKAGED_SKILLS_MODULE_ID);
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
				const metadata = await readSkillMetadata(skillPath);
				return `export default ${JSON.stringify(metadata)};`;
			}
			if (id.endsWith(SKILL_FILE_QUERY)) {
				const filePath = id.slice(0, -SKILL_FILE_QUERY.length);
				const content = await fs.promises.readFile(filePath);
				if (content.byteLength > PACKAGED_FILE_WARNING_BYTES) {
					console.warn(`[flue] Skill file ${filePath} exceeds 1MB and will be packaged for lazy access.`);
				}
				return `export default ${JSON.stringify({ encoding: 'base64', content: content.toString('base64') })};`;
			}
			if (!id.startsWith(SKILL_MODULE_PREFIX)) return null;
			const skillPath = id.slice(SKILL_MODULE_PREFIX.length);
			const directory = path.dirname(skillPath);
			trackedSkillDirectories.add(canonicalPath(directory));
			const metadata = await readSkillMetadata(skillPath);
			const files = await collectFiles(directory);
			const imports = [`import metadata from ${JSON.stringify(`${skillPath}${SKILL_METADATA_QUERY}`)};`];
			const entries: string[] = [];
			for (const [index, absolutePath] of files.entries()) {
				const relativePath = normalizePath(path.relative(directory, absolutePath));
				const canonicalFilePath = canonicalPath(absolutePath);
				trackedSkillFiles.add(canonicalFilePath);
				imports.push(`import file${index} from ${JSON.stringify(`${canonicalFilePath}${SKILL_FILE_QUERY}`)};`);
				entries.push(`${JSON.stringify(relativePath)}: file${index}`);
			}
			const reference: SkillReferencePrototype = {
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
		getObservedSkillImports() {
			return [...observedSkillImports];
		},
		getTrackedSkillFiles() {
			return [...trackedSkillFiles];
		},
	};
}

async function readSkillMetadata(skillPath: string): Promise<Omit<PackagedSkillDirectoryPrototype, 'files'>> {
	const directory = path.dirname(skillPath);
	const raw = await fs.promises.readFile(skillPath, 'utf8');
	const parsed = parseSkillMarkdown(raw, {
		directoryName: path.basename(directory),
		path: skillPath,
	});
	return {
		id: `skill:${parsed.name}:${createHash('sha256').update(normalizePath(directory)).digest('hex').slice(0, 16)}`,
		name: parsed.name,
		description: parsed.description,
	};
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

function isWithinDirectory(filePath: string, directory: string): boolean {
	return filePath === directory || filePath.startsWith(`${directory}/`);
}

async function collectFiles(directory: string): Promise<string[]> {
	const files: string[] = [];
	for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
		const absolutePath = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await collectFiles(absolutePath)));
		} else if (entry.isFile()) {
			files.push(absolutePath);
		}
	}
	return files.sort();
}

interface ModuleAst {
	body: Array<{
		type: string;
		source?: { value?: unknown; start?: number; end?: number };
		attributes?: Array<{ key?: { name?: unknown; value?: unknown }; value?: { value?: unknown } }>;
	}>;
}

interface AttributedSkillReference {
	specifier: string;
	start: number;
	end: number;
}

function collectAttributedSkillReferences(ast: ModuleAst): AttributedSkillReference[] {
	const references: AttributedSkillReference[] = [];
	for (const declaration of ast.body) {
		if (declaration.type !== 'ImportDeclaration' && declaration.type !== 'ExportNamedDeclaration' && declaration.type !== 'ExportAllDeclaration') continue;
		const specifier = declaration.source?.value;
		if (typeof specifier !== 'string') continue;
		const skillAttribute = declaration.attributes?.some((attribute) => {
			const key = attribute.key?.name ?? attribute.key?.value;
			return key === 'type' && attribute.value?.value === 'skill';
		});
		if (!skillAttribute) continue;
		if (!/SKILL\.md$/i.test(specifier)) {
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
