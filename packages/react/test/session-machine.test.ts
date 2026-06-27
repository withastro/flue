import type {
	AgentConversationSnapshot,
	AgentConversationUpdate,
	FlueClient,
	FlueEvent,
	FlueEventStream,
} from '@flue/sdk';
import { describe, expect, it, vi } from 'vitest';
import { AgentSession } from '../src/agent-session.ts';
import { WorkflowRun } from '../src/workflow-run.ts';

function streamFrom<T>(events: T[], offset = 'offset-1'): FlueEventStream<T> {
	return {
		offset,
		cancel: vi.fn(),
		async *[Symbol.asyncIterator]() {
			for (const event of events) yield event;
		},
	};
}

function pendingStream<T>(offset = '-1'): FlueEventStream<T> & { push(event: T): void } {
	let canceled = false;
	let wake: (() => void) | undefined;
	const values: T[] = [];
	return {
		offset,
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

function snapshot(messages: AgentConversationSnapshot['messages'] = []): AgentConversationSnapshot {
	return {
		v: 1,
		type: 'conversation_snapshot',
		conversationId: 'conversation-1',
		harness: 'default',
		session: 'default',
		offset: 'offset-history',
		messages,
		data: [],
		settlements: [],
	};
}

function client(overrides: Partial<FlueClient>): FlueClient {
	return overrides as FlueClient;
}

async function settle(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

describe('AgentSession', () => {
	it('publishes one canonical snapshot before applying live updates', async () => {
		const live = pendingStream<AgentConversationUpdate>('offset-history');
		const history = vi.fn().mockResolvedValue(
			snapshot([
				{
					id: 'entry-user',
					role: 'user',
					submissionId: 'submission-1',
					parts: [{ type: 'text', text: 'first', state: 'done' }],
				},
			]),
		);
		const updates = vi.fn().mockReturnValue(live);
		const session = new AgentSession(
			client({ agents: { history, updates } as unknown as FlueClient['agents'] }),
			'agent',
			'id',
		);

		session.start();
		await settle();

		expect(session.getSnapshot()).toMatchObject({
			historyReady: true,
			messages: [{ id: 'entry-user' }],
		});
		expect(updates).toHaveBeenCalledWith('agent', 'id', {
			live: true,
			offset: 'offset-history',
		});

		live.push({
			v: 1,
			type: 'conversation_record',
			conversationId: 'conversation-1',
			record: {
				v: 1,
				id: 'record-assistant',
				type: 'assistant_message_started',
				conversationId: 'conversation-1',
				harness: 'default',
				session: 'default',
				timestamp: '2026-06-26T00:00:00.000Z',
				messageId: 'entry-assistant',
				parentId: 'entry-user',
				modelInfo: { provider: 'test', model: 'model' },
			},
		});
		await settle();
		expect(session.getSnapshot().messages.map((message) => message.id)).toEqual([
			'entry-user',
			'entry-assistant',
		]);
		session.dispose();
	});

	it('completes finite catch-up after one request without retrying', async () => {
		vi.useFakeTimers();
		const history = vi.fn().mockResolvedValue(snapshot());
		const updates = vi.fn().mockReturnValue(streamFrom<AgentConversationUpdate>([], 'offset-final'));
		const session = new AgentSession(
			client({ agents: { history, updates } as unknown as FlueClient['agents'] }),
			'agent',
			'id',
			'all',
			false,
		);

		session.start();
		await settle();
		await vi.advanceTimersByTimeAsync(60_000);

		expect(updates).toHaveBeenCalledTimes(1);
		expect(updates).toHaveBeenCalledWith('agent', 'id', {
			live: false,
			offset: 'offset-history',
		});
		expect(session.getSnapshot()).toMatchObject({ status: 'idle', historyReady: true, error: undefined });
		session.dispose();
		vi.useRealTimers();
	});

	it('reconciles an optimistic send with canonical user-message identity', async () => {
		const live = pendingStream<AgentConversationUpdate>('offset-history');
		const history = vi.fn().mockResolvedValue(snapshot());
		const updates = vi.fn().mockReturnValue(live);
		const send = vi.fn().mockResolvedValue({
			streamUrl: 'https://flue.test/agents/agent/id',
			offset: 'offset-history',
			submissionId: 'submission-1',
		});
		const session = new AgentSession(
			client({ agents: { history, updates, send } as unknown as FlueClient['agents'] }),
			'agent',
			'id',
		);
		session.start();
		await settle();
		await session.sendMessage('hello');

		live.push({
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
				timestamp: '2026-06-26T00:00:00.000Z',
				submissionId: 'submission-1',
				messageId: 'entry-canonical-user',
				parentId: null,
				content: [{ type: 'text', text: 'hello' }],
			},
		});
		await settle();

		expect(session.getSnapshot().messages).toHaveLength(1);
		expect(session.getSnapshot().messages[0]?.id).toBe('entry-canonical-user');
		session.dispose();
	});
});

describe('WorkflowRun', () => {
	it('streams workflow events without using conversation APIs', async () => {
		const stream = vi.fn().mockReturnValue(
			streamFrom<FlueEvent>([
				{
					v: 3,
					type: 'run_end',
					runId: 'run-1',
					result: 'done',
					isError: false,
					durationMs: 1,
					eventIndex: 0,
					timestamp: '2026-06-26T00:00:00.000Z',
				},
			]),
		);
		const run = new WorkflowRun(client({ runs: { stream } as unknown as FlueClient['runs'] }), 'run-1');
		run.start();
		await settle();
		expect(run.getSnapshot()).toMatchObject({ status: 'completed', result: 'done' });
	});
});
