import type {
	AgentConversationSnapshot,
	AgentConversationUpdate,
	CanonicalConversationRecord,
	FlueClient,
	FlueEvent,
	FlueEventStream,
} from '@flue/sdk';
import { describe, expect, it, vi } from 'vitest';
import { AgentSession } from '../src/agent-session.ts';
import { WorkflowRun } from '../src/workflow-run.ts';
import { createFakeObservation, materialize } from './fixtures/observation.ts';

function streamFrom<T>(events: T[], offset = 'offset-1'): FlueEventStream<T> {
	return {
		offset,
		cancel: vi.fn(),
		async *[Symbol.asyncIterator]() {
			for (const event of events) yield event;
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
		settlements: [],
	};
}

function record(id: string, type: string, fields: Record<string, unknown>): CanonicalConversationRecord {
	return {
		v: 1,
		id,
		type,
		conversationId: 'conversation-1',
		harness: 'default',
		session: 'default',
		timestamp: '2026-06-26T00:00:00.000Z',
		...fields,
	};
}

function update(value: CanonicalConversationRecord): AgentConversationUpdate {
	return { v: 1, type: 'conversation_record', conversationId: 'conversation-1', record: value };
}

function client(overrides: Partial<FlueClient>): FlueClient {
	return overrides as FlueClient;
}

describe('AgentSession', () => {
	it('projects an observed snapshot before applying observed live updates', () => {
		const observation = createFakeObservation();
		const observe = vi.fn().mockReturnValue(observation);
		const session = new AgentSession(
			client({ agents: { observe } as unknown as FlueClient['agents'] }),
			'agent',
			'id',
		);

		session.start();
		expect(observe).toHaveBeenCalledWith('agent', 'id', { live: true });

		const userMessage = snapshot([
			{
				id: 'entry-user',
				role: 'user',
				submissionId: 'submission-1',
				parts: [{ type: 'text', text: 'first', state: 'done' }],
			},
		]);
		observation.emit({
			conversation: materialize(userMessage),
			offset: 'offset-history',
			phase: 'live',
			error: undefined,
		});

		expect(session.getSnapshot()).toMatchObject({
			historyReady: true,
			messages: [{ id: 'entry-user' }],
		});

		observation.emit({
			conversation: materialize(userMessage, [
				update(
					record('record-assistant', 'assistant_message_started', {
						messageId: 'entry-assistant',
						parentId: 'entry-user',
						modelInfo: { provider: 'test', model: 'model' },
					}),
				),
			]),
			offset: 'offset-2',
			phase: 'live',
			error: undefined,
		});

		expect(session.getSnapshot().messages.map((message) => message.id)).toEqual([
			'entry-user',
			'entry-assistant',
		]);
		session.dispose();
		expect(observation.close).toHaveBeenCalled();
	});

	it('forwards a finite live mode and settles to idle once up-to-date', () => {
		const observation = createFakeObservation();
		const observe = vi.fn().mockReturnValue(observation);
		const session = new AgentSession(
			client({ agents: { observe } as unknown as FlueClient['agents'] }),
			'agent',
			'id',
			'all',
			false,
		);

		session.start();
		expect(observe).toHaveBeenCalledWith('agent', 'id', { live: false });

		observation.emit({
			conversation: materialize(snapshot()),
			offset: 'offset-final',
			phase: 'up-to-date',
			error: undefined,
		});

		expect(session.getSnapshot()).toMatchObject({
			status: 'idle',
			historyReady: true,
			error: undefined,
		});
		session.dispose();
	});

	it('reconciles an optimistic send with canonical user-message identity', async () => {
		const observation = createFakeObservation();
		const observe = vi.fn().mockReturnValue(observation);
		const send = vi.fn().mockResolvedValue({
			streamUrl: 'https://flue.test/agents/agent/id',
			offset: 'offset-history',
			submissionId: 'submission-1',
		});
		const session = new AgentSession(
			client({ agents: { observe, send } as unknown as FlueClient['agents'] }),
			'agent',
			'id',
		);

		session.start();
		observation.emit({
			conversation: materialize(snapshot()),
			offset: 'offset-history',
			phase: 'live',
			error: undefined,
		});
		await session.sendMessage('hello');
		expect(session.getSnapshot().status).toBe('submitted');

		observation.emit({
			conversation: materialize(snapshot(), [
				update(
					record('record-user', 'user_message', {
						submissionId: 'submission-1',
						messageId: 'entry-canonical-user',
						parentId: null,
						content: [{ type: 'text', text: 'hello' }],
					}),
				),
			]),
			offset: 'offset-2',
			phase: 'live',
			error: undefined,
		});

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
		await Promise.resolve();
		await Promise.resolve();
		expect(run.getSnapshot()).toMatchObject({ status: 'completed', result: 'done' });
	});
});
