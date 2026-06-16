import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import { afterEach, describe, expect, it } from 'vitest';
import { importAttributePlugin } from '../src/lib/vite-import-attribute-plugin.ts';

const fixtureRoots: string[] = [];

afterEach(() => {
	for (const root of fixtureRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('importAttributePlugin()', () => {
	it('packages local and dependency skills through Vite resolution', async () => {
		const root = createFixtureRoot();
		writeSkill(path.join(root, 'skills', 'local'), 'local', 'Use the local skill.', {
			'LOCAL.txt': 'local resource',
		});
		const packageRoot = path.join(root, 'packages', 'review-skills');
		writeSkill(path.join(packageRoot, 'skills', 'review'), 'review', 'Use the package skill.', {
			'REVIEW.txt': 'package resource',
		});
		fs.writeFileSync(
			path.join(packageRoot, 'package.json'),
			JSON.stringify({
				name: '@acme/review-skills',
				type: 'module',
				exports: { './review/SKILL.md': './skills/review/SKILL.md' },
			}),
		);
		const packageLink = path.join(root, 'node_modules', '@acme', 'review-skills');
		fs.mkdirSync(path.dirname(packageLink), { recursive: true });
		fs.symlinkSync(packageRoot, packageLink, 'dir');
		const result = await buildFixture(
			root,
			`import local from './skills/local/SKILL.md' with { type: 'skill' };
import review from '@acme/review-skills/review/SKILL.md' with { type: 'skill' };
export const references = [local, review];`,
		);

		expect(result.references).toEqual([
			expect.objectContaining({ name: 'local', description: 'Use the local skill.' }),
			expect.objectContaining({ name: 'review', description: 'Use the package skill.' }),
		]);
		expect(Object.values(result.packagedSkills)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					files: expect.objectContaining({ 'LOCAL.txt': expect.anything() }),
				}),
				expect.objectContaining({
					files: expect.objectContaining({ 'REVIEW.txt': expect.anything() }),
				}),
			]),
		);
	});

	it('derives skill identity from packaged content', async () => {
		const firstRoot = createFixtureRoot();
		writeSkill(path.join(firstRoot, 'skills', 'review'), 'review', 'Review changes.', {
			'CHECKLIST.txt': 'Check correctness.',
		});
		const first = await buildFixture(
			firstRoot,
			`import review from './skills/review/SKILL.md' with { type: 'skill' };
export const references = [review];`,
		);
		const secondRoot = createFixtureRoot();
		writeSkill(path.join(secondRoot, 'elsewhere', 'review'), 'review', 'Review changes.', {
			'CHECKLIST.txt': 'Check correctness.',
		});
		const second = await buildFixture(
			secondRoot,
			`import review from './elsewhere/review/SKILL.md' with { type: 'skill' };
export const references = [review];`,
		);
		const changedRoot = createFixtureRoot();
		writeSkill(path.join(changedRoot, 'skills', 'review'), 'review', 'Review changes.', {
			'CHECKLIST.txt': 'Check correctness and security.',
		});
		const changed = await buildFixture(
			changedRoot,
			`import review from './skills/review/SKILL.md' with { type: 'skill' };
export const references = [review];`,
		);

		expect(first.references[0]?.id).toBe(second.references[0]?.id);
		expect(first.references[0]?.id).not.toBe(changed.references[0]?.id);
		expect(Object.keys(first.packagedSkills)).toEqual([first.references[0]?.id]);
	});

	it('rejects a symbolic link inside a skill directory', async () => {
		const root = createFixtureRoot();
		const skillRoot = path.join(root, 'skills', 'review');
		writeSkill(skillRoot, 'review', 'Review changes.');
		fs.writeFileSync(path.join(root, 'outside.txt'), 'outside');
		fs.symlinkSync(path.join(root, 'outside.txt'), path.join(skillRoot, 'linked.txt'));

		await expect(
			buildFixture(
				root,
				`import review from './skills/review/SKILL.md' with { type: 'skill' };
export const references = [review];`,
			),
		).rejects.toThrow('contains symbolic link "linked.txt"');
	});

	it('rejects a sensitive file inside a skill directory', async () => {
		const root = createFixtureRoot();
		writeSkill(path.join(root, 'skills', 'review'), 'review', 'Review changes.', {
			'.env': 'SECRET=value',
		});

		await expect(
			buildFixture(
				root,
				`import review from './skills/review/SKILL.md' with { type: 'skill' };
export const references = [review];`,
			),
		).rejects.toThrow('contains sensitive file ".env"');
	});
});

function createFixtureRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flue-import-attributes-'));
	fixtureRoots.push(root);
	fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ type: 'module' }));
	return root;
}

function writeSkill(
	directory: string,
	name: string,
	description: string,
	files: Record<string, string> = {},
): void {
	fs.mkdirSync(directory, { recursive: true });
	fs.writeFileSync(
		path.join(directory, 'SKILL.md'),
		`---\nname: ${name}\ndescription: ${description}\n---\nFollow these instructions.`,
	);
	for (const [relativePath, content] of Object.entries(files)) {
		const filePath = path.join(directory, relativePath);
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, content);
	}
}

async function buildFixture(
	root: string,
	source: string,
): Promise<{
	references: Array<{ id: string; name: string; description: string }>;
	packagedSkills: Record<string, { files: Record<string, unknown> }>;
}> {
	const entryPath = path.join(root, 'entry.ts');
	const output = path.join(root, 'dist');
	fs.writeFileSync(
		entryPath,
		`${source}\nimport { getPackagedSkills } from 'virtual:flue/packaged-skills';\nexport const packagedSkills = getPackagedSkills();`,
	);
	await build({
		configFile: false,
		root,
		logLevel: 'silent',
		plugins: [importAttributePlugin({ bootstrapEntries: [entryPath] })],
		build: {
			ssr: entryPath,
			outDir: output,
			emptyOutDir: true,
			rolldownOptions: { output: { entryFileNames: 'entry.mjs', format: 'es' } },
		},
	});
	return import(`${pathToFileURL(path.join(output, 'entry.mjs')).href}?${Date.now()}`);
}
