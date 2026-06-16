import type {
	EventStreamMeta,
	EventStreamReadResult,
	EventStreamStore,
} from '@flue/runtime/adapter';
import {
	clampLimit,
	DEFAULT_READ_LIMIT,
	formatOffset,
	MAX_READ_LIMIT,
	parseOffset,
} from '@flue/runtime/adapter';
import type { MongoRunner } from './mongodb-runner.ts';
import { collectionName } from './schema.ts';
import { type StoredValue, ValueStore } from './value-store.ts';

export class MongoEventStreamStore implements EventStreamStore {
	private listeners = new Map<string, Set<() => void>>();
	private values: ValueStore;
	constructor(
		private runner: MongoRunner,
		private prefix: string,
	) {
		this.values = new ValueStore(runner, prefix);
	}
	async createStream(path: string): Promise<void> {
		await this.meta().updateOne(
			{ _id: path },
			{ $setOnInsert: { path, nextOffset: 0, closed: false } },
			{ upsert: true },
		);
	}
	async appendEvent(path: string, event: unknown): Promise<string> {
		const pointer = await this.values.stage(`event:${path}:${crypto.randomUUID()}`, event);
		let committed = false;
		try {
			const offset = await this.runner.transaction(async (tx) => {
				await this.values.publish(pointer, tx);
				const meta = await tx
					.collection(collectionName(this.prefix, 'event_streams'))
					.findOneAndUpdate(
						{ _id: path, closed: false },
						{ $inc: { nextOffset: 1 } },
						{ returnDocument: 'before' },
					);
				if (!meta) {
					const existing = await tx
						.collection(collectionName(this.prefix, 'event_streams'))
						.findOne({ _id: path });
					throw new TypeError(
						existing
							? `Event stream "${path}" is closed.`
							: `Event stream "${path}" does not exist.`,
					);
				}
				const value = Number(meta.nextOffset);
				await tx
					.collection(collectionName(this.prefix, 'event_entries'))
					.insertOne({ _id: `${path}:${value}`, path, offset: value, data: pointer });
				return value;
			});
			committed = true;
			this.notify(path);
			return formatOffset(offset);
		} catch (error) {
			if (!committed) await this.values.discardStaged(pointer);
			throw error;
		}
	}
	async readEvents(
		path: string,
		opts?: { offset?: string; limit?: number },
	): Promise<EventStreamReadResult> {
		const meta = await this.getStreamMeta(path);
		if (!meta) return { events: [], nextOffset: formatOffset(-1), upToDate: true, closed: false };
		if (opts?.offset === 'now')
			return { events: [], nextOffset: meta.nextOffset, upToDate: true, closed: meta.closed };
		const start = !opts?.offset || opts.offset === '-1' ? -1 : parseOffset(opts.offset);
		const limit = clampLimit(opts?.limit, DEFAULT_READ_LIMIT, MAX_READ_LIMIT);
		const rows = await this.entries().find(
			{ path, offset: { $gt: start } },
			{ sort: { offset: 1 }, limit: limit + 1 },
		);
		const page = rows.slice(0, limit);
		const events = [];
		for (const row of page)
			events.push({
				offset: formatOffset(Number(row.offset)),
				data: await this.values.read(row.data as unknown as StoredValue),
			});
		return {
			events,
			nextOffset: events.at(-1)?.offset ?? formatOffset(start),
			upToDate: rows.length <= limit,
			closed: meta.closed,
		};
	}
	async closeStream(path: string): Promise<void> {
		await this.meta().updateOne({ _id: path }, { $set: { closed: true } });
		this.notify(path);
	}
	async getStreamMeta(path: string): Promise<EventStreamMeta | null> {
		const row = await this.meta().findOne({ _id: path });
		return row
			? { nextOffset: formatOffset(Number(row.nextOffset) - 1), closed: Boolean(row.closed) }
			: null;
	}
	subscribe(path: string, listener: () => void): () => void {
		const set = this.listeners.get(path) ?? new Set();
		set.add(listener);
		this.listeners.set(path, set);
		return () => {
			set.delete(listener);
			if (!set.size) this.listeners.delete(path);
		};
	}
	private notify(path: string) {
		for (const listener of this.listeners.get(path) ?? []) {
			try {
				listener();
			} catch {}
		}
	}
	private meta() {
		return this.runner.collection(collectionName(this.prefix, 'event_streams'));
	}
	private entries() {
		return this.runner.collection(collectionName(this.prefix, 'event_entries'));
	}
}
