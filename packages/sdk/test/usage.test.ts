/**
 * Usage & cost exposure tests.
 *
 * Covers the three surfaces added by the feature:
 *   - `turn_end` event now carries `{ usage, model }`.
 *   - `PromptResponse` gains `{ usage, model }` aggregated across every
 *     turn the call produced.
 *   - Schema-callers (those passing `result: v.object(...)`) get their
 *     validated result untouched — usage must flow only via events.
 *   - Helpers (`emptyUsage`, `addUsage`, `messageToModelInfo`).
 *
 * Uses an in-process fake `streamFn` so no network and deterministic
 * usage values — the shape of what pi-ai reports is documented at
 * `@mariozechner/pi-ai/dist/types.d.ts::Usage`.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import type {
	AssistantMessage,
	Context,
	Model,
	SimpleStreamOptions,
	Usage,
} from '@mariozechner/pi-ai';
// See reasoning-forwarding.test.ts for why we pull the class via dynamic import.
const { AssistantMessageEventStream } = (await import('@mariozechner/pi-ai')) as any;

import {
	Session,
	InMemorySessionStore,
	addUsage,
	emptyUsage,
	messageToModelInfo,
} from '../src/session.ts';
import type {
	AgentConfig,
	FlueEvent,
	ModelInfo,
	Role,
	SessionEnv,
	Skill,
} from '../src/types.ts';

// ─── Fixtures ──────────────────────────────────────────────────────────────

function reasoningModel(): Model<'openai-responses'> {
	return {
		id: 'claude-opus-4-7',
		name: 'Claude Opus 4.7',
		api: 'openai-responses',
		provider: 'anthropic',
		baseUrl: 'https://api.example.test',
		reasoning: true,
		input: ['text'],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8192,
	};
}

function makeUsage(overrides: Partial<Usage> = {}): Usage {
	return {
		input: overrides.input ?? 100,
		output: overrides.output ?? 50,
		cacheRead: overrides.cacheRead ?? 0,
		cacheWrite: overrides.cacheWrite ?? 0,
		totalTokens: overrides.totalTokens ?? 150,
		cost: overrides.cost ?? {
			input: 0.001,
			output: 0.002,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0.003,
		},
	};
}

function stubEnv(): SessionEnv {
	return {
		cwd: '/workspace',
		resolvePath: (p) => (p.startsWith('/') ? p : `/workspace/${p}`),
		async exec() {
			return { stdout: '', stderr: '', exitCode: 0 };
		},
		async readFile() {
			throw new Error('not implemented');
		},
		async readFileBuffer() {
			throw new Error('not implemented');
		},
		async writeFile() {},
		async stat() {
			return {
				isFile: false,
				isDirectory: false,
				isSymbolicLink: false,
				size: 0,
				mtime: new Date(),
			};
		},
		async readdir() {
			return [];
		},
		async exists() {
			return false;
		},
		async mkdir() {},
		async rm() {},
		async cleanup() {},
	};
}

function baseConfig(overrides?: Partial<AgentConfig>): AgentConfig {
	const model = reasoningModel();
	return {
		systemPrompt: 'test',
		skills: {} as Record<string, Skill>,
		roles: {} as Record<string, Role>,
		model: model as any,
		resolveModel: () => model as any,
		...overrides,
	};
}

/**
 * Fake `streamFn` that returns a canned `done` event with a specified
 * `usage` payload so we can verify end-to-end that Flue surfaces the
 * provider-reported numbers untouched.
 */
