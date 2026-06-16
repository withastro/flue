import type { PersistedChunkOwner, PersistedChunkRow } from '@flue/runtime/adapter';
import type { MongoOperations, MongoRunner } from './mongodb-runner.ts';
import { type StoredValue, ValueStore } from './value-store.ts';

interface StagedChunks {
	pointer: StoredValue;
	owner: PersistedChunkOwner;
}

export async function stageChunks(
	runner: MongoRunner,
	prefix: string,
	owner: PersistedChunkOwner,
	chunks: readonly PersistedChunkRow[],
): Promise<StagedChunks> {
	const pointer = await new ValueStore(runner, prefix).stage(
		`chunks:${owner.kind}:${owner.id}:${owner.part}`,
		chunks,
	);
	return { pointer, owner };
}

export async function publishChunks(
	operations: MongoOperations,
	runner: MongoRunner,
	prefix: string,
	staged: StagedChunks,
): Promise<void> {
	await new ValueStore(runner, prefix).publish(staged.pointer, operations);
}
