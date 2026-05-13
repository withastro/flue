// Requires `"ai": { "binding": "AI" }` in wrangler.jsonc. Cloudflare-only:
// the `cloudflare/` prefix routes through the Workers AI binding (env.AI.run)
// instead of HTTP. The generated `_entry.ts` calls
// `registerProvider('cloudflare', { api: 'cloudflare-ai-binding', binding: env.AI })`
// at module top level, so resolution flows through the same `registerProvider`
// pipeline a user `app.ts` would use for any custom provider.
//
// Multi-test agent: exercises a few capabilities to verify the binding-backed
// provider behaves like a real model end-to-end.
//
// Payload:
//   { "test": "multiturn" }   — multi-turn memory within one invocation
//   { "test": "structured" }  — structured output via schema option
//   { "test": "tool" }        — custom tool calling
//   { "action": "set", "secret": "..." }   — cross-invocation persistence (set)
//   { "action": "recall" }                  — cross-invocation persistence (recall)
//   {}                                       — runs all single-invocation tests
//
// Catalog: https://developers.cloudflare.com/workers-ai/models/
import { Type, type FlueContext, type ToolDef } from '@flue/runtime';
import * as v from 'valibot';

export const triggers = { webhook: true };

const MODEL = 'cloudflare/@cf/moonshotai/kimi-k2.6';

export default async function ({ init, payload, id }: FlueContext) {
	const action = (payload as { action?: string } | undefined)?.action;
	const test = (payload as { test?: string } | undefined)?.test;

	const harness = await init({ model: MODEL });
	const session = await harness.session();

	// ─── Cross-invocation persistence (set/recall) ──────────────────────────
	// Two requests to the same agent instance id share the default harness/session history.
	// Verifies the binding-backed provider doesn't lose context across
	// process boundaries (DO storage round-trip).
	if (action === 'set') {
		const secret = (payload as { secret?: string }).secret ?? 'FLUE-CF-42';
		await session.prompt(
			`Remember this secret code: ${secret}. I will ask you about it later.`,
		);
		return { status: 'secret-set', id, sessionName: session.name, secret };
	}
	if (action === 'recall') {
		const { text } = await session.prompt(
			'What was the secret code I told you earlier? Reply with just the code, nothing else.',
		);
		return {
			status: 'recalled',
			id,
			sessionName: session.name,
			recalled: text.trim(),
		};
	}

	// ─── Single-invocation tests ────────────────────────────────────────────
	const results: Record<string, { pass: boolean; detail: string }> = {};

	// Test 1: multi-turn memory within a single invocation.
	if (!test || test === 'multiturn') {
		const turn1 = await session.prompt(
			'My favorite number is 17. Just acknowledge it briefly.',
		);
		const turn2 = await session.prompt(
			'What number did I just tell you was my favorite? Reply with just the number.',
		);
		const recalled = turn2.text.trim();
		results.multiturn = {
			pass: recalled.includes('17'),
			detail: `turn1=${truncate(turn1.text)} | turn2=${truncate(recalled)}`,
		};
	}

	// Test 2: structured output via the schema option.
	if (!test || test === 'structured') {
		const Answer = v.object({
			capital: v.string(),
			country: v.string(),
		});
		try {
			const structured = await session.prompt(
				'What is the capital of France? Respond as JSON.',
				{ schema: Answer },
			);
			results.structured = {
				pass:
					typeof structured.data?.capital === 'string' &&
					structured.data.capital.toLowerCase().includes('paris'),
				detail: JSON.stringify(structured.data),
			};
		} catch (err) {
			results.structured = {
				pass: false,
				detail: `error: ${(err as Error).message}`,
			};
		}
	}

	// Test 3: custom tool calling. Verifies the model actually CALLS the
	// tool — not just that it knows the answer. We check the side-effect
	// counter: a true tool invocation increments it; the model talking
	// itself out of using the tool does not.
	if (!test || test === 'tool') {
		let toolInvocations = 0;
		const calculator: ToolDef = {
			name: 'calculator',
			description: 'Perform arithmetic. Returns the numeric result as a string.',
			parameters: Type.Object({
				expression: Type.String({
					description: 'A math expression like "2 + 3"',
				}),
			}),
			execute: async (args) => {
				toolInvocations++;
				// Workers disallow eval/Function. Hand-parse a single binary
				// arithmetic expression; sufficient for this test.
				const expr = String(args.expression).replace(/\s+/g, '');
				const m = expr.match(/^(-?\d+(?:\.\d+)?)\s*([+\-*/])\s*(-?\d+(?:\.\d+)?)$/);
				if (!m) return `error: cannot parse "${expr}"`;
				const a = Number(m[1]);
				const b = Number(m[3]);
				const r =
					m[2] === '+' ? a + b : m[2] === '-' ? a - b : m[2] === '*' ? a * b : a / b;
				return String(r);
			},
		};
		try {
			const toolResponse = await session.prompt(
				'Compute 17 * 23 by calling the calculator tool. You MUST use the tool — do not compute it yourself. Then tell me the result.',
				{ tools: [calculator] },
			);
			results.tool = {
				pass: toolInvocations > 0 && toolResponse.text.includes('391'),
				detail: `invocations=${toolInvocations} | text=${truncate(toolResponse.text)}`,
			};
		} catch (err) {
			results.tool = {
				pass: false,
				detail: `error: ${(err as Error).message}`,
			};
		}
	}

	const allPassed = Object.values(results).every((r) => r.pass);
	for (const [name, r] of Object.entries(results)) {
		console.log(
			`[with-cloudflare-binding] ${name}: ${r.pass ? 'PASS' : 'FAIL'} — ${r.detail}`,
		);
	}
	console.log(`[with-cloudflare-binding] ${allPassed ? 'ALL PASSED' : 'SOME FAILED'}`);

	return { results, allPassed };
}

function truncate(s: string, n = 100): string {
	const t = s.replace(/\s+/g, ' ').trim();
	return t.length > n ? `${t.slice(0, n)}…` : t;
}
