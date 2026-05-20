import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SkillDefinition, SkillResources } from '@flue/runtime';
import { parseSkillMarkdown } from '@flue/runtime/internal';

const RESOURCE_WARNING_BYTES = 1024 * 1024;
const RESOURCE_DIRS = ['scripts', 'references', 'assets'] as const;

export async function buildSkillDefinition(skillPath: string): Promise<{
	skill: SkillDefinition;
	watchFiles: string[];
}> {
	const raw = await fs.promises.readFile(skillPath, 'utf8');
	const directoryName = path.basename(path.dirname(skillPath));
	const parsed = parseSkillMarkdown(raw, { directoryName, path: skillPath });
	const { resources, watchFiles } = await readResources(path.dirname(skillPath));
	const skill: SkillDefinition = {
		...parsed,
		resources,
		source: { kind: 'local', path: skillPath },
	};
	return { skill, watchFiles: [skillPath, ...watchFiles] };
}

async function readResources(root: string): Promise<{ resources?: SkillResources; watchFiles: string[] }> {
	const entries: { path: string }[] = [];
	const contents: Record<string, string> = {};
	const watchFiles: string[] = [];
	for (const directory of RESOURCE_DIRS) {
		const absoluteDir = path.join(root, directory);
		if (!fs.existsSync(absoluteDir)) continue;
		for (const entry of await collectFiles(absoluteDir)) {
			const bytes = await fs.promises.readFile(entry);
			if (bytes.byteLength > RESOURCE_WARNING_BYTES) {
				console.warn(`[flue] Skill resource ${entry} exceeds 1MB and will be bundled for lazy access.`);
			}
			const relative = path.relative(root, entry).replace(/\\/g, '/');
			entries.push({ path: relative });
			contents[relative] = directory === 'assets' ? bytes.toString('base64') : bytes.toString('utf8');
			watchFiles.push(entry);
		}
	}
	return entries.length > 0 ? { resources: { kind: 'lazy-local', entries, contents }, watchFiles } : { watchFiles };
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
