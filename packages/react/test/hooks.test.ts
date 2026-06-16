import type { AttachedAgentEvent, FlueClient, FlueEvent, FlueEventStream } from '@flue/sdk';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useFlueAgent } from '../src/use-agent.ts';
import { useFlueWorkflow } from '../src/use-workflow.ts';

function eventStream<T>(events: T[], offset = 'offset-1'): FlueEventStream<T> {
	return {
		offset,
		cancel: vi.fn(),
		async *[Symbol.asyncIterator]() {
			for (const event of events) yield event;
		},
	};
}

function pendingStream<T>(): FlueEventStream<T> & { push(event: T): void } {
	const values: T[] = [];
	let wake: (() => void) | undefined;
	let canceled = false;
	return {
		offset: '-1',
		push(event) {
			values.push(event);
			wake?.();
		},
		cancel() {
			canceled = true;
			wake?.();
		},
		async *[Symbol.asyncIterator]() {
			while (!canceled) {
				const value = values.shift();
				if (value !== undefined) yield value;
				else await new Promise<void>((resolve) => (wake = resolve));
			}
		},
	};
}

function client(overrides: Partial<FlueClient>): FlueClient {
	return overrides as FlueClient;
}

describe('useFlueAgent()', () => {
	it('stays dormant without an id while validating a client override', () => {
		const flue = client({});
		const { result } = renderHook(() => useFlueAgent({ name: 'agent', client: flue }));

		expect(result.current.status).toBe('idle');
		expect(result.current.messages).toEqual([]);
	});

	it('submits optimistically and reconciles the stream echo', async () => {
		const stream = pendingStream<AttachedAgentEvent>();
		const send = vi.fn().mockResolvedValue({
			streamUrl: 'https://flue.test/agents/agent/id',
			offset: '-1',
			submissionId: 'submission-1',
		});
		const flue = client({
			agents: { stream: vi.fn(() => stream), send } as unknown as FlueClient['agents'],
		});
		const { result } = renderHook(() => useFlueAgent({ name: 'agent', id: 'id', client: flue }));

		await act(async () => result.current.sendMessage('hello'));
		expect(result.current.status).toBe('submitted');
		expect(result.current.messages[0]?.parts[0]).toMatchObject({ type: 'text', text: 'hello' });

		act(() => {
			stream.push({
				v: 1,
				type: 'message_end',
				message: { role: 'user', content: 'hello' },
				eventIndex: 1,
				timestamp: '2026-06-12T00:00:00.000Z',
				instanceId: 'id',
				submissionId: 'submission-1',
			} as AttachedAgentEvent);
		});
		await waitFor(() => expect(result.current.messages).toHaveLength(1));
		expect(result.current.messages[0]?.id).toBe('submission:submission-1:user:0');
	});
});

describe('useFlueWorkflow()', () => {
	it('derives completed state and logs from replay', async () => {
		const events = [
			{
				v: 1,
				type: 'run_start',
				runId: 'run-1',
				workflowName: 'flow',
				startedAt: '2026-06-12T00:00:00.000Z',
				payload: null,
				eventIndex: 0,
				timestamp: '2026-06-12T00:00:00.000Z',
			},
			{
				v: 1,
				type: 'log',
				level: 'info',
				message: 'working',
				eventIndex: 1,
				timestamp: '2026-06-12T00:00:01.000Z',
				runId: 'run-1',
			},
			{
				v: 1,
				type: 'run_end',
				runId: 'run-1',
				result: { ok: true },
				isError: false,
				durationMs: 2,
				eventIndex: 2,
				timestamp: '2026-06-12T00:00:02.000Z',
			},
		] as FlueEvent[];
		const flue = client({
			runs: { stream: vi.fn(() => eventStream(events)) } as unknown as FlueClient['runs'],
		});
		const { result } = renderHook(() => useFlueWorkflow({ runId: 'run-1', client: flue }));

		await waitFor(() => expect(result.current.status).toBe('completed'));
		expect(result.current.result).toEqual({ ok: true });
		expect(result.current.logs.map((event) => event.message)).toEqual(['working']);
	});

	it('reports running when replay begins with run_resume', async () => {
		const stream = pendingStream<FlueEvent>();
		const flue = client({
			runs: {
				stream: vi.fn(() => stream),
			} as unknown as FlueClient['runs'],
		});
		const { result } = renderHook(() => useFlueWorkflow({ runId: 'run-1', client: flue }));
		act(() => {
			stream.push({
				v: 1,
				type: 'run_resume',
				runId: 'run-1',
				workflowName: 'flow',
				startedAt: '2026-06-12T00:00:00.000Z',
				eventIndex: 1,
				timestamp: '2026-06-12T00:00:01.000Z',
			});
		});

		await waitFor(() => expect(result.current.status).toBe('running'));
	});

	it('reports disconnected when a stream closes without run_end', async () => {
		const flue = client({
			runs: {
				stream: vi.fn(() => eventStream<FlueEvent>([])),
			} as unknown as FlueClient['runs'],
		});
		const { result } = renderHook(() => useFlueWorkflow({ runId: 'run-1', client: flue }));

		await waitFor(() => expect(result.current.status).toBe('disconnected'));
		expect(result.current.error).toBeUndefined();
	});
});
