import {
	type FauxProviderRegistration,
	fauxAssistantMessage,
	fauxToolCall,
	registerFauxProvider,
} from '@earendil-works/pi-ai';
import { afterEach, describe, expect, it } from 'vitest';
import {
	defineAgent,
	defineSkill,
	SkillDefinitionValidationError,
} from '../src/index.ts';
import { createFlueContext } from '../src/internal.ts';
import type { SessionEnv } from '../src/types.ts';

const providers: FauxProviderRegistration[] = [];

afterEach(() => {
	for (const provider of providers.splice(0)) provider.unregister();
});

describe('defineSkill()', () => {
	it('returns the same deterministic reference when equivalent definitions use different key order', () => {
		const first = defineSkill({
			name: 'code-review',
			description: 'Reviews code changes. Use when evaluating a patch.',
			instructions: 'Inspect the patch.',
			metadata: { version: '1', author: 'Flue' },
			files: {
				'references/café #1?.md': 'Check errors.',
				'assets/data.bin': new Uint8Array([0, 255, 1]),
			},
		});
		const second = defineSkill({
			name: 'code-review',
			description: 'Reviews code changes. Use when evaluating a patch.',
			instructions: 'Inspect the patch.',
			metadata: { author: 'Flue', version: '1' },
			files: {
				'assets/data.bin': new Uint8Array([0, 255, 1]),
				'references/café #1?.md': 'Check errors.',
			},
		});

		expect(first).toEqual(second);
		expect(Object.isFrozen(first)).toBe(true);
	});

	it('changes the reference id when skill content changes', () => {
		const first = defineSkill({
			name: 'code-review',
			description: 'Reviews code changes.',
			instructions: 'Inspect the patch.',
		});
		const second = defineSkill({
			name: 'code-review',
			description: 'Reviews code changes.',
			instructions: 'Inspect the patch carefully.',
		});

		expect(first.id).not.toBe(second.id);
	});

	it('throws a structured error when a definition violates name and file rules', () => {
		let error: unknown;
		try {
			defineSkill({
				name: 'Café Review',
				description: 'Reviews code changes.',
				files: { '../secret.txt': 'secret', 'SKILL.md': 'override' },
			});
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(SkillDefinitionValidationError);
		expect(error).toMatchObject({
			type: 'skill_definition_validation',
			meta: {
				issues: expect.arrayContaining([
					expect.objectContaining({ path: ['name'] }),
					expect.objectContaining({ path: ['files', '../secret.txt'] }),
					expect.objectContaining({ path: ['files', 'SKILL.md'] }),
				]),
			},
		});
	});

	it('exposes packaged resources without synthesizing adapter filesystem read', async () => {
		const provider = registerFauxProvider({ provider: `define-skill-${crypto.randomUUID()}` });
		providers.push(provider);
		let activationResult: unknown;
		let readResult: unknown;
		const review = defineSkill({
			name: 'code-review',
			description: 'Reviews code changes. Use when evaluating a patch.',
			instructions: 'Inspect the patch carefully.',
			files: { 'references/checklist.md': 'Check errors.' },
		});
		const resourcePath = `/.flue/packaged-skills/${encodeURIComponent(review.id)}/references/checklist.md`;
		provider.setResponses([
			fauxAssistantMessage(fauxToolCall('activate_skill', { name: 'code-review' }), {
				stopReason: 'toolUse',
			}),
			(context) => {
				activationResult = context.messages.at(-1);
				return fauxAssistantMessage(fauxToolCall('read_skill_resource', { path: resourcePath }), {
					stopReason: 'toolUse',
				});
			},
			(context) => {
				readResult = context.messages.at(-1);
				return fauxAssistantMessage('Review complete.');
			},
		]);
		const ctx = createFlueContext({
			id: 'defined-skill-instance',
			env: {},
			agentConfig: { resolveModel: () => provider.getModel() },
			createDefaultEnv: async () => createEnv(),
		});
		const harness = await ctx.initializeRootHarness(
			defineAgent(() => ({
				model: `${provider.getModel().provider}/${provider.getModel().id}`,
				skills: [review],
				sandbox: {
					createSessionEnv: async () => createEnv(),
					tools: () => [],
				},
			})),
		);
		const session = await harness.session();

		const result = await session.prompt('Review the patch.');

		expect(activationResult).toMatchObject({
			role: 'toolResult',
			toolName: 'activate_skill',
			content: [
				{
					type: 'text',
					text: expect.stringContaining(
						`references/checklist.md → read_skill_resource ${resourcePath}`,
					),
				},
			],
			isError: false,
		});
		expect(activationResult).toMatchObject({
			content: [{ text: expect.not.stringContaining('Check errors.') }],
		});
		expect(readResult).toMatchObject({
			role: 'toolResult',
			toolName: 'read_skill_resource',
			content: [{ type: 'text', text: 'Check errors.' }],
			isError: false,
		});
		expect(result.text).toBe('Review complete.');
	});

	it('does not fall through to the sandbox for reserved packaged paths', async () => {
		const provider = registerFauxProvider({ provider: `define-skill-${crypto.randomUUID()}` });
		providers.push(provider);
		const readFileCalls: string[] = [];
		const review = defineSkill({
			name: 'code-review',
			description: 'Reviews code changes.',
			instructions: 'Inspect the patch.',
		});
		provider.setResponses([
			fauxAssistantMessage(
				fauxToolCall('read', {
					path: `/.flue/packaged-skills/${encodeURIComponent(review.id)}/missing.md`,
				}),
				{ stopReason: 'toolUse' },
			),
			fauxAssistantMessage('Missing resource rejected.'),
		]);
		const ctx = createFlueContext({
			id: 'defined-skill-reserved-path-instance',
			env: {},
			agentConfig: { resolveModel: () => provider.getModel() },
			createDefaultEnv: async () => createEnv(readFileCalls),
		});
		const harness = await ctx.initializeRootHarness(
			defineAgent(() => ({ model: `${provider.getModel().provider}/${provider.getModel().id}` })),
		);
		const session = await harness.session();

		const result = await session.skill(review);

		expect(readFileCalls).toEqual([]);
		expect(result.text).toBe('Missing resource rejected.');
	});

	it('supports direct invocation without agent registration', async () => {
		const provider = registerFauxProvider({ provider: `define-skill-${crypto.randomUUID()}` });
		providers.push(provider);
		let modelPrompt: unknown;
		provider.setResponses([
			(context) => {
				modelPrompt = context.messages.at(-1);
				return fauxAssistantMessage('Review complete.');
			},
		]);
		const review = defineSkill({
			name: 'code-review',
			description: 'Reviews code changes.',
			instructions: 'Inspect the direct invocation.',
		});
		const ctx = createFlueContext({
			id: 'direct-defined-skill-instance',
			env: {},
			agentConfig: { resolveModel: () => provider.getModel() },
			createDefaultEnv: async () => createEnv(),
		});
		const harness = await ctx.initializeRootHarness(
			defineAgent(() => ({ model: `${provider.getModel().provider}/${provider.getModel().id}` })),
		);
		const session = await harness.session();

		await session.skill(review);

		expect(modelPrompt).toMatchObject({
			content: [{ text: expect.stringContaining('Inspect the direct invocation.') }],
		});
	});
});

function createEnv(readFileCalls: string[] = []): SessionEnv {
	return {
		cwd: '/repo',
		resolvePath: (path) => path,
		exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
		readFile: async (path) => {
			readFileCalls.push(path);
			return '';
		},
		readFileBuffer: async () => new Uint8Array(),
		writeFile: async () => {},
		stat: async () => ({ isFile: false, isDirectory: false, isSymbolicLink: false }),
		readdir: async () => [],
		exists: async () => false,
		mkdir: async () => {},
		rm: async () => {},
	};
}
