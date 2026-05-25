import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build as viteBuild, createServer } from 'vite';
import { describe, expect, it } from 'vitest';
import {
	type PackagedSkillDirectoryPrototype,
	viteSkillReferencePlugin,
} from '../../cli/src/lib/vite-skill-reference-plugin.ts';

interface BuiltFixtureModule {
	review: {
		__flueSkillReference: true;
		id: string;
		name: string;
		description: string;
	};
	packaged(): Record<string, PackagedSkillDirectoryPrototype>;
	marker: string;
}

describe('Vite skill-reference prototype', () => {
	it('observes attributed direct imports and packages complete skill directories separately from references', async () => {
		const root = createFixtureRoot();
		writeSkill(root, 'review');
		writeModule(
			root,
			'src/entry.ts',
			`import review from '../skills/review/SKILL.md' with { type: 'skill' };\nimport { getPackagedSkills } from 'virtual:flue/packaged-skills';\nexport { review };\nexport const marker = 'direct';\nexport function packaged() { return getPackagedSkills(); }\n`,
		);
		const plugin = viteSkillReferencePlugin();
		const built = await buildFixture(root, plugin);
		const module = await importBuiltFixture(built);
		const directory = module.packaged()[module.review.id];
		if (!directory) throw new Error('Packaged skill directory missing');

		expect(plugin.getObservedSkillImports()).toHaveLength(1);
		expect(plugin.getObservedSkillImports()[0]).toMatch(/\/skills\/review\/SKILL\.md$/);
		expect(module.review).toEqual({
			__flueSkillReference: true,
			id: expect.stringContaining('skill:review:'),
			name: 'review',
			description: 'Reviews an implementation when requested.',
		});
		expect(module.review).not.toHaveProperty('body');
		expect(module.review).not.toHaveProperty('files');
		expect(Object.keys(directory.files)).toEqual([
			'LICENSE.txt',
			'SKILL.md',
			'assets/template.txt',
			'references/checklist.md',
			'scripts/inspect.py',
		]);
		expect(decode(directory.files['LICENSE.txt'])).toBe('License text\n');
		expect(plugin.getTrackedSkillFiles()).toContainEqual(expect.stringMatching(/\/skills\/review\/LICENSE\.txt$/));
	});

	it('accepts attributed barrel re-exports of skill references', async () => {
		const root = createFixtureRoot();
		writeSkill(root, 'review');
		writeModule(root, 'src/profile.ts', `export { default as review } from '../skills/review/SKILL.md' with { type: 'skill' };\n`);
		writeModule(
			root,
			'src/entry.ts',
			`import { review } from './profile.ts';\nimport { getPackagedSkills } from 'virtual:flue/packaged-skills';\nexport { review };\nexport const marker = 'barrel';\nexport function packaged() { return getPackagedSkills(); }\n`,
		);
		const module = await importBuiltFixture(await buildFixture(root, viteSkillReferencePlugin()));

		expect(module.review.name).toBe('review');
		expect(module.marker).toBe('barrel');
		expect(module.packaged()[module.review.id]).toBeDefined();
	});

	it('packages a skill reached through an ordinary transitive module graph', async () => {
		const root = createFixtureRoot();
		writeSkill(root, 'review');
		writeModule(
			root,
			'src/profile.ts',
			`import review from '../skills/review/SKILL.md' with { type: 'skill' };\nexport { review };\n`,
		);
		writeModule(root, 'src/helper.ts', `export const marker = 'helper';\n`);
		writeModule(
			root,
			'src/entry.ts',
			`import { review } from './profile.ts';\nimport { marker } from './helper.ts';\nimport { getPackagedSkills } from 'virtual:flue/packaged-skills';\nexport { review, marker };\nexport function packaged() { return getPackagedSkills(); }\n`,
		);
		const plugin = viteSkillReferencePlugin();
		const built = await buildFixture(root, plugin);
		const module = await importBuiltFixture(built);

		expect(module.marker).toBe('helper');
		expect(module.review.name).toBe('review');
		expect(Object.values(module.packaged())).toHaveLength(1);
		expect(plugin.getObservedSkillImports()).toHaveLength(1);
	});

	it('rejects unmarked SKILL.md imports without silently changing syntax', async () => {
		const root = createFixtureRoot();
		writeSkill(root, 'review');
		writeModule(root, 'src/allowed.ts', `import review from '../skills/review/SKILL.md' with { type: 'skill' };\nexport { review };\n`);
		writeModule(root, 'src/entry.ts', `import { review } from './allowed.ts';\nimport unmarked from '../skills/review/SKILL.md';\nexport { review, unmarked };\n`);

		await expect(buildFixture(root, viteSkillReferencePlugin())).rejects.toThrow('must use an import attribute');
	});

	it.each(['raw', 'url', 'flue-skill', 'unexpected'])('rejects queried SKILL.md imports with ?%s', async (query) => {
		const root = createFixtureRoot();
		writeSkill(root, 'review');
		writeModule(root, 'src/entry.ts', `import review from '../skills/review/SKILL.md?${query}';\nexport { review };\n`);

		await expect(buildFixture(root, viteSkillReferencePlugin())).rejects.toThrow('must use an import attribute');
	});

	it('reuses strict Agent Skills validation during Vite loading', async () => {
		const root = createFixtureRoot();
		writeSkill(root, 'review', 'wrong-name');
		writeModule(root, 'src/entry.ts', `import review from '../skills/review/SKILL.md' with { type: 'skill' };\nexport { review };\n`);

		await expect(buildFixture(root, viteSkillReferencePlugin())).rejects.toThrow('requires it to match directory "review"');
	});

	it('loads attributed skill imports through the Vite development module pipeline', async () => {
		const root = createFixtureRoot();
		writeSkill(root, 'review');
		writeModule(
			root,
			'src/entry.ts',
			`import review from '../skills/review/SKILL.md' with { type: 'skill' };\nimport { getPackagedSkills } from 'virtual:flue/packaged-skills';\nexport { review };\nexport function packaged() { return getPackagedSkills(); }\n`,
		);
		const plugin = viteSkillReferencePlugin();
		const server = await createServer({
			configFile: false,
			root,
			logLevel: 'silent',
			plugins: [plugin],
			server: { middlewareMode: true },
		});
		try {
			const module = (await server.ssrLoadModule('/src/entry.ts')) as BuiltFixtureModule;
			const directory = module.packaged()[module.review.id];
			if (!directory) throw new Error('Packaged skill directory missing');
			expect(module.review.name).toBe('review');
			expect(decode(directory.files['LICENSE.txt'])).toBe('License text\n');
			expect(plugin.getTrackedSkillFiles()).toContainEqual(expect.stringMatching(/\/skills\/review\/LICENSE\.txt$/));
		} finally {
			await server.close();
		}
	});

	it('removes packaged skills when development modules stop importing them', async () => {
		const root = createFixtureRoot();
		writeSkill(root, 'review');
		writeModule(
			root,
			'src/entry.ts',
			`import review from '../skills/review/SKILL.md' with { type: 'skill' };\nimport { getPackagedSkills } from 'virtual:flue/packaged-skills';\nexport { review };\nexport function packaged() { return getPackagedSkills(); }\n`,
		);
		const server = await createServer({
			configFile: false,
			root,
			logLevel: 'silent',
			plugins: [viteSkillReferencePlugin()],
			server: { middlewareMode: true },
		});
		try {
			const initial = (await server.ssrLoadModule('/src/entry.ts')) as BuiltFixtureModule;
			expect(Object.keys(initial.packaged())).toEqual([initial.review.id]);

			writeModule(
				root,
				'src/entry.ts',
				`import { getPackagedSkills } from 'virtual:flue/packaged-skills';\nexport const review = { id: 'removed' };\nexport function packaged() { return getPackagedSkills(); }\n`,
			);
			server.watcher.emit('change', fs.realpathSync.native(path.join(root, 'src/entry.ts')));
			await flushWatcher();

			const reloaded = (await server.ssrLoadModule('/src/entry.ts')) as BuiltFixtureModule;
			expect(Object.keys(reloaded.packaged())).toEqual([]);
		} finally {
			await server.close();
		}
	});

	it('invalidates changed skill metadata and complete packaged directories in Vite development', async () => {
		const root = createFixtureRoot();
		writeSkill(root, 'review');
		writeModule(
			root,
			'src/entry.ts',
			`import review from '../skills/review/SKILL.md' with { type: 'skill' };\nimport { getPackagedSkills } from 'virtual:flue/packaged-skills';\nexport { review };\nexport function packaged() { return getPackagedSkills(); }\n`,
		);
		const server = await createServer({
			configFile: false,
			root,
			logLevel: 'silent',
			plugins: [viteSkillReferencePlugin()],
			server: { middlewareMode: true },
		});
		try {
			const initial = (await server.ssrLoadModule('/src/entry.ts')) as BuiltFixtureModule;
			const initialDirectory = initial.packaged()[initial.review.id];
			if (!initialDirectory) throw new Error('Packaged skill directory missing');
			expect(decode(initialDirectory.files['LICENSE.txt'])).toBe('License text\n');

			const licensePath = path.join(root, 'skills/review/LICENSE.txt');
			fs.writeFileSync(licensePath, 'Updated license\n');
			server.watcher.emit('change', licensePath);
			await flushWatcher();
			const changedFile = (await server.ssrLoadModule('/src/entry.ts')) as BuiltFixtureModule;
			const changedFileDirectory = changedFile.packaged()[changedFile.review.id];
			if (!changedFileDirectory) throw new Error('Reloaded packaged skill directory missing');
			expect(decode(changedFileDirectory.files['LICENSE.txt'])).toBe('Updated license\n');

			const skillPath = path.join(root, 'skills/review/SKILL.md');
			fs.writeFileSync(skillPath, `---\nname: review\ndescription: Updated review instructions.\nlicense: LICENSE.txt\n---\nUse the updated checklist.\n`);
			server.watcher.emit('change', skillPath);
			await flushWatcher();
			const changedSkill = (await server.ssrLoadModule('/src/entry.ts')) as BuiltFixtureModule;
			const changedSkillDirectory = changedSkill.packaged()[changedSkill.review.id];
			if (!changedSkillDirectory) throw new Error('Changed skill directory missing');
			expect(changedSkill.review.description).toBe('Updated review instructions.');
			expect(decode(changedSkillDirectory.files['SKILL.md'])).toContain('Use the updated checklist.');

			const noticePath = path.join(root, 'skills/review/NOTICE.txt');
			fs.writeFileSync(noticePath, 'Notice text\n');
			server.watcher.emit('add', noticePath);
			await flushWatcher();
			const added = (await server.ssrLoadModule('/src/entry.ts')) as BuiltFixtureModule;
			const addedDirectory = added.packaged()[added.review.id];
			if (!addedDirectory) throw new Error('Added-file skill directory missing');
			expect(decode(addedDirectory.files['NOTICE.txt'])).toBe('Notice text\n');

			fs.rmSync(noticePath);
			server.watcher.emit('unlink', noticePath);
			await flushWatcher();
			const removed = (await server.ssrLoadModule('/src/entry.ts')) as BuiltFixtureModule;
			const removedDirectory = removed.packaged()[removed.review.id];
			if (!removedDirectory) throw new Error('Removed-file skill directory missing');
			expect(removedDirectory.files['NOTICE.txt']).toBeUndefined();

			const nestedPath = path.join(root, 'skills/review/extra/deep/note.txt');
			writeModule(root, 'skills/review/extra/deep/note.txt', 'Nested note\n');
			server.watcher.emit('add', nestedPath);
			await flushWatcher();
			const nestedAdded = (await server.ssrLoadModule('/src/entry.ts')) as BuiltFixtureModule;
			const nestedAddedDirectory = nestedAdded.packaged()[nestedAdded.review.id];
			if (!nestedAddedDirectory) throw new Error('Nested-added skill directory missing');
			expect(decode(nestedAddedDirectory.files['extra/deep/note.txt'])).toBe('Nested note\n');

			fs.rmSync(path.join(root, 'skills/review/extra'), { recursive: true });
			server.watcher.emit('unlink', nestedPath);
			await flushWatcher();
			const nestedRemoved = (await server.ssrLoadModule('/src/entry.ts')) as BuiltFixtureModule;
			const nestedRemovedDirectory = nestedRemoved.packaged()[nestedRemoved.review.id];
			if (!nestedRemovedDirectory) throw new Error('Nested-removed skill directory missing');
			expect(nestedRemovedDirectory.files['extra/deep/note.txt']).toBeUndefined();
		} finally {
			await server.close();
		}
	});
});

