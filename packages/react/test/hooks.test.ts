import type {
	FlueClient,
	FlueConversationMessage,
	FlueEvent,
	FlueEventStream,
} from '@flue/sdk';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useFlueAgent } from '../src/use-agent.ts';
import { useFlueWorkflow } from '../src/use-workflow.ts';
import { conversation, createFakeObservation } from './fixtures/observation.ts';

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
	const historyMessages: FlueConversationMessage[] = [
		{
			id: 'entry-user',
			role: 'user',
			submissionId: 'submission-1',
			parts: [{ type: 'text', text: 'history', state: 'done' }],
		},
	];

	it('reports history ready only after the observed transcript is available', async () => {
		const observation = createFakeObservation();
		const observe = vi.fn().mockReturnValue(observation);
		const flue = client({ agents: { observe } as unknown as FlueClient['agents'] });
		const { result, unmount } = renderHook(() =>
			useFlueAgent({ name: 'agent', id: 'id', client: flue }),
		);

		expect(result.current.historyReady).toBe(false);
		expect(result.current.messages).toEqual([]);

		act(() =>
			observation.emit({
				conversation: conversation(historyMessages),
				offset: 'offset-history',
				phase: 'live',
				error: undefined,
			}),
		);
		await waitFor(() => expect(result.current.historyReady).toBe(true));
		expect(result.current.messages[0]?.id).toBe('entry-user');
		unmount();
	});

	it('forwards the configured live mode to observe()', async () => {
		const observation = createFakeObservation();
		const observe = vi.fn().mockReturnValue(observation);
		const flue = client({ agents: { observe } as unknown as FlueClient['agents'] });
		const { unmount } = renderHook(() =>
			useFlueAgent({ name: 'agent', id: 'id', live: 'sse', client: flue }),
		);

		await waitFor(() => expect(observe).toHaveBeenCalledTimes(1));
		expect(observe).toHaveBeenCalledWith('agent', 'id', { live: 'sse' });
		unmount();
	});

	it('stays dormant without an id while validating a client override', () => {
		const flue = client({});
		const { result } = renderHook(() => useFlueAgent({ name: 'agent', client: flue }));

		expect(result.current.status).toBe('idle');
		expect(result.current.historyReady).toBe(false);
		expect(result.current.messages).toEqual([]);
	});

	it('submits optimistically and reconciles canonical user identity', async () => {
		const observation = createFakeObservation();
		const observe = vi.fn().mockReturnValue(observation);
		const send = vi.fn().mockResolvedValue({
			streamUrl: 'https://flue.test/agents/agent/id',
			offset: 'offset-history',
			submissionId: 'submission-1',
		});
		const flue = client({
			agents: { observe, send } as unknown as FlueClient['agents'],
		});
		const { result } = renderHook(() => useFlueAgent({ name: 'agent', id: 'id', client: flue }));

		act(() =>
			observation.emit({
				conversation: conversation(),
				offset: 'offset-history',
				phase: 'live',
				error: undefined,
			}),
		);
		await waitFor(() => expect(result.current.historyReady).toBe(true));

		await act(async () => result.current.sendMessage('hello'));
		expect(result.current.status).toBe('submitted');
		expect(result.current.messages[0]?.parts[0]).toMatchObject({ type: 'text', text: 'hello' });

		act(() =>
			observation.emit({
				conversation: conversation([
					{
						id: 'entry-user',
						role: 'user',
						submissionId: 'submission-1',
						parts: [{ type: 'text', text: 'hello', state: 'done' }],
					},
				]),
				offset: 'offset-2',
				phase: 'live',
				error: undefined,
			}),
		);
		await waitFor(() => expect(result.current.messages).toHaveLength(1));
		expect(result.current.messages[0]?.id).toBe('entry-user');
	});
});

describe('useFlueWorkflow()', () => {
	it('derives completed state and logs from replay', async () => {
		const events = [
			{
				v: 3,
				type: 'run_start',
				runId: 'run-1',
				workflowName: 'flow',
				startedAt: '2026-06-12T00:00:00.000Z',
				input: null,
				eventIndex: 0,
				timestamp: '2026-06-12T00:00:00.000Z',
			},
			{
				v: 3,
				type: 'log',
				level: 'info',
				message: 'working',
				eventIndex: 1,
				timestamp: '2026-06-12T00:00:01.000Z',
				runId: 'run-1',
			},
			{
				v: 3,
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
				v: 3,
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
