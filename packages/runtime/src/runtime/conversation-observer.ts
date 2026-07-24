/**
 * In-process observation of an agent instance's canonical conversation
 * stream.
 *
 * Two layers share this module:
 *
 * - The projection/wait primitives ({@link projectConversationRead},
 *   {@link waitForConversationData}) consumed by the HTTP read handlers
 *   (`handleAgentConversationRead`) — reading a durable batch window and
 *   projecting it into the public chunk protocol.
 * - Submission-scoped helpers ({@link observeSubmissionSettlement},
 *   {@link readSubmissionReply}) for callers that admit a direct submission
 *   in-process and want its outcome and reply without any transport: the
 *   CLI's `flue run` and the programmatic agent client.
 */

import {
	type AgentConversationSnapshot,
	type ConversationStreamChunk,
	projectAgentConversationBatch,
	projectAgentConversationSnapshot,
} from '../conversation-public.ts';
import {
	loadReducedConversationPrefix,
	loadReducedConversationState,
} from '../conversation-reader.ts';
import { reduceConversationRecords } from '../conversation-reducer.ts';
import type {
	ConversationStreamReadResult,
	ConversationStreamStore,
} from './conversation-stream-store.ts';
import { parseOffset } from './stream-offsets.ts';

export const LONG_POLL_TIMEOUT_MS = 30_000;
const DURABLE_POLL_INTERVAL_MS = 250;

type ReducedPrefix = Awaited<ReturnType<typeof loadReducedConversationPrefix>>;

/**
 * Project one durable read window into public conversation chunks,
 * advancing the reduced state batch by batch.
 */
export function projectConversationRead(
	initialState: ReducedPrefix,
	read: ConversationStreamReadResult,
): { state: ReducedPrefix; items: ConversationStreamChunk[]; offset: string } {
	let state = initialState;
	const items: ConversationStreamChunk[] = [];
	let offset = initialState.recordsThroughOffset;
	for (const batch of read.batches) {
		const previousState = state;
		state = reduceConversationRecords(state, batch.records, batch.offset);
		items.push(
			...projectAgentConversationBatch({
				state,
				previousState,
				records: batch.records,
				batchOrdinal: parseOffset(batch.offset),
			}),
		);
		offset = batch.offset;
	}
	return { state, items, offset };
}

/**
 * Wait for new durable data at `offset`, bounded by the long-poll window.
 * Returns the (possibly empty) read at deadline, or 'aborted' when the
 * signal fires first. Store change notifications wake the wait; a short
 * durable poll interval covers stores whose subscribe is advisory.
 */
export async function waitForConversationData(
	store: ConversationStreamStore,
	path: string,
	offset: string,
	signal: AbortSignal,
): Promise<ConversationStreamReadResult | 'aborted'> {
	if (signal.aborted) return 'aborted';
	const deadline = Date.now() + LONG_POLL_TIMEOUT_MS;
	let pending = false;
	let wake: (() => void) | undefined;
	const unsubscribe = store.subscribe(path, () => {
		pending = true;
		wake?.();
	});
	const onAbort = () => wake?.();
	signal.addEventListener('abort', onAbort, { once: true });
	try {
		while (true) {
			pending = false;
			const read = await store.read(path, { offset });
			if (signal.aborted) return 'aborted';
			if (read.batches.length > 0 || Date.now() >= deadline) return read;
			if (pending) continue;
			await new Promise<void>((resolve) => {
				let timer: ReturnType<typeof setTimeout>;
				const finish = () => {
					clearTimeout(timer);
					resolve();
				};
				wake = finish;
				timer = setTimeout(finish, Math.min(DURABLE_POLL_INTERVAL_MS, deadline - Date.now()));
				if (pending || signal.aborted) finish();
			});
			wake = undefined;
		}
	} finally {
		unsubscribe();
		signal.removeEventListener('abort', onAbort);
	}
}

// ─── Submission-scoped observation ──────────────────────────────────────────

/** Terminal outcome of one submission, as recorded on the conversation stream. */
export interface SubmissionSettlement {
	outcome: 'completed' | 'failed' | 'aborted';
	error?: unknown;
}

export interface ObserveSubmissionSettlementOptions {
	store: ConversationStreamStore;
	/** Canonical stream path of the instance (see `agentStreamPath`). */
	path: string;
	/** The submission whose settlement resolves the observation. */
	submissionId: string;
	/** Offset to observe from — typically the admission receipt's offset. */
	offset: string;
	/** Receives every projected chunk as it is durably recorded. */
	onEvent?: (chunk: ConversationStreamChunk) => void;
	/**
	 * Stops the observation: the promise rejects with the signal's reason.
	 * Cancelling an observation is purely local — it never touches the
	 * submission itself. A durable stop is the instance abort, whose settled
	 * outcome a live observation reports.
	 */
	signal?: AbortSignal;
}

