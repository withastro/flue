import {
	type AgentRouteHandler,
	defineAgent,
	defineAgentProfile,
	defineTool,
} from '@flue/runtime';
import * as v from 'valibot';

export const route: AgentRouteHandler = async (_c, next) => next();

/**
 * A named subagent the model can delegate to via the framework `task` tool.
 * Surfaces in the projected conversation as a `dynamic-tool` part with
 * `toolName: 'task'` and `input.agent: 'poet'`.
 */
const poet = defineAgentProfile({
	name: 'poet',
	description: 'Writes a short, original poem on a given topic.',
	instructions: 'Reply with a short four-line poem and nothing else.',
});

/**
 * A real-model chat agent used to exercise the demo app end-to-end: it streams
 * text, emits reasoning (via `thinkingLevel`), calls a tool, and can delegate to
 * a subagent. Requires `ANTHROPIC_API_KEY` in the environment.
 */
export default defineAgent(() => ({
	model: 'anthropic/claude-haiku-4-5',
	thinkingLevel: 'low',
	instructions:
		'You are a helpful assistant. When a question involves arithmetic, use the calculator tool rather than computing it yourself. When asked for a poem, delegate to the "poet" subagent via the task tool. Keep answers concise.',
	subagents: [poet],
	tools: [
		defineTool({
			name: 'calculator',
			description: 'Evaluate a basic arithmetic expression and return the numeric result.',
			input: v.object({
				expression: v.string('A JavaScript arithmetic expression, e.g. "7 * 6".'),
			}),
			// Demo only: evaluates model-supplied input. Never ship arbitrary `Function`
			// evaluation of untrusted input in a real tool — use a sandbox or a parser.
			run: async ({ input }) =>
				String(Function(`"use strict"; return (${input.expression})`)()),
		}),
	],
}));
