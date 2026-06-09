import { describe, expect, it } from 'vite-plus/test';
import { parseSkillMarkdown } from '../src/skill-frontmatter.ts';

describe('parseSkillMarkdown()', () => {
	it('trims required strings and body while preserving supported optional fields when SKILL markdown is valid', () => {
		expect(
			parseSkillMarkdown(
				[
					'---',
					"name: '  pdf-processing  '",
					"description: '  Process PDF files when documents need extraction.  '",
					"license: '  Apache-2.0  '",
					"compatibility: '  Modern runtimes  '",
					'metadata:',
					'  author: flue',
					'  version: "1.0"',
					"allowed-tools: '  Read   Bash(git:*)  '",
					'---',
					'',
					'  Use the PDF process.  ',
				].join('\n'),
				{
					directoryName: 'pdf-processing',
					path: '/skills/pdf-processing/SKILL.md',
				},
			),
		).toEqual({
			name: 'pdf-processing',
			description: 'Process PDF files when documents need extraction.',
			body: 'Use the PDF process.',
			license: 'Apache-2.0',
			compatibility: 'Modern runtimes',
			metadata: { author: 'flue', version: '1.0' },
			allowedTools: ['Read', 'Bash(git:*)'],
		});
	});

	it('rejects missing frontmatter when SKILL markdown has no YAML block', () => {
		expect(() =>
			parseSkillMarkdown('# PDF processing\n\nUse the PDF process.', {
				directoryName: 'pdf-processing',
				path: '/skills/pdf-processing/SKILL.md',
			}),
		).toThrow(
			'[flue] Skill /skills/pdf-processing/SKILL.md is missing YAML frontmatter. Start SKILL.md with "---", include "name" and "description", then close the block with "---".',
		);
	});

	it('rejects invalid YAML when SKILL frontmatter cannot be parsed', () => {
		expect(() =>
			parseSkillMarkdown('---\nname: [\ndescription: Useful.\n---\nBody', {
				directoryName: 'pdf-processing',
				path: '/skills/pdf-processing/SKILL.md',
			}),
		).toThrow('[flue] Skill /skills/pdf-processing/SKILL.md has invalid YAML frontmatter.');
	});

	it('rejects a non-mapping document when SKILL frontmatter is not an object', () => {
		expect(() =>
			parseSkillMarkdown('---\n- pdf-processing\n- Useful.\n---\nBody', {
				directoryName: 'pdf-processing',
				path: '/skills/pdf-processing/SKILL.md',
			}),
		).toThrow('[flue] Skill /skills/pdf-processing/SKILL.md frontmatter must be a YAML mapping.');
	});

	it('rejects a missing skill name when SKILL frontmatter is parsed', () => {
		expect(() =>
			parseSkillMarkdown('---\ndescription: Useful.\n---\nBody', {
				directoryName: 'pdf-processing',
				path: '/skills/pdf-processing/SKILL.md',
			}),
		).toThrow(
			'[flue] Skill /skills/pdf-processing/SKILL.md must define frontmatter name as a non-empty string.',
		);
	});

	it('rejects a blank skill name when SKILL frontmatter is parsed', () => {
		expect(() =>
			parseSkillMarkdown("---\nname: '   '\ndescription: Useful.\n---\nBody", {
				directoryName: 'pdf-processing',
				path: '/skills/pdf-processing/SKILL.md',
			}),
		).toThrow(
			'[flue] Skill /skills/pdf-processing/SKILL.md must define frontmatter name as a non-empty string.',
		);
	});

	it('rejects a missing skill description when SKILL frontmatter is parsed', () => {
		expect(() =>
			parseSkillMarkdown('---\nname: pdf-processing\n---\nBody', {
				directoryName: 'pdf-processing',
				path: '/skills/pdf-processing/SKILL.md',
			}),
		).toThrow(
			'[flue] Skill /skills/pdf-processing/SKILL.md must define frontmatter description as a non-empty string.',
		);
	});

	it('rejects a blank skill description when SKILL frontmatter is parsed', () => {
		expect(() =>
			parseSkillMarkdown("---\nname: pdf-processing\ndescription: '   '\n---\nBody", {
				directoryName: 'pdf-processing',
				path: '/skills/pdf-processing/SKILL.md',
			}),
		).toThrow(
			'[flue] Skill /skills/pdf-processing/SKILL.md must define frontmatter description as a non-empty string.',
		);
	});

	it('rejects an invalid skill name when frontmatter violates Agent Skills naming rules', () => {
		expect(() =>
			parseSkillMarkdown('---\nname: PDF-processing\ndescription: Useful.\n---\nBody', {
				directoryName: 'PDF-processing',
				path: '/skills/PDF-processing/SKILL.md',
			}),
		).toThrow(
			'[flue] Skill /skills/PDF-processing/SKILL.md frontmatter name "PDF-processing" must contain only lowercase letters, numbers, and single internal hyphens. Use a spec-compliant value such as "review-pr".',
		);
	});

	it('rejects a directory mismatch when a skill name differs from its directory', () => {
		expect(() =>
			parseSkillMarkdown('---\nname: pdf-processing\ndescription: Useful.\n---\nBody', {
				directoryName: 'document-processing',
				path: '/skills/document-processing/SKILL.md',
			}),
		).toThrow(
			'[flue] Skill /skills/document-processing/SKILL.md declares frontmatter name "pdf-processing", but Agent Skills requires it to match directory "document-processing"; names must match. Rename the directory or change "name" so they match.',
		);
	});

	it('rejects a description longer than 1024 characters when SKILL frontmatter is parsed', () => {
		expect(() =>
			parseSkillMarkdown(`---\nname: pdf-processing\ndescription: ${'a'.repeat(1025)}\n---\nBody`, {
				directoryName: 'pdf-processing',
				path: '/skills/pdf-processing/SKILL.md',
			}),
		).toThrow(
			'[flue] Skill /skills/pdf-processing/SKILL.md frontmatter description exceeds the 1024-character Agent Skills limit. Shorten "description" to a concise one-line summary.',
		);
	});

	it('parses allowed tools when frontmatter provides a whitespace-separated list', () => {
		expect(
			parseSkillMarkdown(
				'---\nname: pdf-processing\ndescription: Useful.\nallowed-tools: "Read\\tBash(git:*)\\nWrite"\n---\nBody',
				{
					directoryName: 'pdf-processing',
					path: '/skills/pdf-processing/SKILL.md',
				},
			).allowedTools,
		).toEqual(['Read', 'Bash(git:*)', 'Write']);
	});
});
