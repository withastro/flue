/**
 * Durable fold checkpoints: a serialized `ReducedInstanceState` at a batch
 * offset, stored through the optional `ConversationStreamStore` checkpoint
 * capability so loads fold only the suffix appended since the checkpoint
 * instead of replaying the stream from its origin.
 *
 * A checkpoint is strictly a cache over the log — never authoritative, safe
 * to discard, rebuilt by replay when absent. Every validation failure
 * (format version, incarnation, a checkpoint ahead of the log head, a parse
 * error, a store error) degrades to the from-scratch load with one
 * `console.warn` per path per process: a silent rebuild is correct, a silent
 * *permanent* degradation is not, so the warn keeps it observable. The cold
 * path must never throw on checkpoint problems — on Cloudflare a load runs
 * inside request/alarm handling where a decode crash would loop.
 *
 * The codec is schema-aware rather than a generic structural walker: record
 * bodies and `state_write` values are arbitrary user JSON, so a sentinel
 * convention could collide with data. Each known Map/Set container is
 * encoded explicitly as an insertion-ordered entry array (`recordsById`
 * insertion order is load-bearing for stream-order scans). The decoded
 * state matches a replayed one to property-access equivalence:
 * undefined-valued optional keys normalize to absent, which no consumer
 * distinguishes — the fold and every projection read fields by access,
 * never by key presence.
 */

import {
	createReducedInstanceState,
	REDUCED_STATE_FORMAT,
	type ReducedConversationState,
	type ReducedInstanceState,
} from './conversation-reducer.ts';
import type {
	ConversationFoldCheckpoint,
	ConversationStreamStore,
} from './runtime/conversation-stream-store.ts';
import { parseOffset } from './runtime/stream-offsets.ts';

/**
 * Appends between the writer's durable checkpoints. Low enough that a cold
 * load's suffix stays small next to the stream, high enough that the
 * once-per-interval O(state) encode disappears against the per-append work.
 */
export const FOLD_CHECKPOINT_INTERVAL = 64;

type EncodedEntries = Array<[string, unknown]>;

/** Serialize a reduced state to the checkpoint's canonical JSON `data`. */
function encodeReducedInstanceState(state: ReducedInstanceState): string {
	return JSON.stringify({
		...state,
		conversationScopes: [...state.conversationScopes],
		recordsById: [...state.recordsById],
		state: [...state.state],
		conversations: [...state.conversations].map(([conversationId, conversation]) => [
			conversationId,
			{
				...conversation,
				entries: [...conversation.entries].map(([entryId, entry]) => [
					entryId,
					entry.type === 'message' && entry.attachmentRefs
						? { ...entry, attachmentRefs: [...entry.attachmentRefs] }
						: entry,
				]),
				inProgressMessages: [...conversation.inProgressMessages].map(([messageId, message]) => [
					messageId,
					{
						...message,
						blocks: [...message.blocks],
						blockIndexes: [...message.blockIndexes],
					},
				]),
				toolOutcomes: [...conversation.toolOutcomes],
				childConversations: [...conversation.childConversations],
				responseMetadata: [...conversation.responseMetadata],
				responseDataParts: [...conversation.responseDataParts],
				lastAssistantEntryBySubmission: [...conversation.lastAssistantEntryBySubmission],
				attemptScopedRecordIds: [...conversation.attemptScopedRecordIds],
			},
		]),
	});
}

/**
 * Rebuild a reduced state from checkpoint `data`. Throws on any structural
 * mismatch — callers treat every throw as "no checkpoint".
 */
function decodeReducedInstanceState(data: string): ReducedInstanceState {
	const parsed = JSON.parse(data) as Record<string, unknown>;
	const state = {
		...parsed,
		conversationScopes: decodeMap(parsed.conversationScopes),
		recordsById: decodeMap(parsed.recordsById),
		state: decodeMap(parsed.state),
		conversations: new Map(
			entriesOf(parsed.conversations).map(([conversationId, encoded]) => {
				const conversation = encoded as Record<string, unknown>;
				return [
					conversationId,
					{
						...conversation,
						entries: new Map(
							entriesOf(conversation.entries).map(([entryId, entry]) => {
								const value = entry as { type?: string; attachmentRefs?: unknown };
								return [
									entryId,
									value.type === 'message' && value.attachmentRefs !== undefined
										? { ...value, attachmentRefs: decodeMap(value.attachmentRefs) }
										: value,
								];
							}),
						),
						inProgressMessages: new Map(
							entriesOf(conversation.inProgressMessages).map(([messageId, encodedMessage]) => {
								const message = encodedMessage as Record<string, unknown>;
								return [
									messageId,
									{
										...message,
										blocks: decodeMap(message.blocks),
										blockIndexes: new Set(arrayOf(message.blockIndexes)),
									},
								];
							}),
						),
						toolOutcomes: decodeMap(conversation.toolOutcomes),
						childConversations: decodeMap(conversation.childConversations),
						responseMetadata: decodeMap(conversation.responseMetadata),
						responseDataParts: decodeMap(conversation.responseDataParts),
						lastAssistantEntryBySubmission: decodeMap(conversation.lastAssistantEntryBySubmission),
						attemptScopedRecordIds: decodeMap(conversation.attemptScopedRecordIds),
					} as unknown as ReducedConversationState,
				];
			}),
		),
	} as ReducedInstanceState;
	if (typeof state.recordsThroughOffset !== 'string') {
		throw new Error('[flue] Fold checkpoint state is missing its offset.');
	}
	return state;
}

