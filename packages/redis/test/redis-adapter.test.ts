import { randomUUID } from 'node:crypto';
import { PersistedSchemaVersionError, type SessionData } from '@flue/runtime/adapter';
import {
	defineEventStreamStoreContractTests,
	defineRunStoreContractTests,
	defineStoreContractTests,
} from '@flue/runtime/test-utils';
import { createClient } from 'redis';
import { describe, expect, it } from 'vitest';
import { type RedisRunner, redis } from '../src/index.ts';

const redisUrl = process.env.TEST_REDIS_URL;
const describeRedis = redisUrl ? describe : describe.skip;

type TestRedisClient = ReturnType<typeof createClient>;

function createRunner(client: TestRedisClient): RedisRunner {
	return {
		command: (command, args = []) => client.sendCommand([command, ...args.map(String)]),
		eval: (script, keys, args = []) => client.eval(script, { keys, arguments: args.map(String) }),
		pipeline: async (commands) => {
			const multi = client.multi();
			for (const item of commands)
				multi.addCommand([item.command, ...(item.args ?? []).map(String)]);
			return multi.exec();
		},
		close: () => client.close(),
	};
}

interface Harness {
	adapter: ReturnType<typeof redis>;
	client: TestRedisClient;
	prefix: string;
}

async function createSharedHarness(prefix = `flue-test:${randomUUID()}`): Promise<Harness> {
	const client = createClient({ url: redisUrl });
	await client.connect();
	const adapter = redis(createRunner(client), { keyPrefix: prefix, inspectServer: false });
	await adapter.migrate?.();
	return { adapter, client, prefix };
}

let harness: Harness | undefined;

async function createHarness() {
	harness = await createSharedHarness();
	return harness.adapter.connect();
}

async function cleanupPrefix(target: Harness, extras: Harness[] = []) {
	let cursor = '0';
	do {
		const result = await target.client.scan(cursor, { MATCH: `${target.prefix}:*`, COUNT: 100 });
		cursor = result.cursor;
		if (result.keys.length > 0) await target.client.del(result.keys);
	} while (cursor !== '0');
	for (const item of [target, ...extras]) await item.adapter.close?.();
}

async function cleanupHarness() {
	if (!harness) return;
	await cleanupPrefix(harness);
	harness = undefined;
}

describeRedis('Redis shared contracts', () => {
	defineStoreContractTests('Redis AgentExecutionStore', {
		async create() {
			return (await createHarness()).executionStore;
		},
		cleanup: cleanupHarness,
	});
	defineRunStoreContractTests('Redis RunStore', {
		async create() {
			return (await createHarness()).runStore;
		},
		cleanup: cleanupHarness,
	});
	defineEventStreamStoreContractTests('Redis EventStreamStore', {
		async create() {
			return (await createHarness()).eventStreamStore;
		},
		cleanup: cleanupHarness,
	});
});

function dispatchInput(dispatchId = 'dispatch-1') {
	return {
		dispatchId,
		agent: 'assistant',
		id: 'agent-1',
		input: { text: 'hello' },
		acceptedAt: '2026-06-03T00:00:00.000Z',
	};
}

function sessionData(label: string): SessionData {
	return {
		version: 6,
		affinityKey: label,
		entries: [],
		leafId: null,
		taskSessions: [],
		metadata: { label },
		createdAt: '2026-06-03T00:00:00.000Z',
		updatedAt: '2026-06-03T00:00:00.000Z',
	};
}

