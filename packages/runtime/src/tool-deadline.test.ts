import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { expect, it } from 'vitest';
import type { PersistenceAdapter } from './agent-execution-store.ts';
import type { ConversationRecord } from './conversation-records.ts';
import { init, instrument, useModel, useTool } from './index.ts';
import { sqlite, start } from './node/index.ts';
import type { ConversationStreamStore } from './runtime/conversation-stream-store.ts';

function recordingDatabase() {
	const database = sqlite();
	const records: ConversationRecord[] = [];
	const adapter: PersistenceAdapter = {
		migrate: () => database.migrate?.(),
		close: () => database.close?.(),
		async connect() {
			const stores = await database.connect();
			const stream = stores.conversationStreamStore;
			const recordingStream: ConversationStreamStore = {
				createStream: (...args) => stream.createStream(...args),
				acquireProducer: (...args) => stream.acquireProducer(...args),
				async append(input) {
					const result = await stream.append(input);
					records.push(...structuredClone(input.records));
					return result;
				},
				read: (...args) => stream.read(...args),
				getMeta: (...args) => stream.getMeta(...args),
				subscribe: (...args) => stream.subscribe(...args),
				...(stream.putFoldCheckpoint
					? { putFoldCheckpoint: stream.putFoldCheckpoint.bind(stream) }
					: {}),
				...(stream.getFoldCheckpoint
					? { getFoldCheckpoint: stream.getFoldCheckpoint.bind(stream) }
					: {}),
			};
			return { ...stores, conversationStreamStore: recordingStream };
		},
	};
	return { adapter, records };
}

function hangUntilSignal(signal: AbortSignal | undefined): Promise<string> {
	return new Promise((_resolve, reject) => {
		if (signal?.aborted) reject(signal.reason);
		else signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
	});
}

it('settles a tool that exceeds its timeoutMs with a distinguishable error and continues the turn', async () => {
	function SlowAgent() {
		useModel('faux/model');
		useTool({
			name: 'hung',
			description: 'Hangs past its deadline.',
			timeoutMs: 40,
			run: async (context) => hangUntilSignal(context.signal),
		});
		return 'Call the supplied tool.';
	}

	const faux = fauxProvider({ models: [{ id: 'model' }] });
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall('hung', {}, { id: 'call_hung' })], {
			stopReason: 'toolUse',
		}),
		fauxAssistantMessage([fauxText('Continuing after the timeout.')], { stopReason: 'stop' }),
	]);
	const database = recordingDatabase();
	const disposeInstrumentation = instrument({
		dispose() {},
		observe() {},
		async interceptor(_operation, _context, next) {
			return await next();
		},
	});
	const runtime = await start({
		agents: [SlowAgent],
		db: database.adapter,
		providers: [faux.provider],
		env: {},
	});
	const agent = init(SlowAgent, { id: 'tool-timeout' });

	try {
		const receipt = await agent.dispatch('Run the tool.');
		await expect(agent.read(receipt)).resolves.toMatchObject({
			text: 'Continuing after the timeout.',
		});

		// The tool call settled as an error whose text names the deadline —
		// distinguishable from a thrown tool error (the harness throws
		// ToolTimeoutError; the recorded outcome carries the message the model
		// saw). The submission itself did not fail.
		const outcomes = database.records.filter((record) => record.type === 'tool_outcome');
		expect(outcomes).toHaveLength(1);
		expect(outcomes[0]).toMatchObject({
			toolCallId: 'call_hung',
			isError: true,
			content: [{ type: 'text', text: 'Tool "hung" timed out after 40ms' }],
		});

		// The turn continued: a follow-up assistant message was produced after
		// the timeout settlement instead of the submission failing.
		const continuation = database.records
			.filter((record) => record.type === 'assistant_text_delta')
			.map((record) => (record as { delta?: string }).delta ?? '')
			.join('');
		expect(continuation).toContain('Continuing after the timeout.');
	} finally {
		await agent.abort();
		await runtime.stop();
		await disposeInstrumentation();
	}
});
