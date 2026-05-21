import type {
	Agent,
	AgentMessageHandler,
	DeliveryHandle,
	DeliveryInput,
	DeliveryResult,
	EventStream,
	FlueEvent,
	InboundMessage,
} from '../types.ts';
import { generateMessageId } from './ids.ts';

export interface MessageDispatcherOptions {
	agentName: string;
	instanceId: string;
	init(message: InboundMessage): Promise<Agent>;
	onMessage?: AgentMessageHandler;
	waitForIdle?: (agent: Agent, message: InboundMessage) => Promise<void>;
	maxPendingMessages?: number;
	now?: () => number;
	messageId?: () => string;
}

export class MessageQueueFullError extends Error {
	constructor({ name, id }: { name: string; id: string }) {
		super(`[flue] Agent instance "${name}/${id}" has a full pending message queue.`);
		this.name = 'MessageQueueFullError';
	}
}

interface PendingMessage {
	message: InboundMessage;
	handle: DeliveryHandleState;
}

type DispatcherState = 'cold' | 'initializing' | 'ready';

export class MessageDispatcher {
	readonly #agentName: string;
	readonly #instanceId: string;
	readonly #init: (message: InboundMessage) => Promise<Agent>;
	readonly #onMessage: AgentMessageHandler;
	readonly #waitForIdle: (agent: Agent, message: InboundMessage) => Promise<void>;
	readonly #maxPendingMessages: number;
	readonly #now: () => number;
	readonly #messageId: () => string;
	readonly #queue: PendingMessage[] = [];
	#state: DispatcherState = 'cold';
	#agent: Agent | undefined;
	#processing = false;

	constructor(options: MessageDispatcherOptions) {
		this.#agentName = options.agentName;
		this.#instanceId = options.instanceId;
		this.#init = options.init;
		this.#onMessage = options.onMessage ?? ((agent, message) => agent.send(message.content));
		this.#waitForIdle = options.waitForIdle ?? (async () => {});
		this.#maxPendingMessages = options.maxPendingMessages ?? 100;
		this.#now = options.now ?? Date.now;
		this.#messageId = options.messageId ?? generateMessageId;
	}

	async deliver(input: DeliveryInput): Promise<DeliveryHandle> {
		if (this.#queue.length >= this.#maxPendingMessages) {
			throw new MessageQueueFullError({ name: this.#agentName, id: this.#instanceId });
		}

		const message = this.#createMessage(input);
		const handle = new DeliveryHandleState(message.messageId);
		this.#queue.push({ message, handle });
		this.#startIfNeeded(message);
		void this.#drain();
		return handle;
	}

	#createMessage(input: DeliveryInput): InboundMessage {
		return {
			messageId: this.#messageId(),
			content: input.content,
			channel: input.channel,
			sender: input.sender,
			metadata: input.metadata ?? {},
			receivedAt: this.#now(),
		};
	}

	#startIfNeeded(message: InboundMessage): void {
		if (this.#state !== 'cold') return;
		this.#state = 'initializing';
		void this.#initialize(message);
	}

	async #initialize(message: InboundMessage): Promise<void> {
		try {
			this.#agent = await this.#init(message);
			this.#state = 'ready';
			void this.#drain();
		} catch (error) {
			const pending = this.#queue.splice(0);
			this.#state = 'cold';
			for (const item of pending) {
				item.handle.emit(this.#endEvent(item.message, undefined, error, 0));
				item.handle.finish({ error });
			}
		}
	}

	async #drain(): Promise<void> {
		if (this.#processing || this.#state !== 'ready' || !this.#agent) return;
		this.#processing = true;
		try {
			while (this.#state === 'ready' && this.#agent && this.#queue.length > 0) {
				const item = this.#queue.shift()!;
				await this.#process(item, this.#agent);
			}
		} finally {
			this.#processing = false;
		}
	}

	async #process(item: PendingMessage, agent: Agent): Promise<void> {
		const startedAt = this.#now();
		item.handle.emit({
			type: 'message_start',
			messageId: item.message.messageId,
			instanceId: this.#instanceId,
			agentName: this.#agentName,
			channel: item.message.channel,
			receivedAt: new Date(item.message.receivedAt).toISOString(),
			metadata: item.message.metadata,
		});

		try {
			const result = await this.#onMessage(agent, item.message);
			await this.#waitForIdle(agent, item.message);
			item.handle.emit(this.#endEvent(item.message, result, undefined, this.#now() - startedAt));
			item.handle.finish({ result });
		} catch (error) {
			item.handle.emit(this.#endEvent(item.message, undefined, error, this.#now() - startedAt));
			item.handle.finish({ error });
		}
	}

	#endEvent(message: InboundMessage, result: unknown, error: unknown, durationMs: number): FlueEvent {
		return {
			type: 'message_end',
			messageId: message.messageId,
			result,
			isError: error !== undefined,
			error,
			durationMs,
		};
	}
}

class DeliveryHandleState implements DeliveryHandle {
	readonly messageId: string;
	readonly #events: FlueEvent[] = [];
	readonly #waiters = new Set<() => void>();
	#done = false;
	#resolveIdle!: (result: DeliveryResult) => void;
	readonly #idle = new Promise<DeliveryResult>((resolve) => {
		this.#resolveIdle = resolve;
	});

	constructor(messageId: string) {
		this.messageId = messageId;
	}

	events(): EventStream {
		let cursor = 0;
		let cancelled = false;
		const state = this;
		return {
			cancel() {
				cancelled = true;
				state.#notify();
			},
			async *[Symbol.asyncIterator]() {
				while (!cancelled) {
					while (cursor < state.#events.length) {
						yield state.#events[cursor++]!;
					}
					if (state.#done) return;
					await state.#wait();
				}
			},
		};
	}

	waitForIdle(): Promise<DeliveryResult> {
		return this.#idle;
	}

	emit(event: FlueEvent): void {
		if (this.#done) return;
		this.#events.push(event);
		this.#notify();
	}

	finish(result: DeliveryResult): void {
		if (this.#done) return;
		this.#done = true;
		this.#resolveIdle(result);
		this.#notify();
	}

	#wait(): Promise<void> {
		return new Promise((resolve) => {
			this.#waiters.add(resolve);
		});
	}

	#notify(): void {
		for (const resolve of this.#waiters) resolve();
		this.#waiters.clear();
	}
}
