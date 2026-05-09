/**
 * Tests for `loadFlueConfig` and the user-models resolver hook.
 *
 * Uses `node:test` and `node:assert` so no test framework dep is added.
 * Run with: `node --import tsx --test packages/sdk/test/config.test.ts`
 * (or any equivalent TS-aware Node runner). The assertions exercise the
 * pure validation paths plus a real esbuild-roundtrip of a `.ts` config.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
	__resetConfigCacheForTests,
	defineConfig,
	findFlueConfigPath,
	loadFlueConfig,
} from '../src/config.ts';
import { resolveModel } from '../src/internal.ts';
import { defineOpenAICompletionsModel } from '../src/model-helpers.ts';

let workspace = '';

beforeEach(() => {
	workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'flue-config-test-'));
	__resetConfigCacheForTests();
});

afterEach(() => {
	fs.rmSync(workspace, { recursive: true, force: true });
});

function writeConfig(filename: string, source: string): void {
	fs.writeFileSync(path.join(workspace, filename), source, 'utf-8');
}

describe('findFlueConfigPath', () => {
	it('returns null when no config file exists', () => {
		assert.equal(findFlueConfigPath(workspace), null);
	});

	it('honours extension priority: .ts > .mts > .js > .mjs', () => {
		writeConfig('flue.config.mjs', 'export default { target: "node" };');
		writeConfig('flue.config.js', 'export default { target: "node" };');
		writeConfig('flue.config.ts', 'export default { target: "node" };');
		const found = findFlueConfigPath(workspace);
		assert.ok(found);
		assert.equal(path.basename(found!), 'flue.config.ts');
	});
});

describe('loadFlueConfig', () => {
	it('returns null when no config exists', async () => {
		assert.equal(await loadFlueConfig(workspace), null);
	});

	it('loads a TypeScript config end-to-end', async () => {
		writeConfig(
			'flue.config.ts',
			`export default { target: 'node' as const };\n`,
		);
		const cfg = await loadFlueConfig(workspace);
		assert.ok(cfg);
		assert.equal(cfg!.target, 'node');
	});

	it('loads an mjs config without esbuild transformation', async () => {
		writeConfig(
			'flue.config.mjs',
			`export default { target: 'cloudflare' };\n`,
		);
		const cfg = await loadFlueConfig(workspace);
		assert.equal(cfg!.target, 'cloudflare');
	});

	it('throws when default export is missing', async () => {
		writeConfig('flue.config.mjs', `export const target = 'node';\n`);
		await assert.rejects(() => loadFlueConfig(workspace), /no default export/);
	});

	it('throws when target is not "node" or "cloudflare"', async () => {
		writeConfig(
			'flue.config.mjs',
			`export default { target: 'deno' };\n`,
		);
		await assert.rejects(() => loadFlueConfig(workspace), /Invalid `target`/);
	});

	it('throws when a models prefix is missing trailing slash', async () => {
		writeConfig(
			'flue.config.mjs',
			`export default { models: { ollama: () => ({}) } };\n`,
		);
		await assert.rejects(() => loadFlueConfig(workspace), /must end with "\/"/);
	});

	it('throws when a models factory is not a function', async () => {
		writeConfig(
			'flue.config.mjs',
			`export default { models: { 'ollama/': 'not a function' } };\n`,
		);
		await assert.rejects(
			() => loadFlueConfig(workspace),
			/must be a factory function/,
		);
	});

	it('memoises by absolute workspace path', async () => {
		writeConfig('flue.config.mjs', `export default { target: 'node' };\n`);
		const a = await loadFlueConfig(workspace);
		const b = await loadFlueConfig(workspace);
		assert.equal(a, b);
	});
});

describe('resolveModel + user models map', () => {
	it('routes a registered prefix through the user factory', () => {
		const userModels = {
			'ollama/': (suffix: string) =>
				defineOpenAICompletionsModel({
					id: suffix,
					baseUrl: 'http://localhost:11434/v1',
					provider: 'ollama',
				}),
		};

		const resolved = resolveModel('ollama/llama3.1:8b', undefined, userModels);
		assert.ok(resolved);
		assert.equal(resolved!.id, 'llama3.1:8b');
		assert.equal(resolved!.provider, 'ollama');
		assert.equal(resolved!.baseUrl, 'http://localhost:11434/v1');
	});

	it('picks the longest matching prefix when multiple are registered', () => {
		const calls: string[] = [];
		const userModels = {
			'foo/': (suffix: string) => {
				calls.push(`foo/${suffix}`);
				return defineOpenAICompletionsModel({
					id: suffix,
					baseUrl: 'http://example.test/v1',
					provider: 'foo-short',
				});
			},
			'foo/bar/': (suffix: string) => {
				calls.push(`foo/bar/${suffix}`);
				return defineOpenAICompletionsModel({
					id: suffix,
					baseUrl: 'http://example.test/v1',
					provider: 'foo-bar-long',
				});
			},
		};

		const resolved = resolveModel('foo/bar/baz', undefined, userModels);
		assert.equal(resolved!.provider, 'foo-bar-long');
		assert.deepEqual(calls, ['foo/bar/baz']);
	});

	it('throws a [flue]-prefixed error when a factory throws', () => {
		const userModels = {
			'broken/': () => {
				throw new Error('boom');
			},
		};

		assert.throws(
			() => resolveModel('broken/x', undefined, userModels as never),
			/\[flue\] models\["broken\/"\] factory threw .* boom/,
		);
	});

	it('throws when a factory returns a non-Model value', () => {
		const userModels = {
			'oops/': (() => 'not a model') as never,
		};

		assert.throws(
			() => resolveModel('oops/x', undefined, userModels),
			/factory must return a pi-ai Model/,
		);
	});

	it('rejects empty suffixes', () => {
		const userModels = {
			'ollama/': (suffix: string) =>
				defineOpenAICompletionsModel({
					id: suffix,
					baseUrl: 'http://localhost:11434/v1',
					provider: 'ollama',
				}),
		};

		assert.throws(
			() => resolveModel('ollama/', undefined, userModels),
			/Prefix "ollama\/" requires a suffix/,
		);
	});

	it('falls through to the pi-ai catalog when no prefix matches', () => {
		const userModels = {};
		const resolved = resolveModel(
			'anthropic/claude-haiku-4-5',
			undefined,
			userModels,
		);
		assert.ok(resolved);
		assert.equal(resolved!.provider, 'anthropic');
	});

	it('user prefix shadows the built-in cloudflare/ branch', () => {
		// Documents the resolution order: user prefixes win, even when they
		// reuse a name Flue ships internally (here "cloudflare/"). This is
		// intentional — it lets users override the built-in Workers AI
		// binding routing on the (unusual) day they need to.
		const userModels = {
			'cloudflare/': (suffix: string) =>
				defineOpenAICompletionsModel({
					id: suffix,
					baseUrl: 'https://example.test/v1',
					provider: 'user-shadowed-cloudflare',
				}),
		};

		const resolved = resolveModel('cloudflare/foo', undefined, userModels);
		assert.equal(resolved!.provider, 'user-shadowed-cloudflare');
		assert.equal(resolved!.baseUrl, 'https://example.test/v1');
	});
});

describe('defineConfig', () => {
	it('returns its argument unchanged for type-inference', () => {
		const cfg = defineConfig({ target: 'node' });
		assert.equal(cfg.target, 'node');
	});
});
