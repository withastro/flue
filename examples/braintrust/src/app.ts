import { type FlueObservation, observe } from '@flue/runtime';
import { createAgentRouter } from '@flue/runtime/routing';
import { braintrustFlueObserver, initLogger } from 'braintrust';
import { Hono } from 'hono';
import { Prompt } from './agents/prompt.ts';
import { Task } from './agents/task.ts';
import { Tools } from './agents/tools.ts';

const apiKey = process.env.BRAINTRUST_API_KEY;

if (apiKey) {
	initLogger({
		projectName: process.env.BRAINTRUST_PROJECT_NAME ?? 'Flue',
		apiKey,
	});

	observe((event, ctx) => {
		const compatible = compatibleEvent(event);
		if (compatible) braintrustFlueObserver(compatible, ctx);
	});
}

/**
 * Forward only the lifecycle events Braintrust 3.17's Flue observer
 * consumes, renaming the terminal tool event to the `tool_call` shape it
 * expects.
 */
function compatibleEvent(event: FlueObservation): unknown {
	if (event.type === 'tool') return { ...event, type: 'tool_call' };
	if (
		event.type === 'operation_start' ||
		event.type === 'operation' ||
		event.type === 'turn_request' ||
		event.type === 'turn' ||
		event.type === 'tool_start' ||
		event.type === 'task_start' ||
		event.type === 'task' ||
		event.type === 'compaction_start' ||
		event.type === 'compaction'
	) {
		return event;
	}
	return undefined;
}

const app = new Hono();
app.route('/agents/prompt', createAgentRouter(Prompt));
app.route('/agents/tools', createAgentRouter(Tools));
app.route('/agents/task', createAgentRouter(Task));

export default app;
