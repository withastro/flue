import {
	defineAgentProfile,
	type FlueContext,
	type WorkflowRouteHandler,
} from '@flue/runtime';
import * as v from 'valibot';

export const route: WorkflowRouteHandler = async (_c, next) => next();

const greeter = defineAgentProfile({
	name: 'greeter',
	instructions: 'Write one warm, concise greeting.',
});

export async function run({ init, payload }: FlueContext<{ name?: string }>) {
	const harness = await init({ model: 'anthropic/claude-sonnet-4-6', subagents: [greeter] });
	const session = await harness.session();

	const { data } = await session.task(`Greet the user named "${payload.name ?? 'Developer'}".`, {
		agent: 'greeter',
		result: v.object({ greeting: v.string() }),
	});

	console.log('[with-subagent] greeting:', data.greeting);
	return data;
}
