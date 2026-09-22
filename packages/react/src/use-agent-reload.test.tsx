// @vitest-environment happy-dom
//
// Regression coverage for https://github.com/withastro/flue/issues/753.
//
// Before a reload, `status` stays `streaming` from admission until the
// submission settles (the reducer remembers the admission receipt in memory).
// After a reload, the same conversation snapshots must still report `streaming`
// while a submission is unsettled — the reducer derives the active submission
// from the reload-safe conversation (message `submissionId`s minus settled
// ids) instead of relying on the in-memory admission event.
import type {
	AgentConversationObservation,
	AgentConversationObservationPhase,
	AgentSendResult,
	FlueClient,
	FlueConversationMessage,
	FlueConversationPart,
	FlueConversationSettlement,
	FlueConversationState,
} from '@flue/sdk';
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useFlueAgent } from './use-agent.ts';

function stubClient(overrides: { send?: () => Promise<AgentSendResult> } = {}) {
	let phase: AgentConversationObservationPhase = 'loading';
	let conversation: FlueConversationState | undefined;
	const listeners = new Set<() => void>();
	const observation: AgentConversationObservation = {
		getSnapshot: () => ({ conversation, offset: undefined, phase, error: undefined }),
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
		async send() {
			return overrides.send
				? overrides.send()
				: { submissionId: 'submission-1', streamUrl: '/stream', offset: '0', uid: 'instance-1' };
		},
	} as unknown as FlueClient;
	return {
		client,
		publish(next: FlueConversationState) {
			phase = 'live';
			conversation = next;
			for (const listener of listeners) listener();
		},
	};
}

function userMessage(
	submissionId: string,
	overrides: Partial<FlueConversationMessage> = {},
): FlueConversationMessage {
	return {
		id: `prompt-${submissionId}`,
		role: 'user',
		purpose: 'user',
		display: 'visible',
		submissionId,
		parts: [{ type: 'text', text: 'Build a house', state: 'done' }],
		...overrides,
	};
}

function assistantMessage(
	submissionId: string,
	parts: FlueConversationPart[],
	overrides: Partial<FlueConversationMessage> = {},
): FlueConversationMessage {
	return {
		id: `reply-${submissionId}`,
		role: 'assistant',
		purpose: 'assistant',
		display: 'visible',
		submissionId,
		parts,
		...overrides,
	};
}

function conversation(
	messages: FlueConversationMessage[],
	settlements: FlueConversationSettlement[] = [],
): FlueConversationState {
	return { conversationId: 'demo', messages, settlements };
}

const tool = { type: 'dynamic-tool', toolName: 'build', toolCallId: 'tool-1', input: {} } as const;

const reloadRows: {
	name: string;
	conversation: FlueConversationState;
	expected: string;
}[] = [
	{
		name: 'prompt admitted, no output yet',
		conversation: conversation([userMessage('submission-1')]),
		expected: 'streaming',
	},
	{
		name: 'assistant text streaming',
		conversation: conversation([
			userMessage('submission-1'),
			assistantMessage('submission-1', [{ type: 'text', text: 'Building', state: 'streaming' }]),
		]),
		expected: 'streaming',
	},
	{
		name: 'tool call running',
		conversation: conversation([
			userMessage('submission-1'),
			assistantMessage('submission-1', [
				{ type: 'text', text: 'Building', state: 'done' },
				{ ...tool, state: 'input-available' },
			]),
		]),
		expected: 'streaming',
	},
	{
		name: 'settled',
		conversation: conversation(
			[
				userMessage('submission-1'),
				assistantMessage('submission-1', [
					{ type: 'text', text: 'Building', state: 'done' },
					{ ...tool, state: 'output-available', output: 'Built' },
				]),
			],
			[{ submissionId: 'submission-1', outcome: 'completed' }],
		),
		expected: 'idle',
	},
];

describe('useFlueAgent status before a reload', () => {
	it.each(reloadRows)('$name → $expected', async ({ conversation: next, expected }) => {
		const source = stubClient();
		const { result } = renderHook(() => useFlueAgent({ client: source.client }));
		await act(() => result.current.sendMessage('Build a house'));
		act(() => source.publish(next));
		expect(result.current.status).toBe(expected);
	});
});

describe('useFlueAgent status after a reload', () => {
	it.each(reloadRows)('$name → $expected', ({ conversation: next, expected }) => {
		const source = stubClient();
		const { result } = renderHook(() => useFlueAgent({ client: source.client }));
		act(() => source.publish(next));
		expect(result.current.status).toBe(expected);
	});
});

