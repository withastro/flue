'use agent';
/**
 * A real-model chat agent used to exercise the demo app end-to-end: it streams
 * text, emits reasoning (via `thinkingLevel`), calls tools, delegates to a
 * subagent, and showcases both output surfaces — `useResponseStart` metadata (the demo
 * footer's timestamp/model come from here; the runtime stamps nothing) and
 * `useDataWriter` (the weather tool streams a live card the demo renders).
 * Requires `ANTHROPIC_API_KEY` in the environment.
 */
import { useDataWriter, useModel, useResponseStart, useSubagent, useTool } from '@flue/runtime';
import * as v from 'valibot';

const MODEL = 'anthropic/claude-haiku-4-5';

/** Deterministic pretend forecast so the demo needs no weather API. */
function pretendForecast(city: string): { tempC: number; condition: string } {
	const conditions = ['sunny', 'partly cloudy', 'overcast', 'light rain', 'windy'];
	let hash = 0;
	for (const char of city.toLowerCase()) hash = (hash * 31 + char.charCodeAt(0)) % 997;
	return { tempC: 8 + (hash % 22), condition: conditions[hash % conditions.length] as string };
}

export function Helper() {
	useModel(MODEL, { thinkingLevel: 'low' });
	// Message metadata is agent-authored: the demo UI reads `timestamp` for its
	// relative "time ago" label and `model` for the footer.
	useResponseStart(() => ({ timestamp: new Date().toISOString(), model: MODEL }));

	// A live weather card. Writes stream to the client immediately, so the
	// "loading" state is visible while the lookup runs; the second write
	// updates the same card in place (the name is its identity).
	const writeWeatherData = useDataWriter('weather', {
		schema: v.object({
			city: v.string(),
			status: v.picklist(['loading', 'loaded']),
			tempC: v.optional(v.number()),
			condition: v.optional(v.string()),
		}),
	});
	useTool({
		name: 'get_weather',
		description:
			'Look up the current weather for a city and stream a live weather card to the user.',
		input: v.object({ city: v.string("The city to look up, e.g. 'Tokyo'.") }),
		run: async ({ data }) => {
			writeWeatherData({ city: data.city, status: 'loading' });
			// Pretend lookup latency so the loading card is actually visible.
			await new Promise((resolve) => setTimeout(resolve, 1200));
			const forecast = pretendForecast(data.city);
			writeWeatherData({ city: data.city, status: 'loaded', ...forecast });
			return `${data.city}: ${forecast.tempC}°C, ${forecast.condition}. (Simulated demo data — the user already sees a weather card; answer in one short sentence.)`;
		},
	});

	useTool({
		name: 'calculator',
		description: 'Evaluate a basic arithmetic expression and return the numeric result.',
		input: v.object({
			expression: v.string('A JavaScript arithmetic expression, e.g. "7 * 6".'),
		}),
		// Demo only: evaluates model-supplied data. Never ship arbitrary `Function`
		// evaluation of untrusted input in a real tool — use a sandbox or a parser.
		run: async ({ data }) => String(Function(`"use strict"; return (${data.expression})`)()),
	});

	useSubagent({
		name: 'poet',
		description: 'Writes a short, original poem on a given topic.',
		agent: () => 'Reply with a short four-line poem and nothing else.',
	});

	return 'You are a helpful assistant. When a question involves arithmetic, use the calculator tool rather than computing it yourself. When asked about the weather, use the get_weather tool. When asked for a poem, delegate to the "poet" subagent via the task tool. Keep answers concise.';
}
