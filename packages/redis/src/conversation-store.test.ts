import { defineConversationStreamStoreContractTests } from '@flue/runtime/test-utils/conversation-stream';
import { createClient } from 'redis';
import { describe } from 'vitest';
import { redis } from './redis-adapter.ts';

const url = process.env.FLUE_TEST_REDIS_URL;
let sequence = 0;
const closeClients: Array<() => Promise<void>> = [];

describe.skipIf(!url)('Redis integration', () => {
	defineConversationStreamStoreContractTests('Redis conversation store', {
		async create() {
			const client = createClient({ url });
			closeClients.push(async () => {
				if (client.isOpen) await client.close();
			});
			await client.connect();
			const adapter = redis(
				{
					command: (command, args = []) => client.sendCommand([command, ...args.map(String)]),
					eval: (script, keys, args = []) =>
						client.eval(script, { keys, arguments: args.map(String) }),
					close: () => client.close(),
				},
				{ keyPrefix: `flue-test-cleanup-${process.pid}-${sequence++}` },
			);
			await adapter.migrate?.();
			const connection = await adapter.connect();
			return {
				stream: connection.conversationStreamStore,
				submissionStore: connection.submissionStore,
			};
		},
		async cleanup() {
			for (const close of closeClients.splice(0)) await close();
		},
	});
});
