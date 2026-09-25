import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlueExecutionContext } from '../../execution-interceptor.ts';
import type { FlueEventContext, FlueObservation } from '../../types.ts';
import { createCloudflareTracing } from './index.ts';

/**
 * In-memory platform stand-in: `cloudflare:workers` only evaluates inside
 * workerd, so the adapter's `tracing.startActiveSpan` probe is satisfied with
 * a fake span that records every `setAttribute` write. This drives the same
 * interceptor + observe seam the real platform uses, so key routing, ledger
 * draws, and attribute writes are exercised end to end.
 */
const platform = vi.hoisted(() => {
	const recorded: Record<string, string | number | boolean | undefined> = {};
	return {
		recorded,
		clear() {
			for (const key of Object.keys(recorded)) delete recorded[key];
		},
	};
});

vi.mock('cloudflare:workers', () => ({
	tracing: {
		startActiveSpan<T>(
			_name: string,
			callback: (span: {
				isTraced: boolean;
				setAttribute(key: string, value: string | number | boolean | undefined): void;
				end(): void;
			}) => T,
		): T {
			const span = {
				isTraced: true,
				setAttribute(key: string, value: string | number | boolean | undefined) {
					platform.recorded[key] = value;
				},
				end() {},
			};
			return callback(span);
		},
	},
}));

const eventCtx: FlueEventContext = {
	id: 'i1',
	agentName: 'ExampleAgent',
	env: {},
	req: undefined,
	log: { info() {}, warn() {}, error() {} },
};

const interceptorCtx: FlueExecutionContext = {
	instanceId: 'i1',
	submissionId: 's1',
	agentName: 'ExampleAgent',
	harness: 'default',
	conversationId: 'c1',
	session: 'default',
	operationId: 'op1',
	turnId: 'turn1',
};

/** Identity fields shared by the observe events and the interceptor context. */
const identity = {
	v: 3 as const,
	eventIndex: 0,
	timestamp: new Date().toISOString(),
	instanceId: 'i1',
	submissionId: 's1',
	agentName: 'ExampleAgent',
	harness: 'default',
	conversationId: 'c1',
	session: 'default',
	operationId: 'op1',
	turnId: 'turn1',
	toolCallId: 'call_1',
	toolName: 'lookup',
	origin: 'model' as const,
	description: 'Look things up',
};

/**
 * Run one model-originated tool call through the native adapter: the
 * `tool_start` observation stashes the span, the interceptor opens it on the
 * fake platform span (writing arguments), and the terminal `tool`
 * observation writes the result and ends it.
 */
async function runTool(
	args: unknown,
	result: unknown,
): Promise<Record<string, string | number | boolean | undefined>> {
	platform.clear();
	const tracing = createCloudflareTracing();
	tracing.observe({ ...identity, type: 'tool_start', args } as FlueObservation, eventCtx);
	await tracing.interceptor(
		{ type: 'tool', toolCallId: 'call_1', toolName: 'lookup' },
		interceptorCtx,
		() => Promise.resolve('ok'),
	);
	tracing.observe(
		{ ...identity, type: 'tool', isError: false, result, durationMs: 5 } as FlueObservation,
		eventCtx,
	);
	tracing.dispose();
	return { ...platform.recorded };
}

describe('Cloudflare tool payload attributes', () => {
	beforeEach(() => {
		platform.clear();
	});

	it('records a plain object argument and result on the semconv keys', async () => {
		const attributes = await runTool(
			{ location: 'San Francisco?', date: '2025-10-01' },
			{ conditions: 'sunny', high: 75 },
		);
		expect(attributes['gen_ai.tool.call.arguments']).toBe(
			'{"location":"San Francisco?","date":"2025-10-01"}',
		);
		expect(attributes['gen_ai.tool.call.result']).toBe('{"conditions":"sunny","high":75}');
		expect(attributes['flue.tool.call.arguments']).toBeUndefined();
		expect(attributes['flue.tool.call.result']).toBeUndefined();
	});

	it('records ordinary text on the semconv keys with no vendor fallback on either path', async () => {
		const attributes = await runTool('how many sunny days?', 'It is sunny with a high of 75.');
		expect(attributes['gen_ai.tool.call.arguments']).toBe('how many sunny days?');
		expect(attributes['gen_ai.tool.call.result']).toBe('It is sunny with a high of 75.');
		expect(attributes['flue.tool.call.arguments']).toBeUndefined();
		expect(attributes['flue.tool.call.result']).toBeUndefined();
	});

	it('records JSON-string payloads byte-for-byte on the semconv keys', async () => {
		const attributes = await runTool('{ "a": 1 }', '[1, 2, 3]');
		expect(attributes['gen_ai.tool.call.arguments']).toBe('{ "a": 1 }');
		expect(attributes['gen_ai.tool.call.result']).toBe('[1, 2, 3]');
		expect(attributes['flue.tool.call.arguments']).toBeUndefined();
		expect(attributes['flue.tool.call.result']).toBeUndefined();
	});

	it('records scalars and null on the semconv keys', async () => {
		const attributes = await runTool(42, null);
		expect(attributes['gen_ai.tool.call.arguments']).toBe('42');
		expect(attributes['gen_ai.tool.call.result']).toBe('null');
		expect(attributes['flue.tool.call.arguments']).toBeUndefined();
		expect(attributes['flue.tool.call.result']).toBeUndefined();
	});

	it('records the unserializable sentinel on the semconv key', async () => {
		const attributes = await runTool({}, { value: 1n });
		expect(attributes['gen_ai.tool.call.arguments']).toBe('{}');
		expect(attributes['gen_ai.tool.call.result']).toBe('[flue] content unserializable');
		expect(attributes['flue.tool.call.result']).toBeUndefined();
	});

	it('records no tool payload content under content: false', async () => {
		platform.clear();
		const tracing = createCloudflareTracing({ content: false });
		tracing.observe(
			{ ...identity, type: 'tool_start', args: { a: 1 } } as FlueObservation,
			eventCtx,
		);
		await tracing.interceptor(
			{ type: 'tool', toolCallId: 'call_1', toolName: 'lookup' },
			interceptorCtx,
			() => Promise.resolve('ok'),
		);
		tracing.observe(
			{
				...identity,
				type: 'tool',
				isError: false,
				result: 'text',
				durationMs: 5,
			} as FlueObservation,
			eventCtx,
		);
		tracing.dispose();
		expect(platform.recorded['gen_ai.tool.call.arguments']).toBeUndefined();
		expect(platform.recorded['gen_ai.tool.call.result']).toBeUndefined();
	});
});
