import {
	type FauxProviderRegistration,
	fauxAssistantMessage,
	fauxToolCall,
	registerFauxProvider,
} from '@earendil-works/pi-ai';
import { afterEach, describe, expect, it } from 'vitest';
import { defineAgent, SkillNotRegisteredError } from '../src/index.ts';
import { createFlueContext } from '../src/internal.ts';
import type { SessionEnv } from '../src/types.ts';

const providers: FauxProviderRegistration[] = [];

afterEach(() => {
	for (const provider of providers.splice(0)) provider.unregister();
});

function createProvider(): FauxProviderRegistration {
	const provider = registerFauxProvider({ provider: `session-skills-test-${crypto.randomUUID()}` });
	providers.push(provider);
	return provider;
}

function createEnv({
	files = {},
	readFileCalls = [],
}: {
	files?: Record<string, string>;
	readFileCalls?: string[];
} = {}): SessionEnv {
	const normalize = (path: string) => {
		const segments: string[] = [];
		for (const segment of path.split('/')) {
			if (!segment || segment === '.') continue;
			if (segment === '..') segments.pop();
			else segments.push(segment);
		}
		return `/${segments.join('/')}`;
	};
	const resolvePath = (path: string) => normalize(path.startsWith('/') ? path : `/repo/${path}`);

	return {
		cwd: '/repo',
		resolvePath,
		exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
		readFile: async (path) => {
			readFileCalls.push(path);
			const content = files[resolvePath(path)];
			if (content === undefined) throw new Error(`missing file: ${path}`);
			return content;
		},
		readFileBuffer: async () => new Uint8Array(),
		writeFile: async () => {},
		stat: async (path) => {
			const resolved = resolvePath(path);
			return {
				isFile: Object.hasOwn(files, resolved),
				isDirectory: Object.keys(files).some((file) => file.startsWith(`${resolved}/`)),
				isSymbolicLink: false,
				size: 0,
				mtime: new Date(0),
			};
		},
		readdir: async (path) => {
			const resolved = resolvePath(path);
			const entries = new Set<string>();
			for (const file of Object.keys(files)) {
				if (!file.startsWith(`${resolved}/`)) continue;
				const entry = file.slice(resolved.length + 1).split('/')[0];
				if (entry) entries.add(entry);
			}
			return [...entries];
		},
		exists: async (path) => {
			const resolved = resolvePath(path);
			return (
				Object.hasOwn(files, resolved) ||
				Object.keys(files).some((file) => file.startsWith(`${resolved}/`))
			);
		},
		mkdir: async () => {},
		rm: async () => {},
	};
}