function entriesOf(value: unknown): EncodedEntries {
	if (!Array.isArray(value) || value.some((entry) => !Array.isArray(entry) || entry.length !== 2)) {
		throw new Error('[flue] Fold checkpoint state container is not an entry array.');
	}
	return value as EncodedEntries;
}

function arrayOf(value: unknown): unknown[] {
	if (!Array.isArray(value)) {
		throw new Error('[flue] Fold checkpoint state container is not an array.');
	}
	return value;
}

function decodeMap<V = unknown>(value: unknown): Map<string, V> {
	return new Map(entriesOf(value) as Array<[string, V]>);
}

const warnedPaths = new Set<string>();

function warnFoldCheckpoint(path: string, message: string): void {
	if (warnedPaths.has(path)) return;
	warnedPaths.add(path);
	console.warn(`[flue] Conversation fold checkpoint for "${path}" ${message}.`);
}

/**
 * The reduced state seeded from the store's newest usable fold checkpoint
 * (optionally bounded to `atOrBefore` a target offset), or a fresh empty
 * state when the store lacks the capability or the checkpoint fails any
 * validation. The caller always folds the remaining suffix; the returned
 * state's `recordsThroughOffset` says where to start.
 */
export async function seedReducedConversationState(
	store: ConversationStreamStore,
	path: string,
	atOrBefore?: string,
): Promise<ReducedInstanceState> {
	if (!store.getFoldCheckpoint) return createReducedInstanceState();
	try {
		const checkpoint = await store.getFoldCheckpoint(
			path,
			atOrBefore === undefined ? undefined : { atOrBefore },
		);
		if (!checkpoint) return createReducedInstanceState();
		if (checkpoint.formatVersion !== REDUCED_STATE_FORMAT) {
			warnFoldCheckpoint(
				path,
				`has format ${checkpoint.formatVersion}, runtime expects ${REDUCED_STATE_FORMAT} — folding from the origin instead`,
			);
			return createReducedInstanceState();
		}
		if (atOrBefore !== undefined && parseOffset(checkpoint.offset) > parseOffset(atOrBefore)) {
			// Defensive against a store that ignored the bound.
			return createReducedInstanceState();
		}
		const meta = await store.getMeta(path);
		if (!meta || meta.incarnation !== checkpoint.incarnation) {
			warnFoldCheckpoint(
				path,
				'was cut from another stream incarnation — folding from the origin instead',
			);
			return createReducedInstanceState();
		}
		if (parseOffset(checkpoint.offset) > parseOffset(meta.nextOffset)) {
			// The frontier rule: a checkpoint is a lower bound on knowledge,
			// never an authority on the head. Ahead-of-head means the log was
			// truncated or restored from a backup — the checkpoint must not win.
			warnFoldCheckpoint(path, 'is ahead of the stream head — folding from the origin instead');
			return createReducedInstanceState();
		}
		const state = decodeReducedInstanceState(checkpoint.data);
		if (state.recordsThroughOffset !== checkpoint.offset) {
			warnFoldCheckpoint(
				path,
				'disagrees with its own recorded offset — folding from the origin instead',
			);
			return createReducedInstanceState();
		}
		return state;
	} catch (error) {
		warnFoldCheckpoint(
			path,
			`could not be read (${error instanceof Error ? error.message : String(error)}) — folding from the origin instead`,
		);
		return createReducedInstanceState();
	}
}

/** Encode and store one head checkpoint; failures warn once and never throw. */
export function writeFoldCheckpoint(
	store: ConversationStreamStore,
	path: string,
	state: ReducedInstanceState,
	incarnation: string,
): void {
	if (!store.putFoldCheckpoint) return;
	try {
		const checkpoint: ConversationFoldCheckpoint = {
			offset: state.recordsThroughOffset,
			incarnation,
			formatVersion: REDUCED_STATE_FORMAT,
			data: encodeReducedInstanceState(state),
		};
		void store.putFoldCheckpoint(path, checkpoint).catch((error: unknown) => {
			warnFoldCheckpoint(
				path,
				`could not be written (${error instanceof Error ? error.message : String(error)})`,
			);
		});
	} catch (error) {
		warnFoldCheckpoint(
			path,
			`could not be encoded (${error instanceof Error ? error.message : String(error)})`,
		);
	}
}
