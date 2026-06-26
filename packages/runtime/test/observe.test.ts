import { describe, expect, it, vi } from 'vitest';
import { type FlueObservation, observe } from '../src/index.ts';
import { createFlueContext } from '../src/internal.ts';

function createContext(id: string) {
	return createFlueContext({
		id,
		env: {},
		agentConfig: {
			resolveModel: () => undefined,
		},
		createDefaultEnv: async () => {
			throw new Error('unexpected sandbox initialization');
		},
	});
}

describe('observe()', () => {
	it('receives decorated events when a runtime context emits events', () => {
		const events: unknown[] = [];
		const stopObserving = observe((event, ctx) => {
			if (ctx.id === 'observe-decorated-event') events.push(event);
		});
		const ctx = createContext('observe-decorated-event');

		try {
			ctx.emitEvent({ type: 'idle' });

			expect(events).toEqual([
				{
					type: 'idle',
					instanceId: 'observe-decorated-event',
					v: 3,
					eventIndex: 0,
					timestamp: expect.any(String),
				},
			]);
		} finally {
			stopObserving();
		}
	});

	it('receives the originating context when a runtime context emits events', () => {
		const contexts: unknown[] = [];
		const stopObserving = observe((_event, ctx) => {
			if (ctx.id === 'observe-originating-context') contexts.push(ctx);
		});
		const ctx = createContext('observe-originating-context');

		try {
			ctx.emitEvent({ type: 'idle' });

			expect(contexts).toEqual([ctx]);
		} finally {
			stopObserving();
		}
	});

	it('delivers one detached immutable observation to every subscriber when an event is emitted', () => {
		const events: unknown[] = [];
		const stopFirst = observe((event, ctx) => {
			if (ctx.id === 'observe-shared-event') events.push(event);
		});
		const stopSecond = observe((event, ctx) => {
			if (ctx.id === 'observe-shared-event') events.push(event);
		});
		const ctx = createContext('observe-shared-event');

		try {
			const event = ctx.emitEvent({ type: 'log', level: 'info', message: 'original' });

			expect(events).toHaveLength(2);
			expect(events[0]).not.toBe(event);
			expect(events[0]).toBe(events[1]);
			expect(events[0]).toMatchObject({
				type: event.type,
				v: event.v,
			});
			expect(Object.isFrozen(events[0])).toBe(true);
		} finally {
			stopFirst();
			stopSecond();
		}
	});

	it('continues delivery when one subscriber throws', () => {
		const error = new Error('observe subscriber failure');
		const failure = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const events: string[] = [];
		const stopThrowing = observe((_event, ctx) => {
			if (ctx.id === 'observe-thrown-failure') throw error;
		});
		const stopRecording = observe((event, ctx) => {
			if (ctx.id === 'observe-thrown-failure') events.push(event.type);
		});
		const ctx = createContext('observe-thrown-failure');

		try {
			ctx.emitEvent({ type: 'idle' });

			expect(events).toEqual(['idle']);
			expect(failure).toHaveBeenCalledWith('[flue:observe] subscriber failed:', error);
		} finally {
			stopThrowing();
			stopRecording();
			failure.mockRestore();
		}
	});

	it('continues delivery when one subscriber returns a rejected promise', async () => {
		const error = new Error('observe subscriber rejection');
		const failure = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const events: string[] = [];
		const stopRejecting = observe((_event, ctx) => {
			if (ctx.id === 'observe-rejected-failure') return Promise.reject(error);
		});
		const stopRecording = observe((event, ctx) => {
			if (ctx.id === 'observe-rejected-failure') events.push(event.type);
		});
		const ctx = createContext('observe-rejected-failure');

		try {
			ctx.emitEvent({ type: 'idle' });

			expect(events).toEqual(['idle']);
			await vi.waitFor(() => {
				expect(failure).toHaveBeenCalledWith('[flue:observe] subscriber failed:', error);
			});
		} finally {
			stopRejecting();
			stopRecording();
			failure.mockRestore();
		}
	});

	it('delivers every event type to each subscriber', () => {
		const events: string[] = [];
		const stopObserving = observe((event, ctx) => {
			if (ctx.id === 'observe-all-types') events.push(event.type);
		});
		const ctx = createContext('observe-all-types');

		try {
			ctx.emitEvent({ type: 'idle' });
			ctx.emitEvent({ type: 'log', level: 'info', message: 'kept' });

			expect(events).toEqual(['idle', 'log']);
		} finally {
			stopObserving();
		}
	});

	it('delivers events with circular values when an event is emitted', () => {
		const events: FlueObservation[] = [];
		const stopObserving = observe((event, ctx) => {
			if (ctx.id === 'observe-circular-values') events.push(event);
		});
		const ctx = createContext('observe-circular-values');
		const circular: { self?: unknown } = {};
		circular.self = circular;

		try {
			const event = ctx.emitEvent({
				type: 'log',
				level: 'info',
				message: 'delivered',
				attributes: { circular },
			});

			expect(events).toHaveLength(1);
			expect(events[0]).toMatchObject({
				type: event.type,
				v: event.v,
			});
			const observedCircular = (
				events[0] as Extract<FlueObservation, { type: 'log' }>
			).attributes?.circular as { self?: unknown };
			expect(observedCircular.self).toBe(observedCircular);
		} finally {
			stopObserving();
		}
	});

	it('adds observation-only detail without changing product events', () => {
		const observations: FlueObservation[] = [];
		const productEvents: unknown[] = [];
		const stopObserving = observe((event, ctx) => {
			if (ctx.id === 'observe-detail') observations.push(event);
		});
		const ctx = createContext('observe-detail');
		const stopProduct = ctx.subscribeEvent((event) => {
			productEvents.push(event);
		});

		try {
			ctx.emitEvent(
				{ type: 'operation_start', operationId: 'op-1', operationKind: 'prompt' },
				{ agentInput: { text: 'private prompt' } },
			);

			expect(observations[0]).toMatchObject({ agentInput: { text: 'private prompt' } });
			expect(productEvents[0]).not.toHaveProperty('agentInput');
		} finally {
			stopProduct();
			stopObserving();
		}
	});

	it('stops delivery when the unsubscribe callback is invoked', () => {
		const events: string[] = [];
		const stopObserving = observe((event, ctx) => {
			if (ctx.id === 'observe-unsubscribe') events.push(event.type);
		});
		const ctx = createContext('observe-unsubscribe');

		try {
			ctx.emitEvent({ type: 'idle' });
			stopObserving();
			ctx.emitEvent({ type: 'idle' });

			expect(events).toEqual(['idle']);
		} finally {
			stopObserving();
		}
	});
});
