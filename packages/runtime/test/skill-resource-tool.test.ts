import { describe, expect, it } from 'vitest';
import { createTools } from '../src/agent.ts';
import { buildSkillByNamePrompt } from '../src/result.ts';
import type { SessionEnv, SkillDefinition } from '../src/types.ts';

const localSkill: SkillDefinition = {
	name: 'review',
	description: 'Review work.',
	body: 'Review.',
	resources: {
		kind: 'lazy-local',
		entries: [{ path: 'references/checklist.md' }, { path: 'scripts/check.ts' }],
		contents: {
			'references/checklist.md': 'Check everything.',
			'scripts/check.ts': 'export const check = true;',
		},
	},
	source: { kind: 'local', path: '/skills/review/SKILL.md' },
};

function createEnv(): SessionEnv {
	return {
		cwd: '/repo',
		resolvePath: (path) => path,
		exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
		readFile: async () => '',
		readFileBuffer: async () => new Uint8Array(),
		writeFile: async () => {},
		stat: async () => ({ isFile: true, isDirectory: false, isSymbolicLink: false, size: 0, mtime: new Date(0) }),
		readdir: async () => [],
		exists: async () => false,
		mkdir: async () => {},
		rm: async () => {},
	};
}

describe('bundled skill activation prompt', () => {
	it('lists bundled resources without injecting their contents', () => {
		const prompt = buildSkillByNamePrompt(localSkill);
		expect(prompt).toContain('<skill_instructions>');
		expect(prompt).toContain('references/checklist.md');
		expect(prompt).toContain('/.flue/skills/review/references/checklist.md');
		expect(prompt).toContain('scripts/check.ts');
		expect(prompt).not.toContain('Check everything.');
		expect(prompt).not.toContain('export const check = true;');
	});

	it('lets the standard read tool read bundled skill resource paths', async () => {
		const tools = createTools(createEnv(), { skills: { review: localSkill } });
		const read = tools.find((tool) => tool.name === 'read');
		if (!read) throw new Error('read tool missing');
		const result = await read.execute('tool', {
			path: '/.flue/skills/review/references/checklist.md',
		});
		expect(result.content[0]).toMatchObject({ text: 'Check everything.' });
	});
});
