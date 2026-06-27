import { randomUUID } from 'node:crypto';
import { createAttachmentRef, PersistedSchemaVersionError } from '@flue/runtime/adapter';
import {
	defineAttachmentStoreContractTests,
	defineConversationStreamStoreContractTests,
	defineEventStreamStoreContractTests,
	defineRunStoreContractTests,
	defineStoreContractTests,
} from '@flue/runtime/test-utils';
import { createClient, RESP_TYPES } from 'redis';
import { describe, expect, it } from 'vitest';
import { type RedisRunner, redis } from '../src/index.ts';

const redisUrl = process.env.TEST_REDIS_URL;
const describeRedis = redisUrl ? describe : describe.skip;

type TestRedisClient = ReturnType<typeof createClient>;

function createRunner(client: TestRedisClient): RedisRunner {
	const argument = (value: string | number | Uint8Array) =>
		value instanceof Uint8Array ? Buffer.from(value) : String(value);
	return {
		command: (command, args = []) => client.sendCommand(
			[command, ...args.map(argument)],
			{ typeMapping: { [RESP_TYPES.BLOB_STRING]: Buffer } },
		),
		eval: (script, keys, args = []) => client.eval(script, { keys, arguments: args.map(argument) }),
		pipeline: async (commands) => {
			const multi = client.multi();
			for (const item of commands)
				multi.addCommand([item.command, ...(item.args ?? []).map(argument)]);
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
	defineAttachmentStoreContractTests('Redis AttachmentStore', {
		async create() {
			return (await createHarness()).attachmentStore;
		},
		cleanup: cleanupHarness,
	});
	defineConversationStreamStoreContractTests('Redis ConversationStreamStore', {
		async create() {
			const connected = await createHarness();
			if (!connected.conversationStreamStore) {
				throw new Error('Expected Redis conversation stream store.');
			}
			return {
				stream: connected.conversationStreamStore,
				executionStore: connected.executionStore,
			};
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

describeRedis('RedisAttachmentStore', () => {
	it('does not retain an old conversation index when an instance is deleted and recreated', async () => {
		const stores = await createHarness();
		const store = stores.attachmentStore;
		const streamPath = 'agents/assistant/agent-1';
		const bytes = Uint8Array.from([0, 255, 128, 1]);
		const attachment = await createAttachmentRef({ id: 'attachment-1', mimeType: 'application/octet-stream', bytes });
		await store.put({ streamPath, attachment, bytes, owner: { kind: 'conversation', conversationId: 'conversation-1' } });

		await store.deleteForInstance(streamPath);
		if (!harness) throw new Error('Expected Redis harness.');
		const encodedPath = Buffer.from(streamPath).toString('base64url');
		const encodedConversation = Buffer.from('conversation-1').toString('base64url');
		await expect(harness.client.exists(`${harness.prefix}:conversation-attachments:${encodedPath}:${encodedConversation}`)).resolves.toBe(0);
		await store.put({ streamPath, attachment, bytes, owner: { kind: 'conversation', conversationId: 'conversation-2' } });

		await expect(store.listForConversation({ streamPath, conversationId: 'conversation-1' })).resolves.toEqual([]);
		await expect(store.listForConversation({ streamPath, conversationId: 'conversation-2' })).resolves.toEqual([attachment]);
		await expect(store.get({ streamPath, conversationId: 'conversation-2', attachmentId: attachment.id })).resolves.toEqual({ attachment, bytes });
		await cleanupHarness();
	});

	it('does not expose an attachment through a stale conversation index', async () => {
		const stores = await createHarness();
		const store = stores.attachmentStore;
		const streamPath = 'agents/assistant/agent-1';
		const bytes = Uint8Array.from([7, 0, 255]);
		const attachment = await createAttachmentRef({ id: 'attachment-1', mimeType: 'application/octet-stream', bytes });
		await store.put({ streamPath, attachment, bytes, owner: { kind: 'conversation', conversationId: 'conversation-2' } });
		const encodedPath = Buffer.from(streamPath).toString('base64url');
		const encodedConversation = Buffer.from('conversation-1').toString('base64url');
		if (!harness) throw new Error('Expected Redis harness.');
		await harness.client.sAdd(`${harness.prefix}:conversation-attachments:${encodedPath}:${encodedConversation}`, attachment.id);

		await expect(store.listForConversation({ streamPath, conversationId: 'conversation-1' })).resolves.toEqual([]);
		await expect(store.listForConversation({ streamPath, conversationId: 'conversation-2' })).resolves.toEqual([attachment]);
		await cleanupHarness();
	});
});

describeRedis('redis() concurrency', () => {
	it('allows one same-submission claim when independent adapters race', async () => {
		const first = await createSharedHarness();
		const second = await createSharedHarness(first.prefix);
		const firstStores = await first.adapter.connect();
		const secondStores = await second.adapter.connect();
		await firstStores.executionStore.submissions.admitDispatch(dispatchInput());
		await firstStores.executionStore.submissions.markSubmissionCanonicalReady('dispatch-1');
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

	it('converges concurrent endRun indexes from independent adapters', async () => {
		const first = await createSharedHarness();
		const second = await createSharedHarness(first.prefix);
		const firstRuns = (await first.adapter.connect()).runStore;
		const secondRuns = (await second.adapter.connect()).runStore;
		await firstRuns.createRun({
			runId: 'run',
			workflowName: 'workflow',
			startedAt: '2026-01-01T00:00:00+05:00',
			input: null,
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
	it('rejects unversioned Flue persistence without stamping it', async () => {
		if (!redisUrl) throw new TypeError('TEST_REDIS_URL is required.');
		const client = createClient({ url: redisUrl });
		await client.connect();
		const prefix = `flue-test:${randomUUID()}`;
		await client.set(`${prefix}:run:legacy`, '{}');
		const adapter = redis(createRunner(client), { keyPrefix: prefix, inspectServer: false });
		await expect(adapter.migrate?.()).rejects.toThrowError(PersistedSchemaVersionError);
		expect(await client.exists(`${prefix}:meta`)).toBe(0);
		await client.del(`${prefix}:run:legacy`);
		await adapter.close?.();
	});
	it('rejects an earlier schema version', async () => {
		const stores = await createHarness();
		void stores;
		await harness?.client.hSet(`${harness?.prefix}:meta`, 'schemaVersion', '2');
		await expect(harness?.adapter.migrate?.()).rejects.toThrowError(PersistedSchemaVersionError);
		await cleanupHarness();
	});
	it('rejects a newer schema version', async () => {
		const stores = await createHarness();
		void stores;
		await harness?.client.hSet(`${harness?.prefix}:meta`, 'schemaVersion', '999');
		await expect(harness?.adapter.migrate?.()).rejects.toThrowError(PersistedSchemaVersionError);
		await cleanupHarness();
	});
});
