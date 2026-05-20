import { describe, expect, it } from 'vitest';
import { parseSkillMarkdown } from '../src/skill-frontmatter.ts';

const options = { directoryName: 'pdf-processing', path: '/skills/pdf-processing/SKILL.md' };

describe('parseSkillMarkdown', () => {
	it('parses supported Agent Skills frontmatter', () => {
		const parsed = parseSkillMarkdown(
			[
				'---',
				'name: pdf-processing',
				'description: Process PDF files when documents need extraction.',
				'license: Apache-2.0',
				'compatibility: Modern runtimes',
				'metadata:',
				'  author: flue',
				'  version: "1.0"',
				'allowed-tools: Read Bash(git:*)',
				'---',
				'',
				'Use the PDF process.',
			].join('\n'),
			options,
		);
		expect(parsed).toEqual({
			name: 'pdf-processing',
			description: 'Process PDF files when documents need extraction.',
			body: 'Use the PDF process.',
			license: 'Apache-2.0',
			compatibility: 'Modern runtimes',
			metadata: { author: 'flue', version: '1.0' },
			allowedTools: ['Read', 'Bash(git:*)'],
		});
	});

	it.each(['PDF', '-pdf', 'pdf-', 'pdf--processing'])('rejects invalid skill name %s', (name) => {
		expect(() =>
			parseSkillMarkdown(`---\nname: ${name}\ndescription: Useful.\n---\nBody`, {
				directoryName: name,
				path: `/skills/${name}/SKILL.md`,
			}),
		).toThrow('must contain only lowercase letters');
	});

	it('requires names to match the owning directory', () => {
		expect(() => parseSkillMarkdown('---\nname: other\ndescription: Useful.\n---\nBody', options)).toThrow(
			'must match',
		);
	});

	it('rejects non-string metadata values', () => {
		expect(() =>
			parseSkillMarkdown(
				'---\nname: pdf-processing\ndescription: Useful.\nmetadata:\n  revision: 1\n---\nBody',
				options,
			),
		).toThrow('Quote scalar values such as version: "1.0"');
	});
});
