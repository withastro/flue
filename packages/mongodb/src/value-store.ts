import { randomUUID } from 'node:crypto';
import type { MongoOperations, MongoRunner } from './mongodb-runner.ts';
import { collectionName } from './schema.ts';

const PART_BYTES = 4 * 1024 * 1024;
const GC_BATCH = 100;
const STAGED_MAX_AGE_MS = 60 * 60 * 1000;

export interface StoredValue {
	owner: string;
	generation: string;
	count: number;
}

export class ValueStore {
	constructor(
		private runner: MongoRunner,
		private prefix: string,
	) {}

	async stage(owner: string, value: unknown): Promise<StoredValue> {
		const pointer = { owner, generation: randomUUID(), count: 0 };
		const text = JSON.stringify([value]);
		const parts: string[] = [];
		for (let offset = 0; offset < text.length; ) {
			let end = Math.min(text.length, offset + PART_BYTES);
			while (end > offset && Buffer.byteLength(text.slice(offset, end)) > PART_BYTES)
				end -= Math.max(1, Math.ceil((end - offset) / 8));
			parts.push(text.slice(offset, end));
			offset = end;
		}
		if (parts.length === 0) parts.push('');
		pointer.count = parts.length;
		const registry = this.runner.collection(collectionName(this.prefix, 'value_generations'));
		await registry.insertOne({
			_id: pointer.generation,
			...pointer,
			state: 'staged',
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
		try {
			await this.runner.collection(collectionName(this.prefix, 'values')).insertMany(
				parts.map((data, index) => ({
					_id: `${pointer.generation}:${index}`,
					owner,
					generation: pointer.generation,
					index,
					count: parts.length,
					data,
				})),
			);
			return pointer;
		} catch (error) {
			await this.deleteParts(pointer);
			await registry.deleteOne({ _id: pointer.generation, state: 'staged' });
			throw error;
		}
	}

	async publish(pointer: StoredValue, operations: MongoOperations): Promise<void> {
		const result = await operations
			.collection(collectionName(this.prefix, 'value_generations'))
			.updateOne(
				{ _id: pointer.generation, owner: pointer.owner, state: 'staged' },
				{ $set: { state: 'published', updatedAt: Date.now() } },
			);
		if (result.matchedCount !== 1)
			throw new TypeError('MongoDB value generation cannot be published.');
	}

	async read(pointer: StoredValue, operations: MongoOperations = this.runner): Promise<unknown> {
		const rows = await operations
			.collection(collectionName(this.prefix, 'values'))
			.find({ owner: pointer.owner, generation: pointer.generation }, { sort: { index: 1 } });
		if (
			rows.length !== pointer.count ||
			rows.some((row, index) => row.index !== index || typeof row.data !== 'string')
		)
			throw new TypeError('Persisted MongoDB value generation is incomplete.');
		return (JSON.parse(rows.map((row) => row.data).join('')) as [unknown])[0];
	}

	async discardStaged(pointer: StoredValue): Promise<void> {
		const registry = this.runner.collection(collectionName(this.prefix, 'value_generations'));
		const removed = await registry.deleteOne({
			_id: pointer.generation,
			owner: pointer.owner,
			state: 'staged',
		});
		if (removed.deletedCount === 1) await this.deleteParts(pointer);
	}

	async retire(pointer: StoredValue): Promise<void> {
		const registry = this.runner.collection(collectionName(this.prefix, 'value_generations'));
		const result = await registry.updateOne(
			{ _id: pointer.generation, owner: pointer.owner, state: 'published' },
			{ $set: { state: 'retired', updatedAt: Date.now() } },
		);
		if (result.matchedCount === 1) await this.collect(pointer.generation);
	}

	async collectGarbage(now = Date.now()): Promise<void> {
		const registry = this.runner.collection(collectionName(this.prefix, 'value_generations'));
		const rows = await registry.find(
			{
				$or: [
					{ state: 'retired' },
					{ state: 'staged', createdAt: { $lt: now - STAGED_MAX_AGE_MS } },
				],
			},
			{ sort: { updatedAt: 1 }, limit: GC_BATCH },
		);
		for (const row of rows) await this.collect(String(row._id));
	}

	private async collect(generation: string): Promise<void> {
		const registry = this.runner.collection(collectionName(this.prefix, 'value_generations'));
		const row = await registry.findOne({ _id: generation, state: { $in: ['staged', 'retired'] } });
		if (!row) return;
		await this.runner.collection(collectionName(this.prefix, 'values')).deleteMany({ generation });
		await registry.deleteOne({ _id: generation, state: row.state });
	}

	private async deleteParts(pointer: StoredValue): Promise<void> {
		await this.runner
			.collection(collectionName(this.prefix, 'values'))
			.deleteMany({ owner: pointer.owner, generation: pointer.generation });
	}
}
