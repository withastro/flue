import type { ConversationRecord } from './conversation-records.ts';
import {
	createReducedInstanceState,
	type ReducedInstanceState,
	reduceConversationRecords,
} from './conversation-reducer.ts';
import type {
	ConversationSnapshotStore,
	ConversationStreamStore,
} from './runtime/conversation-stream-store.ts';

export const CONVERSATION_SNAPSHOT_VERSION = 1;
export const CONVERSATION_REDUCER_VERSION = 1;

export async function loadReducedConversationState(options: {
	store: ConversationStreamStore;
	path: string;
	snapshots?: ConversationSnapshotStore;
	streamIncarnation?: string;
}): Promise<ReducedInstanceState> {
	let state = createReducedInstanceState();
	let offset = '-1';
	try {
		const snapshot = await options.snapshots?.load(options.path);
		if (
			snapshot?.version === CONVERSATION_SNAPSHOT_VERSION &&
			snapshot.reducerVersion === CONVERSATION_REDUCER_VERSION &&
			(options.streamIncarnation === undefined ||
				snapshot.streamIncarnation === options.streamIncarnation)
		) {
			state = decodeReducedInstanceState(snapshot.state);
			offset = snapshot.streamOffset;
		}
	} catch {
		await options.snapshots?.delete(options.path).catch(() => {});
	}
	while (true) {
		const read = await options.store.read(options.path, { offset, limit: 1000 });
		for (const batch of read.batches) {
			state = reduceConversationRecords(state, batch.records, batch.offset);
			offset = batch.offset;
		}
		if (read.upToDate) return state;
	}
}

export async function loadReducedConversationPrefix(options: {
	store: ConversationStreamStore;
	path: string;
	offset: string;
}): Promise<ReducedInstanceState> {
	let state = createReducedInstanceState();
	if (options.offset === '-1') return state;
	let offset = '-1';
	while (true) {
		const read = await options.store.read(options.path, { offset, limit: 1000 });
		for (const batch of read.batches) {
			state = reduceConversationRecords(state, batch.records, batch.offset);
			offset = batch.offset;
			if (offset === options.offset) return state;
		}
		if (read.upToDate) {
			await options.store.read(options.path, { offset: options.offset, limit: 1 });
			throw new Error('[flue] Canonical conversation offset is not a batch boundary.');
		}
	}
}

export function encodeReducedInstanceState(state: ReducedInstanceState): unknown {
	return {
		recordsThroughOffset: state.recordsThroughOffset,
		records: [...state.recordsById.values()],
	};
}

export function decodeReducedInstanceState(value: unknown): ReducedInstanceState {
	if (!value || typeof value !== 'object' || !('records' in value) || !Array.isArray(value.records)) {
		throw new Error('[flue] Canonical conversation snapshot is malformed.');
	}
	const offset =
		'recordsThroughOffset' in value && typeof value.recordsThroughOffset === 'string'
			? value.recordsThroughOffset
			: '-1';
	return reduceConversationRecords(
		createReducedInstanceState(),
		value.records as ConversationRecord[],
		offset,
	);
}
