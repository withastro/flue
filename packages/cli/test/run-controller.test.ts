import type { FlueClient } from '@flue/sdk';
import { describe, expect, it, vi } from 'vitest';
import { assertRunIdAllowed, parseAgentInput, runTarget } from '../src/lib/run-controller.ts';

describe('parseAgentInput()', () => {
	it('accepts the exact public agent input shape', () => {
		const input = {
			message: 'inspect this',
			images: [{ type: 'image' as const, data: 'abc', mimeType: 'image/png' }],
		};

		expect(parseAgentInput(input)).toEqual(input);
	});

	it('rejects extra fields and malformed images', () => {
		expect(() => parseAgentInput({ message: 'hello', model: 'other' })).toThrow('accepts only');
		expect(() => parseAgentInput({ message: 'hello', images: [{ data: 'abc' }] })).toThrow(
			'images',
		);
	});
});

describe('runTarget()', () => {
	it('sends and waits for one agent submission', async () => {
		const admission = { streamUrl: 'https://example.com/stream', offset: '0', submissionId: 'sub' };
		const result = { text: 'done', usage: {}, model: { provider: 'test', id: 'test' } };
		const send = vi.fn().mockResolvedValue(admission);
		const wait = vi.fn().mockResolvedValue(result);
		const client = { agents: { send, wait } } as unknown as FlueClient;

		await expect(
			runTarget(client, {
				kind: 'agent',
				name: 'support',
				instanceId: 'instance',
				input: { message: 'hello' },
			}),
		).resolves.toEqual({ kind: 'agent', instanceId: 'instance', result });
		expect(send).toHaveBeenCalledWith('support', 'instance', {
			message: 'hello',
			signal: undefined,
		});
		expect(wait).toHaveBeenCalledWith(admission, { onEvent: undefined, signal: undefined });
	});

	it('runs a workflow through the SDK helper', async () => {
		const run = vi.fn().mockResolvedValue({ runId: 'run_1', result: { ok: true } });
		const client = { workflows: { run } } as unknown as FlueClient;

		await expect(
			runTarget(client, { kind: 'workflow', name: 'report', input: { month: 6 } }),
		).resolves.toEqual({ kind: 'workflow', runId: 'run_1', result: { ok: true } });
		expect(run).toHaveBeenCalledWith('report', {
			input: { month: 6 },
			onEvent: undefined,
			signal: undefined,
		});
	});
});

describe('assertRunIdAllowed()', () => {
	it('rejects workflow IDs while allowing agent IDs', () => {
		expect(() => assertRunIdAllowed('workflow', 'chosen')).toThrow('--id is not supported');
		expect(() => assertRunIdAllowed('agent', 'chosen')).not.toThrow();
	});
});
