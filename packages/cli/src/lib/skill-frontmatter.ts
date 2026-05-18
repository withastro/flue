import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseFrontmatterFile } from '@flue/runtime/internal';

interface SkillResources {
	scripts?: Record<string, string>;
	references?: Record<string, string>;
	assets?: Record<string, string>;
}

interface SkillDefinition {
	name: string;
	description: string;
	body: string;
	resources?: SkillResources;
	license?: string;
	compatibility?: string;
	metadata?: Record<string, string>;
	source: { kind: 'local'; path: string };
}

const RESOURCE_WARNING_BYTES = 1024 * 1024;
const RESOURCE_DIRS = ['scripts', 'references', 'assets'] as const;

export async function buildSkillDefinition(skillPath: string): Promise<{
	skill: SkillDefinition;
	watchFiles: string[];
}> {
	const raw = await fs.promises.readFile(skillPath, 'utf8');
	const directoryName = path.basename(path.dirname(skillPath));
	const parsed = parseFrontmatterFile(raw, directoryName);
	const name = parsed.frontmatter.name?.trim();
	const description = parsed.frontmatter.description?.trim();
	if (!name) throw new Error(`[flue] Skill ${skillPath} must define frontmatter name.`);
	if (!description) throw new Error(`[flue] Skill ${skillPath} must define frontmatter description.`);
	if (name !== directoryName) {
		throw new Error(
			`[flue] Skill ${skillPath} declares name "${name}", but its directory is "${directoryName}". These must match.`,
		);
	}

	const { resources, watchFiles } = await readResources(path.dirname(skillPath));
	const skill: SkillDefinition = {
		name,
		description,
		body: parsed.body,
		resources,
		license: parsed.frontmatter.license,
		compatibility: parsed.frontmatter.compatibility,
		metadata: parseMetadata(parsed.frontmatter.metadata),
		source: { kind: 'local', path: skillPath },
	};
	return { skill, watchFiles: [skillPath, ...watchFiles] };
}

async function readResources(root: string): Promise<{ resources?: SkillResources; watchFiles: string[] }> {
	const resources: SkillResources = {};
	const watchFiles: string[] = [];
	for (const directory of RESOURCE_DIRS) {
		const absoluteDir = path.join(root, directory);
		if (!fs.existsSync(absoluteDir)) continue;
		const entries = await collectFiles(absoluteDir);
		if (entries.length === 0) continue;
		const values: Record<string, string> = {};
		for (const entry of entries) {
			const bytes = await fs.promises.readFile(entry);
			if (bytes.byteLength > RESOURCE_WARNING_BYTES) {
				console.warn(`[flue] Skill resource ${entry} exceeds 1MB and will be inlined into the bundle.`);
			}
			const relative = path.relative(absoluteDir, entry).replace(/\\/g, '/');
			values[relative] = directory === 'assets' ? bytes.toString('base64') : bytes.toString('utf8');
			watchFiles.push(entry);
		}
		resources[directory] = values;
	}
	return { resources: Object.keys(resources).length > 0 ? resources : undefined, watchFiles };
}

async function collectFiles(root: string): Promise<string[]> {
	const result: string[] = [];
	const entries = await fs.promises.readdir(root, { withFileTypes: true });
	for (const entry of entries) {
		const absolute = path.join(root, entry.name);
		if (entry.isDirectory()) result.push(...(await collectFiles(absolute)));
		else if (entry.isFile()) result.push(absolute);
	}
	return result.sort();
}

function parseMetadata(value: string | undefined): Record<string, string> | undefined {
	if (!value) return undefined;
	try {
		const parsed = JSON.parse(value);
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
		return Object.fromEntries(
			Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
		);
	} catch {
		return undefined;
	}
}
