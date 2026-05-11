import assert from 'node:assert/strict';
import test from 'node:test';
import {
	type ContextSource,
	discoverSessionContext,
	resolveSkillFilePath,
} from './context.ts';

test('discovers project context from a read-only ContextSource', async () => {
	const source = createMemoryContextSource();

	const context = await discoverSessionContext(source);

	assert.equal(context.skills.review?.name, 'review');
	assert.equal(context.skills.review?.description, 'review a patch');
	assert.match(context.systemPrompt, /Use repo conventions\./);
	assert.match(context.systemPrompt, /Available Skills/);
	assert.match(context.systemPrompt, /\*\*review\*\* — review a patch/);
	assert.match(context.systemPrompt, /Working directory: \/workspace/);
	assert.match(context.systemPrompt, /Directory structure:\nAGENTS\.md\n\.agents/);
});

test('resolves path-based skills through ContextSource', async () => {
	const source = createMemoryContextSource();

	await assert.doesNotReject(async () => {
		assert.equal(
			await resolveSkillFilePath(source, source.cwd, 'review/SKILL.md'),
			'/workspace/.agents/skills/review/SKILL.md',
		);
	});
	assert.equal(await resolveSkillFilePath(source, source.cwd, 'missing/SKILL.md'), null);
});

function createMemoryContextSource(): ContextSource {
	const directories = new Set([
		'/workspace',
		'/workspace/.agents',
		'/workspace/.agents/skills',
		'/workspace/.agents/skills/review',
	]);
	const files = new Map([
		['/workspace/AGENTS.md', 'Use repo conventions.'],
		[
			'/workspace/.agents/skills/review/SKILL.md',
			`---
name: review
description: review a patch
---

Read the diff carefully.`,
		],
	]);
	const normalize = (path: string) => (path.startsWith('/') ? path : `/workspace/${path}`);

	return {
		cwd: '/workspace',
		async readFile(path) {
			const normalized = normalize(path);
			const content = files.get(normalized);
			if (content === undefined) throw new Error(`missing file: ${normalized}`);
			return content;
		},
		async stat(path) {
			const normalized = normalize(path);
			return {
				isFile: files.has(normalized),
				isDirectory: directories.has(normalized),
				isSymbolicLink: false,
				size: files.get(normalized)?.length ?? 0,
				mtime: new Date(0),
			};
		},
		async readdir(path) {
			const normalized = normalize(path);
			if (normalized === '/workspace') return ['AGENTS.md', '.agents'];
			if (normalized === '/workspace/.agents/skills') return ['review'];
			return [];
		},
		async exists(path) {
			const normalized = normalize(path);
			return files.has(normalized) || directories.has(normalized);
		},
		resolvePath: normalize,
	};
}
