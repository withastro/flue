import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { RunEventListResponseSchema } from '../src/runtime/schemas.ts';

describe('rich model-turn event schemas', () => {
	it('accepts workflow restart linkage on run starts', () => {
		const result = v.safeParse(RunEventListResponseSchema, {
			events: [{
				type: 'run_start',
				runId: 'workflow:report:replacement',
				owner: { kind: 'workflow', workflowName: 'report', instanceId: 'workflow:report:replacement' },
				instanceId: 'workflow:report:replacement',
				workflowName: 'report',
				startedAt: '2026-05-27T00:00:00.000Z',
				restartedFromRunId: 'workflow:report:interrupted',
				payload: {},
			}],
		});

		expect(result.success).toBe(true);
	});

	it('accepts workflow resume signals', () => {
		const result = v.safeParse(RunEventListResponseSchema, {
			events: [{
				type: 'run_resume',
				runId: 'workflow:report:run',
				owner: { kind: 'workflow', workflowName: 'report', instanceId: 'workflow:report:run' },
				instanceId: 'workflow:report:run',
				workflowName: 'report',
				startedAt: '2026-05-27T00:00:00.000Z',
			}],
		});

		expect(result.success).toBe(true);
	});

	it('accepts normalized model-turn request and output content', () => {
		const result = v.safeParse(RunEventListResponseSchema, {
			events: [
				{
					type: 'turn_request',
					turnId: 'turn_1',
					purpose: 'agent',
					model: 'model',
					provider: 'provider',
					api: 'api',
					input: {
						messages: [
							{ role: 'user', content: [{ type: 'text', text: 'Hello' }] },
							{ role: 'toolResult', toolCallId: 'call_1', toolName: 'lookup', content: [{ type: 'image', data: 'data', mimeType: 'image/png' }], isError: false },
						],
						tools: [{ name: 'lookup', description: 'Lookup', parameters: { type: 'object' } }],
					},
				},
				{
					type: 'turn',
					turnId: 'turn_1',
					purpose: 'agent',
					durationMs: 1,
					output: { role: 'assistant', content: [{ type: 'thinking', thinking: 'checking' }, { type: 'toolCall', id: 'call_1', name: 'lookup', arguments: { query: 'hello' } }] },
					isError: false,
				},
			],
		});

		expect(result.success).toBe(true);
	});

	it('rejects malformed normalized model-turn content', () => {
		const invalidRequest = v.safeParse(RunEventListResponseSchema, {
			events: [{
				type: 'turn_request',
				turnId: 'turn_1',
				purpose: 'agent',
				model: 'model',
				provider: 'provider',
				api: 'api',
				input: { messages: [{ role: 'user', content: [{ type: 'text' }] }] },
			}],
		});
		const invalidOutput = v.safeParse(RunEventListResponseSchema, {
			events: [{
				type: 'turn',
				turnId: 'turn_1',
				purpose: 'agent',
				durationMs: 1,
				output: { role: 'assistant', content: [{ type: 'toolCall', id: 'call_1', name: 'lookup', arguments: 'not-an-object' }] },
				isError: false,
			}],
		});

		expect(invalidRequest.success).toBe(false);
		expect(invalidOutput.success).toBe(false);
	});
});
