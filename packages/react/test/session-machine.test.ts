import type { FlueClient, FlueEvent, FlueEventStream } from '@flue/sdk';
import { describe, expect, it, vi } from 'vitest';
import { AgentSession } from '../src/agent-session.ts';
import { WorkflowRun } from '../src/workflow-run.ts';
import { conversation, createFakeObservation } from './fixtures/observation.ts';

function streamFrom<T>(events: T[], offset = 'offset-1'): FlueEventStream<T> {
	return {
		offset,
		cancel: vi.fn(),
		async *[Symbol.asyncIterator]() {
			for (const event of events) yield event;
		},
	};
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

		observation.emit({
			conversation: conversation([
				{
					id: 'entry-user',
					role: 'user',
					submissionId: 'submission-1',
					parts: [{ type: 'text', text: 'first', state: 'done' }],
				},
			]),
			offset: 'offset-history',
			phase: 'live',
			error: undefined,
		});

		expect(session.getSnapshot()).toMatchObject({
			historyReady: true,
			messages: [{ id: 'entry-user' }],
		});

		observation.emit({
			conversation: conversation([
				{
					id: 'entry-user',
					role: 'user',
					submissionId: 'submission-1',
					parts: [{ type: 'text', text: 'first', state: 'done' }],
				},
				{ id: 'entry-assistant', role: 'assistant', parts: [], metadata: { model: { provider: 'test', id: 'model' } } },
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
			false,
		);

		session.start();
		expect(observe).toHaveBeenCalledWith('agent', 'id', { live: false });

		observation.emit({
			conversation: conversation(),
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
			conversation: conversation(),
			offset: 'offset-history',
			phase: 'live',
			error: undefined,
		});
		await session.sendMessage('hello');
		expect(session.getSnapshot().status).toBe('submitted');

		observation.emit({
			conversation: conversation([
				{
					id: 'entry-canonical-user',
					role: 'user',
					submissionId: 'submission-1',
					parts: [{ type: 'text', text: 'hello', state: 'done' }],
				},
			]),
			offset: 'offset-2',
			phase: 'live',
			error: undefined,
		});

		// The canonical user message adopts the optimistic local id, so the row is
		// stable across the optimistic→confirmed swap.
		expect(session.getSnapshot().messages).toHaveLength(1);
		expect(session.getSnapshot().messages[0]?.id).toBe('local:agent:id:1');
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