/**
 * Observe the conversation stream until the given submission settles, and
 * return its settlement. Every projected chunk along the way is forwarded to
 * `onEvent`.
 *
 * An unsignalled wait is indefinite by design: settlement is guaranteed by
 * the runtime's bounded-recovery/terminalization invariants. The caller's
 * `signal` stops only the observation itself (see its doc above).
 *
 * Settlement is detected in both projected forms: the per-record
 * `submission-settled` chunk, and a `conversation-reset` whose snapshot
 * already contains the settlement (a reset chunk subsumes every other chunk
 * of its batch, e.g. when a compaction lands in the same durable batch).
 */
export async function observeSubmissionSettlement(
	options: ObserveSubmissionSettlementOptions,
): Promise<SubmissionSettlement> {
	const { store, path, submissionId } = options;
	// waitForConversationData wants an abort signal; without a caller signal
	// the observation is deliberately unabortable, so default to one that
	// never fires.
	const signal = options.signal ?? new AbortController().signal;
	let state = await loadReducedConversationPrefix({ store, path, offset: options.offset });
	let offset = options.offset;
	while (true) {
		throwIfAborted(options.signal);
		let read = await store.read(path, { offset });
		if (read.batches.length === 0) {
			const waited = await waitForConversationData(store, path, offset, signal);
			if (waited === 'aborted') {
				throwIfAborted(options.signal);
				continue;
			}
			read = waited;
		}
		const projected = projectConversationRead(state, read);
		state = projected.state;
		let settlement: SubmissionSettlement | undefined;
		for (const chunk of projected.items) {
			options.onEvent?.(chunk);
			settlement ??= settlementFromChunk(chunk, submissionId);
		}
		if (settlement) return settlement;
		offset = read.nextOffset;
	}
}

/** Throw the signal's reason (default `AbortError`) once it has fired. */
export function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
}

/**
 * Extract the given submission's settlement from one projected chunk, in both
 * projected forms (see {@link observeSubmissionSettlement}). Shared by the
 * in-process observation above and the Cloudflare client, which consumes the
 * same chunks over the agent DO's conversation read route.
 */
export function settlementFromChunk(
	chunk: ConversationStreamChunk,
	submissionId: string,
): SubmissionSettlement | undefined {
	if (chunk.type === 'submission-settled' && chunk.submissionId === submissionId) {
		return {
			outcome: chunk.outcome,
			...(chunk.error === undefined ? {} : { error: chunk.error }),
		};
	}
	if (chunk.type === 'conversation-reset') {
		return settlementFromSnapshot(chunk.snapshot, submissionId);
	}
	return undefined;
}

function settlementFromSnapshot(
	snapshot: AgentConversationSnapshot,
	submissionId: string,
): SubmissionSettlement | undefined {
	const settled = snapshot.settlements.find((entry) => entry.submissionId === submissionId);
	if (!settled) return undefined;
	return {
		outcome: settled.outcome,
		...(settled.error === undefined ? {} : { error: settled.error }),
	};
}

// ─── Submission reply ────────────────────────────────────────────────────────

/** The reply a settled submission produced, read from the history projection. */
export interface SubmissionReply {
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

export interface ReadSubmissionReplyOptions {
	store: ConversationStreamStore;
	/** Canonical stream path of the instance (see `agentStreamPath`). */
	path: string;
	submissionId: string;
}

/**
 * Read the reply the given submission produced: the final assistant message
 * stamped with its submissionId. A submission that joined a busy response
 * settles under the host's response — its settlement's
 * `answeredBySubmissionId` names the host, and the host's final assistant
 * message is the coalesced reply that answered it. Settlements without that
 * linkage (records that predate attempt stamping) fall back to the
 * conversation's last assistant message.
 */
export async function readSubmissionReply(
	options: ReadSubmissionReplyOptions,
): Promise<SubmissionReply> {
	const state = await loadReducedConversationState({ store: options.store, path: options.path });
	const snapshot = projectAgentConversationSnapshot(state);
	if (!snapshot) return { text: '', data: {} };
	return replyFromSnapshot(snapshot, options.submissionId);
}

/**
 * Extract a submission's reply from a materialized conversation snapshot.
 * Shared by {@link readSubmissionReply} and the Cloudflare client, which reads
 * the same snapshot over the agent DO's history route.
 */
export function replyFromSnapshot(
	snapshot: AgentConversationSnapshot,
	submissionId: string,
): SubmissionReply {
	const assistantMessages = snapshot.messages.filter((message) => message.role === 'assistant');
	const own = assistantMessages.filter((message) => message.submissionId === submissionId);
	let reply = own.at(-1);
	if (!reply) {
		// No message of its own: the settlement's derived linkage names the
		// submission whose response answered this one (the joined case). Only
		// settlements without the linkage — records that predate attempt
		// stamping — fall back to recency.
		const settlement = snapshot.settlements.find((entry) => entry.submissionId === submissionId);
		reply =
			settlement?.answeredBySubmissionId !== undefined
				? assistantMessages
						.filter((message) => message.submissionId === settlement.answeredBySubmissionId)
						.at(-1)
				: assistantMessages.at(-1);
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
