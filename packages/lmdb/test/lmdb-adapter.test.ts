/**
 * Contract tests for the LMDB persistence adapter.
 *
 * Uses a temporary directory for each test so no external server is needed.
 * Uses the shared contract test runner from @flue/runtime for behavioral
 * assertions, plus adapter-specific factory tests.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SessionData } from '@flue/runtime';
import { lmdb } from '../src/lmdb-adapter.ts';
import { defineStoreContractTests } from '@flue/runtime/test-utils';

// ─── Helpers ────────────────────────────────────────────────────────────────

function createTempDir(): string {
	return mkdtempSync(join(tmpdir(), 'flue-lmdb-test-'));
}

function sessionData(): SessionData {
	return {
		version: 5,
		affinityKey: 'affinity-1',
		entries: [],
		leafId: null,
		metadata: {},
		createdAt: '2026-06-03T00:00:00.000Z',
		updatedAt: '2026-06-03T00:00:00.000Z',
	};
}

// ─── Contract tests (shared) ────────────────────────────────────────────────

let testDir: string | undefined;

defineStoreContractTests('LMDB AgentExecutionStore', {
	create() {
		testDir = createTempDir();
		const adapter = lmdb(testDir);
		return adapter.connect();
	},
	async cleanup() {
		if (testDir) {
			try { rmSync(testDir, { recursive: true, force: true }); } catch {}
			testDir = undefined;
		}
	},
});

// ─── Adapter factory tests ──────────────────────────────────────────────────

describe('lmdb() PersistenceAdapter', () => {
	it('connects and closes cleanly', async () => {
		const dir = createTempDir();
		const adapter = lmdb(dir);
		const store = adapter.connect();
		await store.sessions.save('s1', sessionData());
		expect(await store.sessions.load('s1')).toEqual(sessionData());
		await adapter.close!();
		try { rmSync(dir, { recursive: true, force: true }); } catch {}
	});

	it('rejects double connect()', async () => {
		const dir = createTempDir();
		const adapter = lmdb(dir);
		adapter.connect();
		expect(() => adapter.connect()).toThrow('connect() was already called');
		await adapter.close!();
		try { rmSync(dir, { recursive: true, force: true }); } catch {}
	});

	it('close() is idempotent', async () => {
		const dir = createTempDir();
		const adapter = lmdb(dir);
		adapter.connect();
		await adapter.close!();
		await adapter.close!();
		try { rmSync(dir, { recursive: true, force: true }); } catch {}
	});

	it('rejects empty path', () => {
		expect(() => lmdb('')).toThrow('non-empty path');
		expect(() => lmdb('   ')).toThrow('non-empty path');
	});
});
