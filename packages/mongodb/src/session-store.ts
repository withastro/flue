import { randomUUID } from 'node:crypto';
import type { SessionData, SessionStore } from '@flue/runtime/adapter';
import { hydratePersistedSessionEntry, prepareSessionEntry } from '@flue/runtime/adapter';
import type { MongoRunner } from './mongodb-runner.ts';
import { collectionName } from './schema.ts';
import { type StoredValue, ValueStore } from './value-store.ts';

export class MongoSessionStore implements SessionStore {
	private values: ValueStore;
	constructor(
		private runner: MongoRunner,
		private prefix: string,
	) {
		this.values = new ValueStore(runner, prefix);
	}

	async save(id: string, data: SessionData): Promise<void> {
		const generation = randomUUID();
		const { entries, ...header } = data;
		const pointers: StoredValue[] = [];
		let committed = false;
		try {
			const headerPointer = await this.values.stage(`session:${id}:${generation}:header`, header);
			pointers.push(headerPointer);
			for (const entry of entries)
				pointers.push(
					await this.values.stage(`session:${id}:${generation}:entry:${entry.id}`, {
						id: entry.id,
						...prepareSessionEntry(entry),
					}),
				);
			const previousGeneration = await this.runner.transaction(async (tx) => {
				for (const pointer of pointers) await this.values.publish(pointer, tx);
				const sessions = tx.collection(collectionName(this.prefix, 'sessions'));
				const previous = await sessions.findOne({ _id: id });
				await tx
					.collection(collectionName(this.prefix, 'session_entries'))
					.deleteMany({ sessionId: id, generation });
				if (entries.length)
					await tx
						.collection(collectionName(this.prefix, 'session_entries'))
						.insertMany(
							entries.map((entry, position) => ({
								_id: `${id}:${generation}:${position}`,
								sessionId: id,
								generation,
								position,
								entryId: entry.id,
								pointer: pointers[position + 1],
							})),
						);
				await sessions.updateOne(
					{ _id: id },
					{
						$set: {
							generation,
							header: headerPointer,
							entryCount: entries.length,
							updatedAt: Date.now(),
						},
					},
					{ upsert: true },
				);
				return previous?.generation ? String(previous.generation) : undefined;
			});
			committed = true;
			if (previousGeneration && previousGeneration !== generation)
				await this.reclaimGeneration(id, previousGeneration).catch(() => undefined);
		} catch (error) {
			if (!committed)
				for (const pointer of pointers)
					await this.values.discardStaged(pointer).catch(() => undefined);
			throw error;
		}
	}

	async load(id: string): Promise<SessionData | null> {
		return this.runner.transaction(async (tx) => {
			const row = await tx.collection(collectionName(this.prefix, 'sessions')).findOne({ _id: id });
			if (!row) return null;
			const header = (await this.values.read(row.header as unknown as StoredValue, tx)) as Omit<
				SessionData,
				'entries'
			>;
			const entryRows = await tx
				.collection(collectionName(this.prefix, 'session_entries'))
				.find({ sessionId: id, generation: row.generation }, { sort: { position: 1 } });
			if (entryRows.length !== Number(row.entryCount))
				throw new TypeError('Persisted MongoDB session generation is incomplete.');
			const entries = [];
			for (const entryRow of entryRows) {
				const persisted = (await this.values.read(
					entryRow.pointer as unknown as StoredValue,
					tx,
				)) as {
					value: SessionData['entries'][number];
					chunks: Parameters<typeof hydratePersistedSessionEntry>[1];
				};
				entries.push(hydratePersistedSessionEntry(persisted.value, persisted.chunks));
			}
			return { ...header, entries };
		});
	}

	async delete(id: string): Promise<void> {
		const generation = await this.runner.transaction(async (tx) => {
			const sessions = tx.collection(collectionName(this.prefix, 'sessions'));
			const current = await sessions.findOne({ _id: id });
			await sessions.deleteOne({ _id: id });
			return current?.generation ? String(current.generation) : undefined;
		});
		if (generation) await this.reclaimGeneration(id, generation).catch(() => undefined);
	}

	private async reclaimGeneration(id: string, generation: string): Promise<void> {
		const entries = await this.runner
			.collection(collectionName(this.prefix, 'session_entries'))
			.find({ sessionId: id, generation }, { limit: 1000 });
		await this.runner
			.collection(collectionName(this.prefix, 'session_entries'))
			.deleteMany({ sessionId: id, generation });
		const registry = await this.runner
			.collection(collectionName(this.prefix, 'value_generations'))
			.find(
				{ owner: { $regex: `^session:${escapeRegex(id)}:${escapeRegex(generation)}:` } },
				{ limit: 1000 },
			);
		const pointers = registry.map((row) => ({
			owner: String(row.owner),
			generation: String(row._id),
			count: Number(row.count),
		}));
		for (const row of entries)
			if (
				row.pointer &&
				!pointers.some((pointer) => pointer.generation === (row.pointer as StoredValue).generation)
			)
				pointers.push(row.pointer as StoredValue);
		for (const pointer of pointers) await this.values.retire(pointer);
	}
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
