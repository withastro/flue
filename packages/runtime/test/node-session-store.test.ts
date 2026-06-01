import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';
import { LocalGcsSessionStore } from '../src/node/session-store.ts';
import type { SessionData } from '../src/types.ts';

function sampleSession(): SessionData {
	return {
		version: 3,
		entries: [],
		leafId: null,
		metadata: { route: 'analytics' },
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
	};
}

async function tempDir() {
	return await fs.mkdtemp(path.join(os.tmpdir(), 'flue-session-store-'));
}

describe('LocalGcsSessionStore', () => {
	it('saves a Flue session snapshot locally and to GCS', async () => {
		const calls: Array<{ url: string; init: RequestInit }> = [];
		const store = new LocalGcsSessionStore({
			localDir: await tempDir(),
			bucket: 'bucket-a',
			prefix: 'agi/sessions',
			getAccessToken: async () => 'token-a',
			fetchImpl: (async (url, init) => {
				calls.push({ url: String(url), init: init ?? {} });
				return new Response(JSON.stringify({ ok: true }), { status: 200 });
			}) as typeof fetch,
		});

		await store.save('agent-session:["id","waiter","default"]', sampleSession());

		const localRaw = JSON.parse(await fs.readFile(store.localPath('agent-session:["id","waiter","default"]'), 'utf8'));
		expect(localRaw).toMatchObject({
			kind: 'flue.session',
			storageKey: 'agent-session:["id","waiter","default"]',
			session: { version: 3, metadata: { route: 'analytics' } },
		});
		expect(calls).toHaveLength(1);
		const call = calls[0]!;
		expect(call.url).toContain('/upload/storage/v1/b/bucket-a/o');
		expect(call.url).toContain('name=agi%2Fsessions%2F');
		expect(call.init.method).toBe('POST');
		expect((call.init.headers as Record<string, string>).authorization).toBe('Bearer token-a');
	});

	it('loads from local cache before GCS', async () => {
		let fetchCount = 0;
		const store = new LocalGcsSessionStore({
			localDir: await tempDir(),
			bucket: 'bucket-a',
			getAccessToken: async () => 'token-a',
			fetchImpl: (async () => {
				fetchCount++;
				return new Response('', { status: 500 });
			}) as typeof fetch,
		});
		const data = sampleSession();
		await fs.mkdir(path.dirname(store.localPath('session/local')), { recursive: true });
		await fs.writeFile(store.localPath('session/local'), JSON.stringify(data));

		await expect(store.load('session/local')).resolves.toEqual(data);
		expect(fetchCount).toBe(0);
	});

	it('restores from GCS into local cache when local file is missing', async () => {
		const data = sampleSession();
		const store = new LocalGcsSessionStore({
			localDir: await tempDir(),
			bucket: 'bucket-a',
			getAccessToken: async () => 'token-a',
			fetchImpl: (async () =>
				new Response(JSON.stringify({ kind: 'flue.session', storageKey: 'session/remote', session: data }), {
					status: 200,
				})) as typeof fetch,
		});

		await expect(store.load('session/remote')).resolves.toEqual(data);
		await expect(fs.readFile(store.localPath('session/remote'), 'utf8')).resolves.toContain('"kind": "flue.session"');
	});

	it('deletes local and remote session snapshots', async () => {
		const calls: Array<{ url: string; init: RequestInit }> = [];
		const store = new LocalGcsSessionStore({
			localDir: await tempDir(),
			bucket: 'bucket-a',
			getAccessToken: async () => 'token-a',
			fetchImpl: (async (url, init) => {
				calls.push({ url: String(url), init: init ?? {} });
				return new Response(null, { status: 204 });
			}) as typeof fetch,
		});
		await fs.mkdir(path.dirname(store.localPath('session/delete')), { recursive: true });
		await fs.writeFile(store.localPath('session/delete'), JSON.stringify(sampleSession()));

		await store.delete('session/delete');

		await expect(fs.stat(store.localPath('session/delete'))).rejects.toMatchObject({ code: 'ENOENT' });
		expect(calls).toHaveLength(1);
		const call = calls[0]!;
		expect(call.init.method).toBe('DELETE');
	});

	it('uses safe object and local paths for arbitrary Flue storage keys', async () => {
		const store = new LocalGcsSessionStore({ localDir: await tempDir(), prefix: '/agi/sessions/' });
		const key = 'agent-session:["conv/one","waiter","main:station"]';

		expect(store.objectName(key)).toMatch(/^agi\/sessions\/[A-Za-z0-9_-]+\.json$/);
		expect(path.basename(store.localPath(key))).toMatch(/^[A-Za-z0-9_-]+\.json$/);
	});
});
