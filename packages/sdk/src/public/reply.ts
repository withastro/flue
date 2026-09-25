/**
 * `readSubmissionReply()` — extract one submission's reply from a
 * materialized conversation.
 *
 * A pure function over the shapes `history()` and `observe()` already return;
 * it performs no I/O. The client's `read()` composes it with `wait()` and
 * `history()` for the one-shot round trip; reach for it directly when you
 * already hold the conversation and want no extra fetch:
 *
 * ```ts
 * const state = observation.getSnapshot().conversation;
 * const reply = readSubmissionReply(state, admission.submissionId);
 * ```
 *
 * Mirrors the reply projection the runtime's `init().read()` resolves with,
 * so a reply read over HTTP and one read in-process agree byte for byte.
 */

import type { FlueConversationMessage, FlueConversationSettlement } from './conversation.ts';

/** The reply a settled submission produced, read from the conversation. */
export interface AgentSubmissionReply {
	/** Final assistant text produced by the submission ('' when none). */
	text: string;
	/**
	 * Named client data parts (`useDataWriter`) on the reply message, keyed
	 * by part name, each in emit order.
	 */
	data: Record<string, unknown[]>;
	/** Agent-authored response metadata (`useResponseStart`/`useResponseFinish`), when present. */
	metadata?: Record<string, unknown>;
}

/**
 * Read the reply the given submission produced: the final assistant message
 * stamped with its `submissionId`. A submission that joined a busy response
 * settles under the host's response — its settlement's
 * `answeredBySubmissionId` names the host, whose final assistant message is
 * the coalesced reply that answered it. Settlements without that linkage
 * (recorded before it shipped) fall back to the conversation's last
 * assistant message — only when the conversation is demonstrably the whole
 * head of the transcript (it carries settlements and no older-page cursor).
 * On a bounded window the last loaded message may belong to a different
 * submission, so the reply resolves empty instead; a bounded conversation
 * only finds replies inside its window.
 *
 * Accepts a `history()` snapshot or an `observe()` state. `settlements` is
 * required, which excludes `historyBefore()` pages: a page is a slice of
 * older history, never the conversation a reply is read from.
 */
export function readSubmissionReply(
	conversation: {
		messages: FlueConversationMessage[];
		settlements: FlueConversationSettlement[];
		before?: string | null;
	},
	submissionId: string,
): AgentSubmissionReply {
	const assistantMessages = conversation.messages.filter((message) => message.role === 'assistant');
	const own = assistantMessages.filter((message) => message.submissionId === submissionId);
	let reply = own.at(-1);
	if (!reply) {
		const settlement = conversation.settlements?.find(
			(entry) => entry.submissionId === submissionId,
		);
		reply =
			settlement?.answeredBySubmissionId !== undefined
				? assistantMessages
						.filter((message) => message.submissionId === settlement.answeredBySubmissionId)
						.at(-1)
				: isCompleteHead(conversation)
					? assistantMessages.at(-1)
					: undefined;
	}
	if (!reply) return { text: '', data: {} };

	const text = reply.parts
		.filter(
			(part): part is Extract<(typeof reply.parts)[number], { type: 'text' }> =>
				part.type === 'text' && typeof part.text === 'string',
		)
		.map((part) => part.text)
		.join('\n\n');

	const data: Record<string, unknown[]> = {};
	for (const part of reply.parts) {
		if (!part.type.startsWith('data-')) continue;
		const name = part.type.slice('data-'.length);
		const values = data[name] ?? [];
		values.push((part as { data: unknown }).data);
		data[name] = values;
	}

	return {
		text,
		data,
		...(reply.metadata !== undefined ? { metadata: reply.metadata } : {}),
	};
}

/**
 * Whether a conversation is the whole transcript through its head: a snapshot
 * or observation state (settlements present — pages carry none) whose window
 * reaches the start (`before` absent on an unbounded read, `null` on a
 * bounded one that covers everything).
 */
function isCompleteHead(conversation: { settlements?: unknown; before?: unknown }): boolean {
	return Array.isArray(conversation.settlements) && typeof conversation.before !== 'string';
}
