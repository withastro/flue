import { defineAgent, defineTool, defineWorkflow, type WorkflowRouteHandler } from '@flue/runtime';
import * as v from 'valibot';

export const route: WorkflowRouteHandler = async (_c, next) => next();
const agent = defineAgent(() => ({ model: 'anthropic/claude-haiku-4-5' }));
const lookup = defineTool({
	name: 'lookup_weather',
	description: 'Look up current weather for a city.',
	parameters: v.object({ city: v.string() }),
	execute: async ({ city }) => `${city}: sunny, 72 F`,
});
export default defineWorkflow({
	agent,
	input: v.object({ city: v.optional(v.string()) }),
	async run({ harness, input }) {
		const session = await harness.session();
		const city = input.city ?? 'San Francisco';
		const response = await session.prompt(
			`Use the weather tool to report current weather in ${city}.`,
			{ tools: [lookup] },
		);
		return { message: response.text };
	},
});
