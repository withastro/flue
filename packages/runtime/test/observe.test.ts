import { describe, expect, it, vi } from 'vite-plus/test';
import { observe } from '../src/index.ts';
import { createFlueContext, InMemorySessionStore } from '../src/internal.ts';

function createContext(id: string) {
	return createFlueContext({
		id,
		payload: {},
		env: {},
		agentConfig: {
			systemPrompt: '',
			skills: {},
			model: undefined,
			resolveModel: () => undefined,
		},
		createDefaultEnv: async () => {
			throw new Error('unexpected sandbox initialization');
		},
		defaultStore: new InMemorySessionStore(),
	});
}

describe('observe()', () => {
	it('receives decorated event snapshots when a runtime context emits events', () => {
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

	it("prevents one subscriber's event mutation from affecting another subscriber when an event is delivered", () => {
		const events: unknown[] = [];
		const stopMutating = observe((event, ctx) => {
			if (ctx.id !== 'observe-isolated-snapshot' || event.type !== 'log') return;
			event.message = 'mutated';
			const nested = event.attributes?.nested as { value: string };
			nested.value = 'mutated';
		});
		const stopRecording = observe((event, ctx) => {
			if (ctx.id === 'observe-isolated-snapshot') events.push(event);
		});
		const ctx = createContext('observe-isolated-snapshot');

		try {
			ctx.emitEvent({
				type: 'log',
				level: 'info',
				message: 'original',
				attributes: { nested: { value: 'original' } },
			});

			expect(events).toMatchObject([
				{
					type: 'log',
					message: 'original',
					attributes: { nested: { value: 'original' } },
				},
			]);
		} finally {
			stopMutating();
			stopRecording();
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