describe('session.skill()', () => {
	it('activates a discovered workspace skill when a registered skill name is requested', async () => {
		const provider = createProvider();
		let modelPrompt: unknown;
		provider.setResponses([
			(context) => {
				modelPrompt = context.messages.at(-1);
				return fauxAssistantMessage('Workspace review complete.');
			},
		]);
		const ctx = createFlueContext({
			id: 'workspace-skill-instance',
			env: {},
			agentConfig: {
				resolveModel: () => provider.getModel(),
			},
			createDefaultEnv: async () =>
				createEnv({
					files: {
						'/repo/.agents/skills/review/SKILL.md':
							'---\nname: review\ndescription: Review workspace changes.\n---\nRead the workspace checklist.',
					},
				}),
		});
		const harness = await ctx.initializeRootHarness(
			defineAgent(() => ({ model: `${provider.getModel().provider}/${provider.getModel().id}` })),
		);
		const session = await harness.session();

		const result = await session.skill('review');

		expect(modelPrompt).toMatchObject({
			role: 'user',
			content: [{ type: 'text', text: expect.stringContaining('Run the skill named "review".') }],
		});
		expect(result.text).toBe('Workspace review complete.');
	});

	it('skips a malformed workspace skill when another valid skill is discovered alongside it', async () => {
		const provider = createProvider();
		provider.setResponses([fauxAssistantMessage('Workspace review complete.')]);
		const ctx = createFlueContext({
			id: 'malformed-skill-instance',
			env: {},
			agentConfig: {
				resolveModel: () => provider.getModel(),
			},
			createDefaultEnv: async () =>
				createEnv({
					files: {
						'/repo/.agents/skills/review/SKILL.md':
							'---\nname: review\ndescription: Review workspace changes.\n---\nRead the workspace checklist.',
						'/repo/.agents/skills/Broken_Skill/SKILL.md':
							'---\nname: Broken_Skill\ndescription: Vendored skill with a nonconforming name.\n---\nBody.',
					},
				}),
		});
		const harness = await ctx.initializeRootHarness(
			defineAgent(() => ({ model: `${provider.getModel().provider}/${provider.getModel().id}` })),
		);
		const session = await harness.session();

		const result = await session.skill('review');

		expect(result.text).toBe('Workspace review complete.');
	});

	it('rejects an unknown skill when the requested name is not registered', async () => {
		const provider = createProvider();
		const ctx = createFlueContext({
			id: 'unknown-skill-instance',
			env: {},
			agentConfig: {
				resolveModel: () => provider.getModel(),
			},
			createDefaultEnv: async () => createEnv(),
		});
		const harness = await ctx.initializeRootHarness(
			defineAgent(() => ({ model: `${provider.getModel().provider}/${provider.getModel().id}` })),
		);
		const session = await harness.session();

		await expect(session.skill('review')).rejects.toThrow(SkillNotRegisteredError);
	});

	it('rejects duplicate skill names when workspace discovery conflicts with an agent definition', async () => {
		const provider = createProvider();
		const ctx = createFlueContext({
			id: 'duplicate-skill-instance',
			env: {},
			agentConfig: {
				resolveModel: () => provider.getModel(),
			},
			createDefaultEnv: async () =>
				createEnv({
					files: {
						'/repo/.agents/skills/review/SKILL.md':
							'---\nname: review\ndescription: Review workspace changes.\n---\nInspect the patch.',
					},
				}),
		});

		await expect(
			ctx.initializeRootHarness(
				defineAgent(() => ({
					model: `${provider.getModel().provider}/${provider.getModel().id}`,
					skills: [{ name: 'review', description: 'Review packaged changes.' }],
				})),
			),
		).rejects.toThrow(
			'[flue] Skill name "review" appears in both agent definition and workspace discovery.',
		);
	});

	it('does not expose activate_skill when the session has no available skills', async () => {
		const provider = createProvider();
		let activeToolNames: string[] = [];
		provider.setResponses([
			(context) => {
				activeToolNames = (context.tools ?? []).map((tool) => tool.name);
				return fauxAssistantMessage('No skills available.');
			},
		]);
		const ctx = createFlueContext({
			id: 'no-autonomous-skills-instance',
			env: {},
			agentConfig: {
				resolveModel: () => provider.getModel(),
			},
			createDefaultEnv: async () => createEnv(),
		});
		const harness = await ctx.initializeRootHarness(
			defineAgent(() => ({ model: `${provider.getModel().provider}/${provider.getModel().id}` })),
		);
		const session = await harness.session();

		await session.prompt('Complete the task.');

		expect(activeToolNames).not.toContain('activate_skill');
	});

	it('loads current workspace instructions when the model activates an available skill', async () => {
		const provider = createProvider();
		const files = {
			'/repo/.agents/skills/review/SKILL.md':
				'---\nname: review\ndescription: Review workspace changes.\n---\nRead the old checklist.',
			'/repo/.agents/skills/review/references/checklist.md': 'Check every changed file.',
		};
		let activateSkillTool: unknown;
		let modelToolResult: unknown;
		provider.setResponses([
			(context) => {
				activateSkillTool = (context.tools ?? []).find((tool) => tool.name === 'activate_skill');
				return fauxAssistantMessage(fauxToolCall('activate_skill', { name: 'review' }), {
					stopReason: 'toolUse',
				});
			},
			(context) => {
				modelToolResult = context.messages.at(-1);
				return fauxAssistantMessage('Workspace skill loaded.');
			},
		]);
		const ctx = createFlueContext({
			id: 'autonomous-workspace-skill-instance',
			env: {},
			agentConfig: {
				resolveModel: () => provider.getModel(),
			},
			createDefaultEnv: async () => createEnv({ files }),
		});
		const harness = await ctx.initializeRootHarness(
			defineAgent(() => ({ model: `${provider.getModel().provider}/${provider.getModel().id}` })),
		);
		files['/repo/.agents/skills/review/SKILL.md'] =
			'---\nname: review\ndescription: Review workspace changes.\n---\nRead the current checklist.';
		const session = await harness.session();

		const result = await session.prompt('Review the workspace.');

		expect(activateSkillTool).toMatchObject({
			name: 'activate_skill',
			parameters: {
				properties: { name: { const: 'review' } },
			},
		});
		expect(modelToolResult).toMatchObject({
			role: 'toolResult',
			toolName: 'activate_skill',
			content: [
				{
					type: 'text',
					text: expect.stringContaining('Read the current checklist.'),
				},
			],
			isError: false,
		});
		expect(modelToolResult).toMatchObject({
			content: [{ text: expect.stringContaining('- Base directory: /repo/.agents/skills/review') }],
		});
		expect(modelToolResult).toMatchObject({
			content: [{ text: expect.not.stringContaining('Check every changed file.') }],
		});
		expect(result.text).toBe('Workspace skill loaded.');
	});

	it('uses the name-only prompt when the model activates a metadata-only skill', async () => {
		const provider = createProvider();
		let modelToolResult: unknown;
		provider.setResponses([
			fauxAssistantMessage(fauxToolCall('activate_skill', { name: 'review' }), {
				stopReason: 'toolUse',
			}),
			(context) => {
				modelToolResult = context.messages.at(-1);
				return fauxAssistantMessage('Metadata-only skill activated.');
			},
		]);
		const ctx = createFlueContext({
			id: 'autonomous-metadata-skill-instance',
			env: {},
			agentConfig: {
				resolveModel: () => provider.getModel(),
			},
			createDefaultEnv: async () => createEnv(),
		});
		const harness = await ctx.initializeRootHarness(
			defineAgent(() => ({
				model: `${provider.getModel().provider}/${provider.getModel().id}`,
				skills: [{ name: 'review', description: 'Review changes.' }],
			})),
		);
		const session = await harness.session();

		const result = await session.prompt('Review the patch.');

		expect(modelToolResult).toMatchObject({
			role: 'toolResult',
			toolName: 'activate_skill',
			content: [{ type: 'text', text: 'Run the skill named "review".' }],
			isError: false,
		});
		expect(result.text).toBe('Metadata-only skill activated.');
	});
});
