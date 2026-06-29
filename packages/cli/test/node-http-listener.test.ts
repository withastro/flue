import { afterEach, describe, expect, it } from 'vitest';
import { createStableNodeListener, type LoadedNodeApplication } from '../src/lib/node-http-listener.ts';

const listeners: Array<ReturnType<typeof createStableNodeListener>> = [];

afterEach(async () => {
	await Promise.allSettled(listeners.splice(0).map((listener) => listener.stop()));
});

describe('createStableNodeListener()', () => {
	it('returns structured unavailable responses when no application is ready', async () => {
		const listener = createStableNodeListener({ port: 0 });
		listeners.push(listener);
		await listener.listen();

		const response = await fetch(listener.url);

		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			error: { type: 'runtime_unavailable', meta: { state: 'loading' } },
		});
	});

	it('delegates ready requests without changing authored responses', async () => {
		const listener = createStableNodeListener({ port: 0 });
		listeners.push(listener);
		await listener.listen();
		listener.install(application(() => new Response('authored', { status: 207, headers: { 'x-app': 'yes' } })));

		const response = await fetch(listener.url);

		expect(response.status).toBe(207);
		expect(response.headers.get('x-app')).toBe('yes');
		expect(await response.text()).toBe('authored');
	});

	it('reflects the Origin and answers preflight when dev CORS is enabled', async () => {
		const listener = createStableNodeListener({ port: 0, cors: true });
		listeners.push(listener);
		await listener.listen();
		listener.install(application(() => new Response('authored', { status: 200 })));

		const preflight = await fetch(listener.url, {
			method: 'OPTIONS',
			headers: { origin: 'http://localhost:5173', 'access-control-request-headers': 'authorization' },
		});
		expect(preflight.status).toBe(204);
		expect(preflight.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
		expect(preflight.headers.get('access-control-allow-headers')).toBe('authorization');

		const actual = await fetch(listener.url, { headers: { origin: 'http://localhost:5173' } });
		expect(actual.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
		expect(await actual.text()).toBe('authored');
	});

	it('exposes durable-stream offset headers so a separate-origin SDK can advance', async () => {
		const listener = createStableNodeListener({ port: 0, cors: true });
		listeners.push(listener);
		await listener.listen();
		listener.install(
			application(
				() =>
					new Response('[]', {
						status: 200,
						headers: {
							'content-type': 'application/json',
							'Stream-Next-Offset': '0000000000000000_0000000000000001',
							'Stream-Up-To-Date': 'true',
						},
					}),
			),
		);

		const response = await fetch(listener.url, { headers: { origin: 'http://localhost:5173' } });

		// Cross-origin JS can only read response headers the server lists in
		// `Access-Control-Expose-Headers`. The SDK resumes conversation/run
		// streams from `Stream-Next-Offset`, so without exposing it a separate-
		// origin SPA can never advance and re-applies the same batch forever.
		const exposed = (response.headers.get('access-control-expose-headers') ?? '')
			.split(',')
			.map((value) => value.trim().toLowerCase());
		expect(exposed).toContain('stream-next-offset');
		expect(exposed).toContain('stream-up-to-date');
	});

	it('does not add CORS headers without the dev cors option', async () => {
		const listener = createStableNodeListener({ port: 0 });
		listeners.push(listener);
		await listener.listen();
		listener.install(application(() => new Response('authored')));

		const response = await fetch(listener.url, { headers: { origin: 'http://localhost:5173' } });
		expect(response.headers.get('access-control-allow-origin')).toBe(null);
	});

	it('keeps accepted requests alive while rejecting new requests during drain', async () => {
		let release!: () => void;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		const listener = createStableNodeListener({ port: 0 });
		listeners.push(listener);
		await listener.listen();
		let entered!: () => void;
		const didEnter = new Promise<void>((resolve) => {
			entered = resolve;
		});
		listener.install(application(async () => {
			entered();
			await pending;
			return new Response('settled');
		}));
		const accepted = fetch(listener.url);
		await didEnter;

		listener.setUnavailable('draining');
		const rejected = await fetch(listener.url);
		release();

		expect(rejected.status).toBe(503);
		expect(await accepted.then((response) => response.text())).toBe('settled');
	});
});

function application(
	fetch: LoadedNodeApplication['fetch'],
): LoadedNodeApplication {
	return {
		fetch,
		enterActivity: () => ({ release() {} }),
		pauseAdmissions() {},
		waitForIdle: async () => undefined,
		stop: async () => undefined,
		closeSync() {},
	};
}
