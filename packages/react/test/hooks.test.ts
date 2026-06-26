import type {
	AgentConversationSnapshot,
	AgentConversationUpdate,
	FlueClient,
	FlueEvent,
	FlueEventStream,
} from '@flue/sdk';
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
	const historySnapshot: AgentConversationSnapshot = {
		v: 1,
		type: 'conversation_snapshot',
		conversationId: 'conversation-1',
		harness: 'default',
		session: 'default',
		offset: 'offset-history',
		messages: [
			{
				id: 'entry-user',
				role: 'user',
				submissionId: 'submission-1',
				parts: [{ type: 'text', text: 'history', state: 'done' }],
			},
		],
		data: [],
		settlements: [],
	};

	it('reports history ready only after the atomic transcript is available', async () => {
		let finishHistory!: (snapshot: AgentConversationSnapshot) => void;
		const history = vi.fn(
			() => new Promise<AgentConversationSnapshot>((resolve) => (finishHistory = resolve)),
		);
		const updates = vi.fn().mockReturnValue(pendingStream<AgentConversationUpdate>());
		const flue = client({ agents: { history, updates } as unknown as FlueClient['agents'] });
		const { result, unmount } = renderHook(() =>
			useFlueAgent({ name: 'agent', id: 'id', history: 'all', client: flue }),
		);
		await waitFor(() => expect(history).toHaveBeenCalledTimes(1));

		expect(result.current.historyReady).toBe(false);
		expect(result.current.messages).toEqual([]);
		act(() => finishHistory(historySnapshot));
		await waitFor(() => expect(result.current.historyReady).toBe(true));
		expect(result.current.messages[0]?.id).toBe('entry-user');
		unmount();
	});

	it('forwards the configured live transport after snapshot hydration', async () => {
		const history = vi.fn().mockResolvedValue(historySnapshot);
		const updates = vi.fn().mockReturnValue(pendingStream<AgentConversationUpdate>());
		const flue = client({ agents: { history, updates } as unknown as FlueClient['agents'] });
		const { unmount } = renderHook(() =>
			useFlueAgent({ name: 'agent', id: 'id', live: 'sse', client: flue }),
		);

		await waitFor(() => expect(updates).toHaveBeenCalledTimes(1));

		expect(history).toHaveBeenCalledWith('agent', 'id');
		expect(updates).toHaveBeenCalledWith('agent', 'id', {
			live: 'sse',
			offset: 'offset-history',
		});
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
		const stream = pendingStream<AgentConversationUpdate>();
		const history = vi.fn().mockResolvedValue({ ...historySnapshot, messages: [] });
		const updates = vi.fn().mockReturnValue(stream);
		const send = vi.fn().mockResolvedValue({
			streamUrl: 'https://flue.test/agents/agent/id',
			offset: 'offset-history',
			submissionId: 'submission-1',
		});
		const flue = client({
			agents: { history, updates, send } as unknown as FlueClient['agents'],
		});
		const { result } = renderHook(() => useFlueAgent({ name: 'agent', id: 'id', client: flue }));
		await waitFor(() => expect(result.current.historyReady).toBe(true));

		await act(async () => result.current.sendMessage('hello'));
		expect(result.current.status).toBe('submitted');
		expect(result.current.messages[0]?.parts[0]).toMatchObject({ type: 'text', text: 'hello' });

		act(() => {
			stream.push({
				v: 1,
				type: 'conversation_record',
				conversationId: 'conversation-1',
				record: {
					v: 1,
					id: 'record-user',
					type: 'user_message',
					conversationId: 'conversation-1',
					harness: 'default',
					session: 'default',
					timestamp: '2026-06-12T00:00:00.000Z',
					submissionId: 'submission-1',
					messageId: 'entry-user',
					content: [{ type: 'text', text: 'hello' }],
				},
			});
		});
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
