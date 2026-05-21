import { describe, expect, it } from 'vitest';
import { MessageDispatcher, MessageQueueFullError } from '../src/internal.ts';
import type { Agent, FlueEvent, InboundMessage } from '../src/types.ts';

function createAgent(sent: string[] = []): Agent {
	return {
		name: 'hello',
		id: 'inst-1',
		send(message) {
			sent.push(message);
		},
		harness() {
			throw new Error('not needed');
		},
	};
}

async function collect(stream: AsyncIterable<FlueEvent>): Promise<FlueEvent[]> {
	const events: FlueEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

describe('MessageDispatcher', () => {
	it('initializes once, preserves FIFO ordering, and returns delivery results', async () => {
		const seen: string[] = [];
		let initCalls = 0;
		const dispatcher = new MessageDispatcher({
			agentName: 'hello',
			instanceId: 'inst-1',
			messageId: (() => {
				let index = 0;
				return () => `msg_${++index}`;
			})(),
			async init() {
				initCalls++;
				return createAgent();
			},
			async onMessage(_agent, message) {
				seen.push(message.content);
				return { echoed: message.content };
			},
		});

		const first = await dispatcher.deliver({ content: 'one', channel: 'internal' });
		const second = await dispatcher.deliver({ content: 'two', channel: 'internal' });

		expect(await first.waitForIdle()).toEqual({ result: { echoed: 'one' } });
		expect(await second.waitForIdle()).toEqual({ result: { echoed: 'two' } });
		expect(initCalls).toBe(1);
		expect(seen).toEqual(['one', 'two']);
	});

	it('lets the first cold delivery own init metadata while later deliveries queue', async () => {
		let initializedFrom: InboundMessage | undefined;
		let releaseInit!: () => void;
		const initGate = new Promise<void>((resolve) => {
			releaseInit = resolve;
		});
		const dispatcher = new MessageDispatcher({
			agentName: 'hello',
			instanceId: 'inst-1',
			async init(message) {
				initializedFrom = message;
				await initGate;
				return createAgent();
			},
			onMessage() {
				return undefined;
			},
		});

		const first = await dispatcher.deliver({ content: 'one', channel: 'http', metadata: { wake: 1 } });
		const second = await dispatcher.deliver({ content: 'two', channel: 'http', metadata: { wake: 2 } });
		releaseInit();
		await first.waitForIdle();
		await second.waitForIdle();

		expect(initializedFrom?.content).toBe('one');
		expect(initializedFrom?.metadata).toEqual({ wake: 1 });
	});

	it('does not overlap message lifecycles and waits for idle work', async () => {
		const order: string[] = [];
		let releaseIdle!: () => void;
		const idleGate = new Promise<void>((resolve) => {
			releaseIdle = resolve;
		});
		const dispatcher = new MessageDispatcher({
			agentName: 'hello',
			instanceId: 'inst-1',
			async init() {
				return createAgent();
			},
			onMessage(_agent, message) {
				order.push(`message:${message.content}`);
				return message.content;
			},
			async waitForIdle(_agent, message) {
				order.push(`idle:${message.content}:start`);
				if (message.content === 'one') await idleGate;
				order.push(`idle:${message.content}:end`);
			},
		});

		const first = await dispatcher.deliver({ content: 'one', channel: 'internal' });
		const second = await dispatcher.deliver({ content: 'two', channel: 'internal' });
		await Promise.resolve();
		expect(order).toEqual(['message:one', 'idle:one:start']);

		releaseIdle();
		await first.waitForIdle();
		await second.waitForIdle();
		expect(order).toEqual([
			'message:one',
			'idle:one:start',
			'idle:one:end',
			'message:two',
			'idle:two:start',
			'idle:two:end',
		]);
	});

	it('surfaces init and handler errors on delivery completion', async () => {
		const initError = new Error('init failed');
		const initDispatcher = new MessageDispatcher({
			agentName: 'hello',
			instanceId: 'inst-1',
			async init() {
				throw initError;
			},
		});
		const failedInit = await initDispatcher.deliver({ content: 'one', channel: 'internal' });
		expect(await failedInit.waitForIdle()).toEqual({ error: initError });

		const handlerError = new Error('handler failed');
		const handlerDispatcher = new MessageDispatcher({
			agentName: 'hello',
			instanceId: 'inst-1',
			async init() {
				return createAgent();
			},
			async onMessage() {
				throw handlerError;
			},
		});
		const failedHandler = await handlerDispatcher.deliver({ content: 'two', channel: 'internal' });
		expect(await failedHandler.waitForIdle()).toEqual({ error: handlerError });
	});

	it('streams start and terminal events including returned results', async () => {
		const dispatcher = new MessageDispatcher({
			agentName: 'hello',
			instanceId: 'inst-1',
			messageId: () => 'msg_result',
			now: (() => {
				const times = [1_000, 1_010];
				return () => times.shift() ?? 1_010;
			})(),
			async init() {
				return createAgent();
			},
			onMessage() {
				return { ok: true };
			},
		});
		const handle = await dispatcher.deliver({ content: 'hi', channel: 'http', metadata: { source: 'test' } });
		const eventsPromise = collect(handle.events());
		await handle.waitForIdle();
		const events = await eventsPromise;
		expect(events).toEqual([
			expect.objectContaining({ type: 'message_start', messageId: 'msg_result', channel: 'http' }),
			expect.objectContaining({ type: 'message_end', messageId: 'msg_result', result: { ok: true }, isError: false }),
		]);
	});

	it('rejects new deliveries when the pending queue is full', async () => {
		let releaseInit!: () => void;
		const initGate = new Promise<void>((resolve) => {
			releaseInit = resolve;
		});
		const dispatcher = new MessageDispatcher({
			agentName: 'hello',
			instanceId: 'inst-1',
			maxPendingMessages: 1,
			async init() {
				await initGate;
				return createAgent();
			},
		});
		const first = await dispatcher.deliver({ content: 'one', channel: 'internal' });
		await expect(dispatcher.deliver({ content: 'two', channel: 'internal' })).rejects.toBeInstanceOf(
			MessageQueueFullError,
		);
		releaseInit();
		await first.waitForIdle();
	});
});
