import {
	createAgent,
	defineAgentProfile,
	type FlueContext,
	type WorkflowRouteHandler,
} from '@flue/runtime';
import * as v from 'valibot';

export const route: WorkflowRouteHandler = async (_c, next) => next();

const classifierProfile = defineAgentProfile({
	instructions:
		'Classify short support requests. Keep summaries under 20 words and choose the lowest priority that fits the request.',
});

const classifier = createAgent(() => ({
	model: process.env.FLUE_EVAL_MODEL ?? 'openai/gpt-5.5',
	profile: classifierProfile,
}));

const classificationSchema = v.object({
	category: v.picklist(['billing', 'technical', 'account', 'other']),
	priority: v.picklist(['low', 'medium', 'high']),
	summary: v.string(),
});

export async function run({ init, payload }: FlueContext) {
	const harness = await init(classifier);
	const session = await harness.session();
	const message = readMessage(payload);

	const response = await session.prompt(
		`Classify this support request: ${JSON.stringify(message)}`,
		{ result: classificationSchema },
	);

	return response.data;
}

function readMessage(payload: unknown): string {
	if (!payload || typeof payload !== 'object') return '';
	const message = (payload as { message?: unknown }).message;
	return typeof message === 'string' ? message : '';
}
