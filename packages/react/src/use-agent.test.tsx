// @vitest-environment happy-dom

import type {
	AgentConversationObservation,
	AgentConversationObservationPhase,
	DeliveredAttachment,
	FlueClient,
} from '@flue/sdk';
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useFlueAgent } from './use-agent.ts';

function activeClient() {
	let phase: AgentConversationObservationPhase = 'loading';
	const listeners = new Set<() => void>();
	const observation: AgentConversationObservation = {
		getSnapshot: () => ({ conversation: undefined, offset: undefined, phase, error: undefined }),
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		refresh() {},
		close() {},
	};
	const client = {
		url: 'https://example.com/agents/assistant/demo',
		observe: () => observation,
		async send(options: unknown) {
			sent.push(options);
			return {
				submissionId: 'submission-1',
				streamUrl: '/stream',
				offset: '0',
				uid: 'instance-1',
				deduplicated: true,
			};
		},
	} as unknown as FlueClient;
	const sent: unknown[] = [];
	return {
		client,
		sent,
		publish(nextPhase: AgentConversationObservationPhase) {
			phase = nextPhase;
			for (const listener of listeners) listener();
		},
	};
}

describe('useFlueAgent callback identities', () => {
	it('keeps active callbacks stable across external store updates', () => {
		const source = activeClient();
		const { result } = renderHook(() => useFlueAgent({ client: source.client }));
		const sendMessage = result.current.sendMessage;
		const refresh = result.current.refresh;

		act(() => source.publish('live'));

		expect(result.current.sendMessage).toBe(sendMessage);
		expect(result.current.refresh).toBe(refresh);
	});

	it('passes SDK send controls through and returns the full receipt', async () => {
		const source = activeClient();
		const { result } = renderHook(() => useFlueAgent({ client: source.client }));
		const images: DeliveredAttachment[] = [
			{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
		];

		const receipt = await result.current.sendMessage('hello', {
			idempotencyKey: 'key-1',
			uid: 'instance-1',
			images,
		});

		expect(receipt).toEqual({
			submissionId: 'submission-1',
			streamUrl: '/stream',
			offset: '0',
			uid: 'instance-1',
			deduplicated: true,
		});
		expect(source.sent).toHaveLength(1);
		expect(source.sent[0]).toEqual({
			idempotencyKey: 'key-1',
			uid: 'instance-1',
			message: {
				kind: 'user',
				body: 'hello',
				attachments: images,
			},
		});
	});

	it('sends only the message when no options are given', async () => {
		const source = activeClient();
		const { result } = renderHook(() => useFlueAgent({ client: source.client }));

		await result.current.sendMessage('hello');

		expect(source.sent).toHaveLength(1);
		expect(source.sent[0]).toEqual({ message: { kind: 'user', body: 'hello' } });
	});

	it('keeps dormant callbacks stable across renders', async () => {
		const { result, rerender } = renderHook(() => useFlueAgent());
		const sendMessage = result.current.sendMessage;
		const refresh = result.current.refresh;

		rerender();

		expect(result.current.sendMessage).toBe(sendMessage);
		expect(result.current.refresh).toBe(refresh);
		await expect(result.current.sendMessage('hello')).rejects.toThrow(
			'cannot send without a conversation url',
		);
	});
});
