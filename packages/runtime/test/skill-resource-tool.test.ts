import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { describe, expect, it } from 'vitest';
import { createTools } from '../src/agent.ts';
import { Harness } from '../src/harness.ts';
import { buildPackagedSkillPrompt, buildSkillByNamePrompt } from '../src/result.ts';
import { InMemorySessionStore } from '../src/session.ts';
import type { AgentConfig, PackagedSkillDirectory, SessionEnv, SkillDefinition, SkillReference } from '../src/types.ts';

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

const packagedReference: SkillReference = {
	__flueSkillReference: true,
	id: 'skill:review:fixture',
	name: 'review',
	description: 'Review work.',
};

const packagedDirectory: PackagedSkillDirectory = {
	id: packagedReference.id,
	name: packagedReference.name,
	description: packagedReference.description,
	files: {
		'SKILL.md': { encoding: 'base64', content: Buffer.from('---\nname: review\ndescription: Review work.\n---\nReview.').toString('base64') },
		'LICENSE.txt': { encoding: 'base64', content: Buffer.from('License terms.').toString('base64') },
		'references/checklist.md': { encoding: 'base64', content: Buffer.from('Check everything.').toString('base64') },
		'assets/icon.bin': { encoding: 'base64', content: Buffer.from([0xff, 0x00, 0x80]).toString('base64') },
		'assets/large.bin': { encoding: 'base64', content: Buffer.alloc(60 * 1024, 0xa5).toString('base64') },
	},
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

function createAgentConfig(skills: AgentConfig['skills']): AgentConfig {
	const model = { id: 'test-model', provider: 'test', api: 'test' } as never;
	return {
		systemPrompt: '',
		skills,
		packagedSkills: { [packagedReference.id]: packagedDirectory },
		model,
		resolveModel: () => model,
	};
}

function assistantMessage(text: string): AgentMessage {
	return {
		role: 'assistant',
		content: [{ type: 'text', text }],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		timestamp: Date.now(),
	} as AgentMessage;
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

	it('activates a packaged reference from SKILL.md while keeping raw files lazy', () => {
		const prompt = buildPackagedSkillPrompt(packagedReference, packagedDirectory);
		expect(prompt).toContain('<skill_instructions>\nReview.\n</skill_instructions>');
		expect(prompt).toContain('LICENSE.txt');
		expect(prompt).toContain('/.flue/packaged-skills/skill%3Areview%3Afixture/LICENSE.txt');
		expect(prompt).not.toContain('License terms.');
	});

	it('lets the standard read tool read arbitrary packaged skill files and preserve binary assets', async () => {
		const tools = createTools(createEnv(), { packagedSkills: { [packagedReference.id]: packagedDirectory } });
		const read = tools.find((tool) => tool.name === 'read');
		if (!read) throw new Error('read tool missing');
		const result = await read.execute('tool', { path: '/.flue/packaged-skills/skill%3Areview%3Afixture/LICENSE.txt' });
		const binary = await read.execute('tool', { path: '/.flue/packaged-skills/skill%3Areview%3Afixture/assets/icon.bin' });
		const largeFirst = await read.execute('tool', { path: '/.flue/packaged-skills/skill%3Areview%3Afixture/assets/large.bin' });
		const largeFirstText = largeFirst.content[0]?.type === 'text' ? largeFirst.content[0].text : '';
		const nextOffset = Number(/Use offset=(\d+) to continue/.exec(largeFirstText)?.[1]);
		const largeSecond = await read.execute('tool', { path: '/.flue/packaged-skills/skill%3Areview%3Afixture/assets/large.bin', offset: nextOffset });
		const largeSecondText = largeSecond.content[0]?.type === 'text' ? largeSecond.content[0].text : '';
		const decodedLarge = Buffer.from(`${largeFirstText}\n${largeSecondText}`.replace(/\n\n\[Showing[^]*?continue\.\]/g, '').replace(/\n/g, ''), 'base64');
		expect(result.content[0]).toMatchObject({ text: 'License terms.' });
		expect(binary.content[0]).toMatchObject({ text: '/wCA' });
		expect(nextOffset).toBeGreaterThan(1);
		expect(decodedLarge).toEqual(Buffer.alloc(60 * 1024, 0xa5));
	});

	it('rejects activation when a reference has no packaged directory', () => {
		expect(() => buildPackagedSkillPrompt(packagedReference, { ...packagedDirectory, files: {} })).toThrow('missing SKILL.md');
	});

	it('activates a direct packaged reference through session.skill and scopes its files to that operation', async () => {
		const harness = new Harness('instance', 'default', createAgentConfig({}), createEnv(), new InMemorySessionStore());
		const session = await harness.session();
		const agent = Reflect.get(session, 'harness') as {
			state: { messages: AgentMessage[]; tools: Array<{ name: string; execute(id: string, params: unknown): Promise<{ content: Array<{ text: string }> }> }> };
			prompt(text: string): Promise<void>;
			waitForIdle(): Promise<void>;
		};
		let prompt = '';
		let fileContents = '';
		agent.prompt = async (text) => {
			prompt = text;
			const read = agent.state.tools.find((tool) => tool.name === 'read');
			if (!read) throw new Error('read tool missing');
			const output = await read.execute('tool', { path: '/.flue/packaged-skills/skill%3Areview%3Afixture/LICENSE.txt' });
			fileContents = output.content[0]?.text ?? '';
			agent.state.messages.push(assistantMessage('reviewed'));
		};
		agent.waitForIdle = async () => {};

		await session.skill(packagedReference);

		expect(prompt).toContain('<skill_instructions>\nReview.\n</skill_instructions>');
		expect(fileContents).toBe('License terms.');
	});

	it('exposes active packaged files through connector-backed sessions', async () => {
		const harness = new Harness(
			'instance',
			'default',
			createAgentConfig({}),
			createEnv(),
			new InMemorySessionStore(),
			undefined,
			[],
			() => [{
				name: 'code',
				label: 'Code',
				description: 'Execute code.',
				parameters: {},
				execute: async () => ({ content: [{ type: 'text', text: 'code' }], details: {} }),
			}],
		);
		const session = await harness.session();
		const agent = Reflect.get(session, 'harness') as {
			state: { messages: AgentMessage[]; tools: Array<{ name: string; execute(id: string, params: unknown): Promise<{ content: Array<{ text: string }> }> }> };
			prompt(text: string): Promise<void>;
			waitForIdle(): Promise<void>;
		};
		let fileContents = '';
		agent.prompt = async () => {
			const read = agent.state.tools.find((tool) => tool.name === 'read');
			if (!read) throw new Error('read tool missing');
			const output = await read.execute('tool', { path: '/.flue/packaged-skills/skill%3Areview%3Afixture/LICENSE.txt' });
			fileContents = output.content[0]?.text ?? '';
			agent.state.messages.push(assistantMessage('reviewed'));
		};
		agent.waitForIdle = async () => {};

		await session.skill(packagedReference);

		expect(fileContents).toBe('License terms.');
	});

	it('does not grant ordinary filesystem reads to connectors that omit read', async () => {
		const env = createEnv();
		env.readFile = async () => 'Sensitive contents.';
		const harness = new Harness(
			'instance',
			'default',
			createAgentConfig({}),
			env,
			new InMemorySessionStore(),
			undefined,
			[],
			() => [{
				name: 'code',
				label: 'Code',
				description: 'Execute code.',
				parameters: {},
				execute: async () => ({ content: [{ type: 'text', text: 'code' }], details: {} }),
			}],
		);
		const session = await harness.session();
		const agent = Reflect.get(session, 'harness') as {
			state: { messages: AgentMessage[]; tools: Array<{ name: string; execute(id: string, params: unknown): Promise<{ content: Array<{ text: string }> }> }> };
			prompt(text: string): Promise<void>;
			waitForIdle(): Promise<void>;
		};
		let denied = false;
		agent.prompt = async () => {
			const read = agent.state.tools.find((tool) => tool.name === 'read');
			if (!read) throw new Error('read tool missing');
			try {
				await read.execute('tool', { path: '/secret.txt' });
			} catch {
				denied = true;
			}
			agent.state.messages.push(assistantMessage('reviewed'));
		};
		agent.waitForIdle = async () => {};

		await session.skill(packagedReference);

		expect(denied).toBe(true);
	});

	it('selects directly activated packaged files by reference id when names collide', async () => {
		const registeredReference: SkillReference = { ...packagedReference, id: 'skill:review:registered' };
		const registeredDirectory: PackagedSkillDirectory = {
			...packagedDirectory,
			id: registeredReference.id,
			files: {
				...packagedDirectory.files,
				'LICENSE.txt': { encoding: 'base64', content: Buffer.from('Registered terms.').toString('base64') },
			},
		};
		const config = createAgentConfig({ review: registeredReference });
		config.packagedSkills = {
			[packagedReference.id]: packagedDirectory,
			[registeredReference.id]: registeredDirectory,
		};
		const harness = new Harness('instance', 'default', config, createEnv(), new InMemorySessionStore());
		const session = await harness.session();
		const agent = Reflect.get(session, 'harness') as {
			state: { messages: AgentMessage[]; tools: Array<{ name: string; execute(id: string, params: unknown): Promise<{ content: Array<{ text: string }> }> }> };
			prompt(text: string): Promise<void>;
			waitForIdle(): Promise<void>;
		};
		let activatedFile = '';
		agent.prompt = async () => {
			const read = agent.state.tools.find((tool) => tool.name === 'read');
			if (!read) throw new Error('read tool missing');
			const output = await read.execute('tool', { path: '/.flue/packaged-skills/skill%3Areview%3Afixture/LICENSE.txt' });
			activatedFile = output.content[0]?.text ?? '';
			agent.state.messages.push(assistantMessage('reviewed'));
		};
		agent.waitForIdle = async () => {};

		await session.skill(packagedReference);

		expect(activatedFile).toBe('License terms.');
	});

	it('does not expose imported packaged files to ordinary prompts unless the reference is registered', async () => {
		const harness = new Harness('instance', 'default', createAgentConfig({}), createEnv(), new InMemorySessionStore());
		const session = await harness.session();
		const agent = Reflect.get(session, 'harness') as {
			state: { messages: AgentMessage[]; tools: Array<{ name: string; execute(id: string, params: unknown): Promise<{ content: Array<{ text: string }> }> }> };
			prompt(text: string): Promise<void>;
			waitForIdle(): Promise<void>;
		};
		let fileContents = '';
		agent.prompt = async () => {
			const read = agent.state.tools.find((tool) => tool.name === 'read');
			if (!read) throw new Error('read tool missing');
			const output = await read.execute('tool', { path: '/.flue/packaged-skills/skill%3Areview%3Afixture/LICENSE.txt' });
			fileContents = output.content[0]?.text ?? '';
			agent.state.messages.push(assistantMessage('done'));
		};
		agent.waitForIdle = async () => {};

		await session.prompt('hello');

		expect(fileContents).not.toContain('License terms.');
	});
});
