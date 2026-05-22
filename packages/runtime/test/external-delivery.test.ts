import { describe, expect, it } from 'vitest';
import {
	configureFlueRuntime,
	InMemoryDispatchQueue,
	receiveExternalDelivery,
	type DispatchInput,
} from '../src/internal.ts';

describe('external delivery fan-out', () => {
	it('invokes every receive handler subscribed to the delivery channel', async () => {
		const calls: Array<{ agent: string; deliveryId: string }> = [];

		configureFlueRuntime({
			target: 'node',
			webhookAgents: [],
			allowNonWebhook: false,
			handlers: {},
			receiveHandlers: {
				moderator: async ({ delivery }) => calls.push({ agent: 'moderator', deliveryId: delivery.id }),
				audit: async ({ delivery }) => calls.push({ agent: 'audit', deliveryId: delivery.id }),
				ignored: async ({ delivery }) => calls.push({ agent: 'ignored', deliveryId: delivery.id }),
			},
			manifest: {
				agents: [
					{ name: 'moderator', channels: { discord: true }, receive: true, init: true },
					{ name: 'audit', channels: { discord: true, gchat: true }, receive: true, init: true },
					{ name: 'ignored', channels: { gchat: true }, receive: true, init: true },
				],
			},
		});

		const result = await receiveExternalDelivery({
			id: 'evt-1',
			channel: 'discord',
			type: 'message.created',
			data: { text: 'hello' },
		});

		expect(result.invoked).toEqual(['moderator', 'audit']);
		expect(calls).toEqual([
			{ agent: 'moderator', deliveryId: 'evt-1' },
			{ agent: 'audit', deliveryId: 'evt-1' },
		]);
	});

	it('passes a caller-provided dispatch function into receive handlers', async () => {
		const dispatches: DispatchInput[] = [];
		const queue = new InMemoryDispatchQueue({
			process(input) {
				dispatches.push(input);
			},
		});

		configureFlueRuntime({
			target: 'node',
			webhookAgents: [],
			allowNonWebhook: false,
			handlers: {},
			receiveHandlers: {
				moderator: async ({ dispatch }) => {
					await dispatch({ id: 'guild:1', session: 'case:1', input: { type: 'flagged' } });
				},
			},
			manifest: {
				agents: [{ name: 'moderator', channels: { discord: true }, receive: true, init: true }],
			},
		});

		await receiveExternalDelivery(
			{ id: 'evt-1', channel: 'discord', type: 'message.created', data: {} },
			{ dispatchQueue: queue },
		);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(dispatches).toHaveLength(1);
		expect(dispatches[0]).toMatchObject({
			deliveryId: 'evt-1',
			sourceAgent: 'moderator',
			targetAgent: 'moderator',
			agent: 'moderator',
			id: 'guild:1',
			session: 'case:1',
			input: { type: 'flagged' },
		});
		expect(dispatches[0]?.dispatchId).toEqual(expect.any(String));
		expect(dispatches[0]?.acceptedAt).toEqual(expect.any(String));
	});

	it('accepts zero, many, and cross-agent dispatches from one delivery', async () => {
		const dispatches: DispatchInput[] = [];
		const queue = new InMemoryDispatchQueue({
			process(input) {
				dispatches.push(input);
			},
		});

		configureFlueRuntime({
			target: 'node',
			webhookAgents: [],
			allowNonWebhook: false,
			handlers: {},
			receiveHandlers: {
				observer: async () => {},
				moderator: async ({ dispatch }) => {
					await dispatch({ id: 'guild:1', session: 'case:1', input: { type: 'first' } });
					await dispatch({ agent: 'audit', id: 'account:1', session: 'event:1', input: { type: 'audit' } });
				},
			},
			manifest: {
				agents: [
					{ name: 'observer', channels: { discord: true }, receive: true, init: true },
					{ name: 'moderator', channels: { discord: true }, receive: true, init: true },
					{ name: 'audit', channels: { gchat: true }, receive: true, init: true },
				],
			},
		});

		const result = await receiveExternalDelivery(
			{ id: 'evt-1', channel: 'discord', type: 'message.created', data: {} },
			{ dispatchQueue: queue },
		);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(result.errors).toEqual([]);
		expect(result.invoked).toEqual(['observer', 'moderator']);
		expect(dispatches).toHaveLength(2);
		expect(dispatches.map((dispatch) => dispatch.targetAgent)).toEqual(['moderator', 'audit']);
		expect(dispatches.map((dispatch) => dispatch.sourceAgent)).toEqual(['moderator', 'moderator']);
	});

	it('snapshots dispatch input at admission time', async () => {
		const dispatches: DispatchInput[] = [];
		const input = { nested: { count: 1 } };
		const queue = new InMemoryDispatchQueue({
			process(dispatch) {
				dispatches.push(dispatch);
			},
		});

		configureFlueRuntime({
			target: 'node',
			webhookAgents: [],
			allowNonWebhook: false,
			handlers: {},
			receiveHandlers: {
				moderator: async ({ dispatch }) => {
					await dispatch({ id: 'guild:1', session: 'case:1', input });
					input.nested.count = 2;
				},
			},
			manifest: {
				agents: [{ name: 'moderator', channels: { discord: true }, receive: true, init: true }],
			},
		});

		await receiveExternalDelivery(
			{ id: 'evt-1', channel: 'discord', type: 'message.created', data: {} },
			{ dispatchQueue: queue },
		);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(dispatches[0]?.input).toEqual({ nested: { count: 1 } });
	});

	it('isolates receive failures per subscribed agent', async () => {
		const calls: string[] = [];

		configureFlueRuntime({
			target: 'node',
			webhookAgents: [],
			allowNonWebhook: false,
			handlers: {},
			receiveHandlers: {
				bad: async () => {
					throw new Error('boom');
				},
				good: async () => {
					calls.push('good');
				},
			},
			manifest: {
				agents: [
					{ name: 'bad', channels: { discord: true }, receive: true, init: true },
					{ name: 'good', channels: { discord: true }, receive: true, init: true },
				],
			},
		});

		const result = await receiveExternalDelivery({
			id: 'evt-1',
			channel: 'discord',
			type: 'message.created',
			data: {},
		});

		expect(result.invoked).toEqual(['bad', 'good']);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]?.agent).toBe('bad');
		expect(calls).toEqual(['good']);
	});

	it('rejects invalid dispatches inside the current receive handler', async () => {
		configureFlueRuntime({
			target: 'node',
			webhookAgents: [],
			allowNonWebhook: false,
			handlers: {},
			receiveHandlers: {
				moderator: async ({ dispatch }) => {
					await dispatch({ id: '', session: 'case:1', input: { type: 'flagged' } });
				},
			},
			manifest: {
				agents: [{ name: 'moderator', channels: { discord: true }, receive: true, init: true }],
			},
		});

		const result = await receiveExternalDelivery({
			id: 'evt-1',
			channel: 'discord',
			type: 'message.created',
			data: {},
		});

		expect(result.invoked).toEqual(['moderator']);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]?.agent).toBe('moderator');
	});

	it('rejects missing target agents and non-serializable dispatch inputs', async () => {
		configureFlueRuntime({
			target: 'node',
			webhookAgents: [],
			allowNonWebhook: false,
			handlers: {},
			receiveHandlers: {
				missing: async ({ dispatch }) => {
					await dispatch({ agent: 'missing-target', id: 'x', session: 's', input: { ok: true } });
				},
				badInput: async ({ dispatch }) => {
					await dispatch({ id: 'x', session: 's', input: { fn: () => 'nope' } });
				},
			},
			manifest: {
				agents: [
					{ name: 'missing', channels: { discord: true }, receive: true, init: true },
					{ name: 'badInput', channels: { discord: true }, receive: true, init: true },
				],
			},
		});

		const result = await receiveExternalDelivery({
			id: 'evt-1',
			channel: 'discord',
			type: 'message.created',
			data: {},
		});

		expect(result.invoked).toEqual(['missing', 'badInput']);
		expect(result.errors.map((error) => error.agent)).toEqual(['missing', 'badInput']);
	});
});