function fakeStreamFnWithUsage(usage: Usage) {
	return (model: Model<any>, _context: Context, _options?: SimpleStreamOptions) => {
		const stream = new AssistantMessageEventStream();
		const message: AssistantMessage = {
			role: 'assistant',
			content: [{ type: 'text', text: 'ok' }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage,
			stopReason: 'stop',
			timestamp: Date.now(),
		};
		stream.push({ type: 'start', partial: message });
		stream.push({ type: 'text_start', contentIndex: 0, partial: message });
		stream.push({ type: 'text_delta', contentIndex: 0, delta: 'ok', partial: message });
		stream.push({ type: 'text_end', contentIndex: 0, content: 'ok', partial: message });
		stream.push({ type: 'done', reason: 'stop', message });
		stream.end();
		return stream;
	};
}

function makeSession(
	config: AgentConfig,
	streamFn: (model: Model<any>, context: Context, options?: SimpleStreamOptions) => any,
	onEvent?: (event: FlueEvent) => void,
): Session {
	const session = new Session({
		id: 'test-session',
		storageKey: 'agent:test:default',
		config,
		env: stubEnv(),
		store: new InMemorySessionStore(),
		existingData: null,
		onAgentEvent: onEvent,
		createTaskSession: async () => {
			throw new Error('task sessions not exercised in these tests');
		},
	});
	(session as any).harness.streamFn = streamFn;
	return session;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

describe('emptyUsage', () => {
	it('returns all-zero usage with a well-formed cost sub-object', () => {
		const u = emptyUsage();
		assert.equal(u.input, 0);
		assert.equal(u.output, 0);
		assert.equal(u.cacheRead, 0);
		assert.equal(u.cacheWrite, 0);
		assert.equal(u.totalTokens, 0);
		assert.equal(u.cost.input, 0);
		assert.equal(u.cost.output, 0);
		assert.equal(u.cost.cacheRead, 0);
		assert.equal(u.cost.cacheWrite, 0);
		assert.equal(u.cost.total, 0);
	});

	it('acts as the additive identity with addUsage', () => {
		const u = makeUsage();
		assert.deepEqual(addUsage(emptyUsage(), u), u);
		assert.deepEqual(addUsage(u, emptyUsage()), u);
	});
});

describe('addUsage', () => {
	it('sums every numeric field including nested cost, without mutating inputs', () => {
		const a = makeUsage({
			input: 10,
			output: 20,
			cacheRead: 1,
			cacheWrite: 2,
			totalTokens: 33,
			cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: 0.33 },
		});
		const b = makeUsage({
			input: 5,
			output: 7,
			cacheRead: 3,
			cacheWrite: 4,
			totalTokens: 19,
			cost: { input: 0.05, output: 0.07, cacheRead: 0.03, cacheWrite: 0.04, total: 0.19 },
		});
		const aClone = structuredClone(a);
		const bClone = structuredClone(b);

		const sum = addUsage(a, b);

		// Integer token fields are exact.
		assert.equal(sum.input, 15);
		assert.equal(sum.output, 27);
		assert.equal(sum.cacheRead, 4);
		assert.equal(sum.cacheWrite, 6);
		assert.equal(sum.totalTokens, 52);
		// Cost fields are floats in USD. We only assert proximity to avoid
		// IEEE 754 noise — the sum is produced by plain `+`, so the
		// semantics are standard JS arithmetic; the only contract is
		// "field-wise add, no rounding / clamping applied by Flue".
		const closeEnough = (actual: number, expected: number) =>
			Math.abs(actual - expected) < 1e-9;
		assert.ok(closeEnough(sum.cost.input, 0.15), `cost.input ~= 0.15, got ${sum.cost.input}`);
		assert.ok(closeEnough(sum.cost.output, 0.27), `cost.output ~= 0.27`);
		assert.ok(closeEnough(sum.cost.cacheRead, 0.04), `cost.cacheRead ~= 0.04`);
		assert.ok(closeEnough(sum.cost.cacheWrite, 0.06), `cost.cacheWrite ~= 0.06`);
		assert.ok(closeEnough(sum.cost.total, 0.52), `cost.total ~= 0.52`);

		// Immutability: inputs unchanged.
		assert.deepEqual(a, aClone);
		assert.deepEqual(b, bClone);
	});
});

describe('messageToModelInfo', () => {
	it('extracts provider/id from an assistant message', () => {
		const info = messageToModelInfo({
			role: 'assistant',
			content: [{ type: 'text', text: 'x' }],
			api: 'openai-responses',
			provider: 'anthropic',
			model: 'claude-opus-4-7',
			usage: makeUsage(),
			stopReason: 'stop',
			timestamp: 0,
		} as any);
		assert.deepEqual(info, { provider: 'anthropic', id: 'claude-opus-4-7' });
	});

	it('returns undefined for non-assistant messages', () => {
		const info = messageToModelInfo({
			role: 'user',
			content: [{ type: 'text', text: 'hi' }],
			timestamp: 0,
		} as any);
		assert.equal(info, undefined);
	});

	it('returns undefined when provider or id are missing', () => {
		const info = messageToModelInfo({
			role: 'assistant',
			content: [],
			api: 'openai-responses',
			provider: '',
			model: 'x',
			usage: makeUsage(),
			stopReason: 'stop',
			timestamp: 0,
		} as any);
		assert.equal(info, undefined);
	});
});

// ─── turn_end event ────────────────────────────────────────────────────────

describe('turn_end event', () => {
	it('carries the provider-reported usage and model on the event payload', async () => {
		const expected: Usage = makeUsage({ input: 42, output: 17, totalTokens: 59 });
		const events: FlueEvent[] = [];
		const session = makeSession(baseConfig(), fakeStreamFnWithUsage(expected), (e) => events.push(e));

		await session.prompt('hello');

		const turnEnd = events.find((e) => e.type === 'turn_end');
		assert.ok(turnEnd, 'expected a turn_end event');
		assert.deepEqual((turnEnd as any).usage, expected);
		assert.deepEqual((turnEnd as any).model, {
			provider: 'anthropic',
			id: 'claude-opus-4-7',
		});
	});
});

// ─── PromptResponse ────────────────────────────────────────────────────────

describe('PromptResponse.usage + model', () => {
	it('surfaces the single-turn usage as the call-level aggregate', async () => {
		const expected = makeUsage({ input: 100, output: 50, totalTokens: 150 });
		const session = makeSession(baseConfig(), fakeStreamFnWithUsage(expected));

		const response = await session.prompt('hello');

		assert.deepEqual(response.usage, expected);
		assert.deepEqual(response.model, {
			provider: 'anthropic',
			id: 'claude-opus-4-7',
		});
	});

	it('does not attach usage to schema-validated results', async () => {
		const { object, string } = await import('valibot');

		const expected = makeUsage();
		const session = makeSession(baseConfig(), fakeStreamFnWithUsage(expected));

		// Stub extractResultWithRetry: the fake LLM returns plain text "ok",
		// which won't parse into a schema. We bypass the real extraction to
		// keep the test focused on the usage-enrichment decision.
		(session as any).extractResultWithRetry = async () => ({ raw: 'ok' });

		const schema = object({ raw: string() });
		const result = await session.prompt('hello', { result: schema as any });

		// Schema return must be untouched — no `usage` key injected.
		assert.deepEqual(result, { raw: 'ok' });
		assert.equal((result as any).usage, undefined);
		assert.equal((result as any).model, undefined);
	});
});

// ─── skill() ───────────────────────────────────────────────────────────────

describe('skill() usage', () => {
	it('enriches PromptResponse with aggregate usage and model', async () => {
		const expected = makeUsage({ input: 75, output: 25, totalTokens: 100 });
		const config = baseConfig({
			skills: { review: { name: 'review', description: '', instructions: 'Review.' } },
		});
		const session = makeSession(config, fakeStreamFnWithUsage(expected));

		const response = await session.skill('review');
		assert.deepEqual(response.usage, expected);
		assert.deepEqual(response.model, {
			provider: 'anthropic',
			id: 'claude-opus-4-7',
		});
	});
});

// ─── Regression: listeners without usage still work ────────────────────────

describe('backwards compatibility', () => {
	it('existing FlueEventCallback consumers that only destructure `type` still work', async () => {
		// A consumer that was written before `turn_end.usage` existed should
		// keep functioning. We model that by a listener that only looks at
		// `event.type` — the extra fields should not throw or break its flow.
		const seenTypes: string[] = [];
		const session = makeSession(baseConfig(), fakeStreamFnWithUsage(makeUsage()), (e) => {
			seenTypes.push(e.type);
		});

		const response = await session.prompt('hello');
		assert.equal(response.text, 'ok');
		assert.ok(seenTypes.includes('turn_end'));
	});

	it('PromptResponse.usage is optional — callers that only read `text` still work', async () => {
		const session = makeSession(baseConfig(), fakeStreamFnWithUsage(makeUsage()));
		const response = await session.prompt('hello');
		// The minimal PromptResponse contract — text is a string — is
		// unchanged. usage and model are additive.
		assert.equal(typeof response.text, 'string');
	});
});

// ─── ModelInfo shape ───────────────────────────────────────────────────────

describe('ModelInfo re-export', () => {
	it('has the documented `{ provider, id }` shape', () => {
		const info: ModelInfo = { provider: 'anthropic', id: 'claude-opus-4-7' };
		assert.equal(info.provider, 'anthropic');
		assert.equal(info.id, 'claude-opus-4-7');
	});
});