describeRedis('redis() concurrency', () => {
	it('allows one same-submission claim when independent adapters race', async () => {
		const first = await createSharedHarness();
		const second = await createSharedHarness(first.prefix);
		const firstStores = await first.adapter.connect();
		const secondStores = await second.adapter.connect();
		await firstStores.executionStore.submissions.admitDispatch(dispatchInput());
		const results = await Promise.all([
			firstStores.executionStore.submissions.claimSubmission({
				submissionId: 'dispatch-1',
				attemptId: 'a',
				ownerId: 'one',
				leaseExpiresAt: Date.now() + 30_000,
			}),
			secondStores.executionStore.submissions.claimSubmission({
				submissionId: 'dispatch-1',
				attemptId: 'b',
				ownerId: 'two',
				leaseExpiresAt: Date.now() + 30_000,
			}),
		]);
		expect(results.filter(Boolean)).toHaveLength(1);
		await cleanupPrefix(first, [second]);
	});

	it('serializes admission and deletion across independent adapters', async () => {
		const firstHarness = await createSharedHarness();
		const secondHarness = await createSharedHarness(firstHarness.prefix);
		const firstStores = await firstHarness.adapter.connect();
		const secondStores = await secondHarness.adapter.connect();
		const admitted = await firstStores.executionStore.submissions.admitDispatch(dispatchInput());
		if (admitted.kind !== 'submission') throw new Error('Expected submission.');
		const claimed = await firstStores.executionStore.submissions.claimSubmission({
			submissionId: 'dispatch-1',
			attemptId: 'a',
			ownerId: 'one',
			leaseExpiresAt: Date.now() + 30_000,
		});
		if (!claimed) throw new Error('Expected claim.');
		await firstStores.executionStore.submissions.completeSubmission({
			submissionId: 'dispatch-1',
			attemptId: 'a',
		});
		let release: (() => void) | undefined;
		const deleting = firstStores.executionStore.submissions.deleteSession(
			admitted.submission.sessionKey,
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
		await expect(
			secondStores.executionStore.submissions.admitDispatch(dispatchInput('dispatch-2')),
		).rejects.toThrow();
		release();
		await deleting;
		await cleanupPrefix(firstHarness, [secondHarness]);
	});

	it('runs one snapshot deletion across independent adapters', async () => {
		const first = await createSharedHarness();
		const second = await createSharedHarness(first.prefix);
		const firstStores = await first.adapter.connect();
		const secondStores = await second.adapter.connect();
		let calls = 0;
		let release: (() => void) | undefined;
		const snapshot = () => {
			calls++;
			return new Promise<void>((resolve) => {
				release = resolve;
			});
		};
		const sessionKey = 'agent-session:["agent-1","default","default"]';
		const deletions = [
			firstStores.executionStore.submissions.deleteSession(sessionKey, snapshot),
			secondStores.executionStore.submissions.deleteSession(sessionKey, snapshot),
		];
		while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
		release();
		await Promise.all(deletions);
		expect(calls).toBe(1);
		await cleanupPrefix(first, [second]);
	});

	it('inserts one stream segment when writers race', async () => {
		const stores = await createHarness();
		const results = await Promise.all([
			stores.executionStore.submissions.appendStreamChunkSegment('stream', 0, 'first'),
			stores.executionStore.submissions.appendStreamChunkSegment('stream', 0, 'second'),
		]);
		expect(results.filter(Boolean)).toHaveLength(1);
		expect(await stores.executionStore.submissions.getStreamChunkSegments('stream')).toHaveLength(
			1,
		);
		await cleanupHarness();
	});

	it('orders concurrent event appends from independent adapters and rejects appends after close', async () => {
		const first = await createSharedHarness();
		const second = await createSharedHarness(first.prefix);
		const firstStore = (await first.adapter.connect()).eventStreamStore;
		const secondStore = (await second.adapter.connect()).eventStreamStore;
		await firstStore.createStream('events');
		const offsets = await Promise.all(
			Array.from({ length: 20 }, (_, index) =>
				(index % 2 ? firstStore : secondStore).appendEvent('events', { index }),
			),
		);
		expect(new Set(offsets)).toHaveLength(20);
		await secondStore.closeStream('events');
		await expect(firstStore.appendEvent('events', { index: 21 })).rejects.toThrow();
		await cleanupPrefix(first, [second]);
	});

	it('appends identical event payloads at distinct offsets', async () => {
		const stores = await createHarness();
		await stores.eventStreamStore.createStream('events');
		const first = await stores.eventStreamStore.appendEvent('events', { value: 'same' });
		const second = await stores.eventStreamStore.appendEvent('events', { value: 'same' });
		expect(second).not.toBe(first);
		expect((await stores.eventStreamStore.readEvents('events')).events).toEqual([
			{ data: { value: 'same' }, offset: first },
			{ data: { value: 'same' }, offset: second },
		]);
		await cleanupHarness();
	});

	it('loads only complete published session generations across independent adapters', async () => {
		const first = await createSharedHarness();
		const second = await createSharedHarness(first.prefix);
		const firstSessions = (await first.adapter.connect()).executionStore.sessions;
		const secondSessions = (await second.adapter.connect()).executionStore.sessions;
		const saves = Array.from({ length: 10 }, (_, index) =>
			firstSessions.save('session', sessionData(String(index))),
		);
		const loads = Array.from({ length: 20 }, async () => {
			const value = await secondSessions.load('session');
			if (value) expect(value.metadata.label).toMatch(/^\d$/);
		});
		await Promise.all([...saves, ...loads]);
		expect(await secondSessions.load('session')).not.toBeNull();
		await cleanupPrefix(first, [second]);
	});

	it('rejects staging when a pipeline command fails and keeps the published generation', async () => {
		const target = await createSharedHarness();
		const base = createRunner(target.client);
		let fail = false;
		const adapter = redis(
			{
				...base,
				pipeline: async (commands) => {
					if (fail)
						return commands.map((_, index) =>
							index === 1 ? new Error('injected pipeline failure') : 1,
						);
					const results = await base.pipeline?.(commands);
					if (!results) throw new Error('Missing pipeline results.');
					return results;
				},
				close: () => undefined,
			},
			{ keyPrefix: target.prefix, inspectServer: false },
		);
		const sessions = (await adapter.connect()).executionStore.sessions;
		await sessions.save('session', sessionData('first'));
		fail = true;
		await expect(sessions.save('session', sessionData('second'))).rejects.toThrow(
			'injected pipeline failure',
		);
		expect((await sessions.load('session'))?.metadata.label).toBe('first');
		await adapter.close?.();
		await cleanupPrefix(target);
	});

	it('converges concurrent endRun indexes from independent adapters', async () => {
		const first = await createSharedHarness();
		const second = await createSharedHarness(first.prefix);
		const firstRuns = (await first.adapter.connect()).runStore;
		const secondRuns = (await second.adapter.connect()).runStore;
		await firstRuns.createRun({
			runId: 'run',
			workflowName: 'workflow',
			startedAt: '2026-01-01T00:00:00+05:00',
			payload: null,
		});
		await Promise.all([
			firstRuns.endRun({
				runId: 'run',
				endedAt: '2026-01-01T00:00:01Z',
				durationMs: 1,
				isError: false,
			}),
			secondRuns.endRun({
				runId: 'run',
				endedAt: '2026-01-01T00:00:02Z',
				durationMs: 2,
				isError: true,
				error: 'failed',
			}),
		]);
		const run = await firstRuns.getRun('run');
		expect(run?.status === 'completed' || run?.status === 'errored').toBe(true);
		expect((await firstRuns.listRuns({ status: 'active' })).runs).toEqual([]);
		expect((await firstRuns.listRuns({ status: run?.status })).runs).toHaveLength(1);
		await cleanupPrefix(first, [second]);
	});
});

describeRedis('redis() migration', () => {
	it('rejects a newer schema version', async () => {
		const stores = await createHarness();
		void stores;
		await harness?.client.hSet(`${harness?.prefix}:meta`, 'schemaVersion', '999');
		await expect(harness?.adapter.migrate?.()).rejects.toThrowError(PersistedSchemaVersionError);
		await cleanupHarness();
	});
});
