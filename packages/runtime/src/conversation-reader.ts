import {
	createReducedInstanceState,
	type ReducedInstanceState,
	reduceConversationRecordsInPlace,
} from './conversation-reducer.ts';
import type { ConversationStreamStore } from './runtime/conversation-stream-store.ts';

// Both loaders fold in place: they build a state nothing else references yet
// and discard it wholesale when a record throws, so the per-batch
// failure-atomicity clone the incremental writer needs would cost
// O(batches x state size) here for nothing.

export async function loadReducedConversationState(options: {
	store: ConversationStreamStore;
	path: string;
}): Promise<ReducedInstanceState> {
	const state = createReducedInstanceState();
	let offset = '-1';
	while (true) {
		const read = await options.store.read(options.path, { offset, limit: 1000 });
		for (const batch of read.batches) {
			reduceConversationRecordsInPlace(state, batch.records, batch.offset);
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
	const state = createReducedInstanceState();
	if (options.offset === '-1') return state;
	let offset = '-1';
	while (true) {
		const read = await options.store.read(options.path, { offset, limit: 1000 });
		for (const batch of read.batches) {
			reduceConversationRecordsInPlace(state, batch.records, batch.offset);
			offset = batch.offset;
			if (offset === options.offset) return state;
		}
		if (read.upToDate) {
			await options.store.read(options.path, { offset: options.offset, limit: 1 });
			throw new Error('[flue] Canonical conversation offset is not a batch boundary.');
		}
	}
}
