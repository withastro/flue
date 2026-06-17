import { randomUUID } from 'node:crypto';
import { createFlueClient } from '@flue/sdk';
import { expect } from 'vitest';
import { createHarness, createJudge, describeEval, type JudgeContext } from 'vitest-evals';

type ClassificationCategory = 'billing' | 'technical' | 'account' | 'other';
type ClassificationPriority = 'low' | 'medium' | 'high';

type ClassificationInput = {
	message: string;
};

type ClassificationOutput = {
	category: ClassificationCategory;
	priority: ClassificationPriority;
	summary: string;
};

type ClassificationMetadata = {
	expectedCategory?: ClassificationCategory;
};

type WorkflowResponse = {
	result: ClassificationOutput;
	runId: string;
	streamUrl: string;
	offset: string;
};

type AgentInput = {
	message: string;
};

type AgentOutput = {
	instanceId: string;
	text: string;
};

type AgentPromptPayload = {
	text?: unknown;
};

const baseUrl = (process.env.FLUE_EVAL_BASE_URL ?? 'http://localhost:3583').replace(/\/+$/, '');
const client = createFlueClient({ baseUrl });

const workflowHarness = createHarness<
	ClassificationInput,
	ClassificationOutput,
	ClassificationMetadata
>({
	name: 'flue-workflow-http',
	run: async ({ input, signal, setArtifact }) => {
		const response = await fetch(`${baseUrl}/workflows/classify?wait=result`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(input),
			signal,
		});
		const body = await readJson<WorkflowResponse>(response);

		setArtifact('workflow', 'classify');
		setArtifact('runId', body.runId);
		setArtifact('streamUrl', body.streamUrl);
		setArtifact('offset', body.offset);

		return { output: body.result };
	},
});

const agentHarness = createHarness<AgentInput, AgentOutput>({
	name: 'flue-agent-sdk',
	run: async ({ input, signal, setArtifact }) => {
		const instanceId = `support-eval-${randomUUID()}`;
		const response = await client.agents.prompt('support', instanceId, {
			message: input.message,
			signal,
		});
		const result = response.result as AgentPromptPayload;
		const text = typeof result.text === 'string' ? result.text : JSON.stringify(response.result);

		setArtifact('agent', 'support');
		setArtifact('instanceId', instanceId);
		setArtifact('streamUrl', response.streamUrl);
		setArtifact('offset', response.offset);

		return { output: { instanceId, text } };
	},
});

const classificationRubricJudge = createJudge(
	'classification-rubric',
	async (ctx: JudgeContext<ClassificationInput, ClassificationOutput, ClassificationMetadata>) => {
		const expectedCategory = ctx.metadata.expectedCategory;
		const correctCategory =
			expectedCategory === undefined || ctx.output.category === expectedCategory;
		const hasSummary = ctx.output.summary.trim().length > 0;

		return {
			score: correctCategory && hasSummary ? 1 : 0,
			metadata: {
				expectedCategory: expectedCategory ?? null,
				actualCategory: ctx.output.category,
				hasSummary,
			},
		};
	},
);

describeEval('classify workflow', { harness: workflowHarness }, (it) => {
	it('returns billing triage when the request is about duplicate charges', async ({ run }) => {
		const result = await run(
			{ message: 'I was charged twice for invoice INV-123 and need help with a refund.' },
			{ metadata: { expectedCategory: 'billing' } },
		);

		expect(result.output).toMatchObject({ category: 'billing' });
		expect(['low', 'medium', 'high']).toContain(result.output.priority);
		expect(result.output.summary.trim().length).toBeGreaterThan(0);

		if (process.env.FLUE_EVAL_WITH_JUDGES === '1') {
			await expect(result).toSatisfyJudge(classificationRubricJudge, { threshold: 1 });
		}
	});
});

describeEval('support agent', { harness: agentHarness }, (it) => {
	it('answers a billing prompt with an isolated agent instance', async ({ run }) => {
		const result = await run({
			message:
				'A customer says they were charged twice for invoice INV-123. Give a concise support triage reply.',
		});

		expect(result.output.instanceId).toMatch(/^support-eval-/);
		expect(result.output.text.trim().length).toBeGreaterThan(20);
		expect(result.output.text.toLowerCase()).toMatch(/billing|charge|invoice|refund|payment/);
	});
});

async function readJson<T>(response: Response): Promise<T> {
	const text = await response.text();
	if (!response.ok) {
		throw new Error(`Flue request failed with ${response.status}: ${text}`);
	}
	return JSON.parse(text) as T;
}
