import type { FlueClient } from '@flue/sdk';
import { describe, expect, it, vi } from 'vitest';
import { createFlueAgentStore } from '../src/index.ts';
import { conversation, createFakeObservation } from './fixtures/observation.ts';

describe('createFlueAgentStore()', () => {
	it('retains its snapshot when observation is stopped and restarted', () => {
		const firstObservation = createFakeObservation();
		const secondObservation = createFakeObservation();
		const observe = vi
			.fn()
			.mockReturnValueOnce(firstObservation)
			.mockReturnValueOnce(secondObservation);
		const store = createFlueAgentStore({
			client: { agents: { observe } } as unknown as FlueClient,
			name: 'agent',
			id: 'conversation',
		});

		store.start();
		firstObservation.emit({
			conversation: conversation([
				{
					id: 'entry-user',
					role: 'user',
					purpose: 'user',
					display: 'visible',
					parts: [{ type: 'text', text: 'hello', state: 'done' }],
				},
			]),
			offset: 'offset-1',
			phase: 'live',
			error: undefined,
		});

		store.stop();
		expect(firstObservation.close).toHaveBeenCalledOnce();
		expect(store.getSnapshot().messages.map((message) => message.id)).toEqual(['entry-user']);

		store.start();
		expect(observe).toHaveBeenCalledTimes(2);
		expect(store.getSnapshot().messages.map((message) => message.id)).toEqual(['entry-user']);

		secondObservation.emit({
			conversation: conversation([
				{
					id: 'entry-user',
					role: 'user',
					purpose: 'user',
					display: 'visible',
					parts: [{ type: 'text', text: 'hello', state: 'done' }],
				},
				{
					id: 'entry-assistant',
					role: 'assistant',
					purpose: 'assistant',
					display: 'visible',
					parts: [],
					metadata: { model: { provider: 'test', id: 'model' } },
				},
			]),
			offset: 'offset-2',
			phase: 'live',
			error: undefined,
		});

		expect(store.getSnapshot().messages.map((message) => message.id)).toEqual([
			'entry-user',
			'entry-assistant',
		]);
		store.stop();
	});

	it('threads a client-supplied submissionId through sendMessage to agents.send', async () => {
		const observation = createFakeObservation();
		const send = vi.fn(async () => ({
			streamUrl: 'https://flue.test/stream',
			offset: '-1',
			submissionId: 'send-1',
		}));
		const store = createFlueAgentStore({
			client: { agents: { observe: () => observation, send } } as unknown as FlueClient,
			name: 'agent',
			id: 'conversation',
		});

		store.start();
		await store.sendMessage('hello', { submissionId: 'send-1' });

		expect(send).toHaveBeenCalledWith('agent', 'conversation', {
			message: { kind: 'user', body: 'hello' },
			submissionId: 'send-1',
		});
	});
});
