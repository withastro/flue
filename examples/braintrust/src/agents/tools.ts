'use agent';
import { defineTool, useModel, useTool } from '@flue/runtime';
import * as v from 'valibot';

const lookup = defineTool({
	name: 'lookup_weather',
	description: 'Look up current weather for a city.',
	input: v.object({ city: v.string() }),
	run: async ({ data }) => `${data.city}: sunny, 72 F`,
});

/** A tool-using agent: tool calls show up as `tool` spans in Braintrust. */
export function Tools() {
	useModel('anthropic/claude-haiku-4-5');
	useTool(lookup);
	return 'Use the weather tool to report the current weather for the requested city.';
}
