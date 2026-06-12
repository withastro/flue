import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { build } from '../../cli/src/lib/build.ts';

const fixtureRoots: string[] = [];
const repositoryRoot = path.resolve(import.meta.dirname, '../../..');

afterEach(() => {
	for (const root of fixtureRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('skill package imports', () => {
	it('packages a skill imported from a symlinked dependency when building for node', async () => {
		const root = createFixtureRoot();
		writeDependencySkillPackage(root);
		writeAgentImportingDependencySkill(root);

		await build({
			root,
			sourceRoot: root,
			output: path.join(root, 'dist'),
			target: 'node',
		});

		const server = fs.readFileSync(path.join(root, 'dist', 'server.mjs'), 'utf8');
		expect(server).toContain('Review package changes.');
	});
});

function createFixtureRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flue-skill-imports-'));
	fixtureRoots.push(root);
	const flueScope = path.join(root, 'node_modules', '@flue');
	fs.mkdirSync(flueScope, { recursive: true });
	fs.symlinkSync(path.join(repositoryRoot, 'packages', 'runtime'), path.join(flueScope, 'runtime'), 'dir');
	fs.writeFileSync(
		path.join(root, 'package.json'),
		JSON.stringify({ type: 'module', dependencies: { '@flue/runtime': 'workspace:*' } }),
	);
	return root;
}

function writeDependencySkillPackage(root: string): void {
	const packageRoot = path.join(root, 'packages', 'review-skills');
	fs.mkdirSync(path.join(packageRoot, 'skills', 'review'), { recursive: true });
	fs.writeFileSync(
		path.join(packageRoot, 'package.json'),
		JSON.stringify({
			name: '@acme/review-skills',
			version: '1.0.0',
			type: 'module',
			exports: { './skills/review/SKILL.md': './skills/review/SKILL.md' },
		}),
	);
	fs.writeFileSync(
		path.join(packageRoot, 'skills', 'review', 'SKILL.md'),
		'---\nname: review\ndescription: Review package changes.\n---\nInspect the imported package skill.',
	);

	const acmeScope = path.join(root, 'node_modules', '@acme');
	fs.mkdirSync(acmeScope, { recursive: true });
	fs.symlinkSync(packageRoot, path.join(acmeScope, 'review-skills'), 'dir');
}

function writeAgentImportingDependencySkill(root: string): void {
	fs.mkdirSync(path.join(root, 'agents'), { recursive: true });
	fs.writeFileSync(
		path.join(root, 'agents', 'assistant.mjs'),
		`import { createAgent } from '@flue/runtime';
import review from '@acme/review-skills/skills/review/SKILL.md' with { type: 'skill' };

export default createAgent(() => ({
	model: 'anthropic/claude-haiku-4-5',
	skills: [review],
}));
`,
	);
}