function createFixtureRoot(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'flue-vite-skill-reference-'));
}

function writeSkill(root: string, directoryName: string, declaredName = directoryName): void {
	writeModule(
		root,
		`skills/${directoryName}/SKILL.md`,
		`---\nname: ${declaredName}\ndescription: Reviews an implementation when requested.\nlicense: LICENSE.txt\n---\nFollow the checklist.\n`,
	);
	writeModule(root, `skills/${directoryName}/references/checklist.md`, 'Review every changed file.\n');
	writeModule(root, `skills/${directoryName}/scripts/inspect.py`, 'print("inspect")\n');
	writeModule(root, `skills/${directoryName}/assets/template.txt`, 'Template\n');
	writeModule(root, `skills/${directoryName}/LICENSE.txt`, 'License text\n');
}

function writeModule(root: string, relativePath: string, content: string): void {
	const absolutePath = path.join(root, relativePath);
	fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
	fs.writeFileSync(absolutePath, content);
}

async function flushWatcher(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 50));
}

async function buildFixture(root: string, plugin: ReturnType<typeof viteSkillReferencePlugin>): Promise<string> {
	const outDir = path.join(root, 'dist');
	await viteBuild({
		configFile: false,
		logLevel: 'silent',
		plugins: [plugin],
		build: {
			outDir,
			emptyOutDir: true,
			minify: false,
			lib: {
				entry: path.join(root, 'src/entry.ts'),
				formats: ['es'],
				fileName: () => 'entry.mjs',
			},
		},
	});
	return path.join(outDir, 'entry.mjs');
}

async function importBuiltFixture(absolutePath: string): Promise<BuiltFixtureModule> {
	return (await import(`${pathToFileURL(absolutePath).href}?time=${Date.now()}`)) as BuiltFixtureModule;
}

function decode(file: { encoding: 'base64'; content: string } | undefined): string {
	if (!file) throw new Error('Packaged file missing');
	return Buffer.from(file.content, file.encoding).toString('utf8');
}