describe('useFlueAgent status after a reload edge cases', () => {
	it('reports idle for a failed settlement', () => {
		const source = stubClient();
		const { result } = renderHook(() => useFlueAgent({ client: source.client }));
		act(() =>
			source.publish(
				conversation(
					[userMessage('submission-1')],
					[{ submissionId: 'submission-1', outcome: 'failed', error: { message: 'boom' } }],
				),
			),
		);
		expect(result.current.status).toBe('idle');
		expect(result.current.error).toBeUndefined();
	});

	it('reports idle for an aborted settlement', () => {
		const source = stubClient();
		const { result } = renderHook(() => useFlueAgent({ client: source.client }));
		act(() =>
			source.publish(
				conversation(
					[userMessage('submission-1')],
					[{ submissionId: 'submission-1', outcome: 'aborted' }],
				),
			),
		);
		expect(result.current.status).toBe('idle');
	});

	it('stays streaming when one of several submissions is unsettled', () => {
		const source = stubClient();
		const { result } = renderHook(() => useFlueAgent({ client: source.client }));
		act(() =>
			source.publish(
				conversation(
					[
						userMessage('submission-1'),
						assistantMessage('submission-1', [{ type: 'text', text: 'Done', state: 'done' }]),
						userMessage('submission-2'),
					],
					[{ submissionId: 'submission-1', outcome: 'completed' }],
				),
			),
		);
		expect(result.current.status).toBe('streaming');
	});

	it('reports idle when a joined submission is settled via answeredBySubmissionId', () => {
		const source = stubClient();
		const { result } = renderHook(() => useFlueAgent({ client: source.client }));
		act(() =>
			source.publish(
				conversation(
					[
						userMessage('submission-1'),
						assistantMessage('submission-1', [{ type: 'text', text: 'Done', state: 'done' }]),
						userMessage('submission-2'),
					],
					[
						{ submissionId: 'submission-1', outcome: 'completed' },
						{
							submissionId: 'submission-2',
							outcome: 'completed',
							answeredBySubmissionId: 'submission-1',
						},
					],
				),
			),
		);
		expect(result.current.status).toBe('idle');
	});

	it('stays streaming when a joined submission settled but its host is still unsettled', () => {
		const source = stubClient();
		const { result } = renderHook(() => useFlueAgent({ client: source.client }));
		act(() =>
			source.publish(
				conversation(
					[userMessage('submission-1'), userMessage('submission-2')],
					[
						{
							submissionId: 'submission-2',
							outcome: 'completed',
							answeredBySubmissionId: 'submission-1',
						},
					],
				),
			),
		);
		expect(result.current.status).toBe('streaming');
	});
});

describe('useFlueAgent pre-reload semantics', () => {
	it('pins error on the last settled local submission', async () => {
		const source = stubClient();
		const { result } = renderHook(() => useFlueAgent({ client: source.client }));
		await act(() => result.current.sendMessage('Build a house'));
		act(() =>
			source.publish(
				conversation(
					[userMessage('submission-1')],
					[{ submissionId: 'submission-1', outcome: 'failed', error: { message: 'boom' } }],
				),
			),
		);
		expect(result.current.status).toBe('error');
		expect(result.current.error?.message).toBe('boom');
	});

	it('reports idle for an aborted local submission', async () => {
		const source = stubClient();
		const { result } = renderHook(() => useFlueAgent({ client: source.client }));
		await act(() => result.current.sendMessage('Build a house'));
		act(() =>
			source.publish(
				conversation(
					[userMessage('submission-1')],
					[{ submissionId: 'submission-1', outcome: 'aborted' }],
				),
			),
		);
		expect(result.current.status).toBe('idle');
	});

	it('reports submitted and renders the optimistic echo while admission is pending', async () => {
		let admit!: (receipt: AgentSendResult) => void;
		const source = stubClient({
			send: () => new Promise((resolve) => (admit = resolve)),
		});
		const { result } = renderHook(() => useFlueAgent({ client: source.client }));

		act(() => void result.current.sendMessage('Build a house'));

		expect(result.current.status).toBe('submitted');
		expect(result.current.messages).toHaveLength(1);
		expect(result.current.messages[0]?.parts[0]).toMatchObject({
			type: 'text',
			text: 'Build a house',
		});

		await act(async () =>
			admit({ submissionId: 'submission-1', streamUrl: '/stream', offset: '0', uid: 'instance-1' }),
		);

		// Admitted but not yet observed in the conversation: still pending.
		expect(result.current.status).toBe('submitted');

		act(() => source.publish(conversation([userMessage('submission-1')])));
		expect(result.current.status).toBe('streaming');
	});

	it('retains a failed send and pins error until superseded', async () => {
		const source = stubClient({ send: () => Promise.reject(new Error('network down')) });
		const { result } = renderHook(() => useFlueAgent({ client: source.client }));

		await act(() =>
			expect(result.current.sendMessage('Build a house')).rejects.toThrow('network down'),
		);

		expect(result.current.status).toBe('error');
		expect(result.current.error?.message).toBe('network down');
		expect(result.current.failedSends).toHaveLength(1);
		expect(result.current.failedSends[0]?.message).toBe('Build a house');
		expect(
			result.current.messages.some(
				(message) => message.parts[0]?.type === 'text' && message.parts[0].text === 'Build a house',
			),
		).toBe(true);
	});
});
