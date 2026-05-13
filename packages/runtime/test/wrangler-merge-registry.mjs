#!/usr/bin/env node
/**
 * Inline test for the Cloudflare wrangler-merge handling of the new
 * `FlueRegistry` framework-owned DO class. Two concerns to lock down,
 * both pure functions:
 *
 *   1. `computeFlueMigrations(['FlueRegistry', ...], userMigrations)`
 *      emits a `flue-class-FlueRegistry` tag when the class is
 *      net-new, and stays a no-op when the migration tag already
 *      exists in the user's history. Mirrors the per-agent-class
 *      tag convention; no special-casing.
 *
 *   2. `mergeFlueAdditions(userConfig, additions)` with
 *      `additions.doBindings` containing the registry binding
 *      preserves the user's bindings, appends Flue's, and de-dupes
 *      on `name` (so a re-run of the build is idempotent).
 *
 * No CF runtime needed — JSON in, JSON out. Imports the CLI's
 * wrangler-merge source TS file directly via Node 24's native
 * TS-stripping loader. Same harness as `run-registry.mjs`.
 *
 * Run from packages/runtime/ after a fresh build of both packages:
 *
 *   pnpm --filter '@flue/runtime' run build &&
 *   pnpm --filter '@flue/cli'     run build &&
 *   node test/wrangler-merge-registry.mjs
 */
// biome-ignore-all lint/suspicious/noConsole: test runner output is its UX
import assert from 'node:assert/strict';
import {
	computeFlueMigrations,
	mergeFlueAdditions,
} from '../../cli/src/lib/cloudflare-wrangler-merge.ts';

let passed = 0;
const test = async (name, fn) => {
	try {
		await fn();
		console.log(`  ✓ ${name}`);
		passed++;
	} catch (err) {
		console.error(`  ✗ ${name}`);
		console.error(err);
		process.exit(1);
	}
};

console.log('computeFlueMigrations:');

await test(
	'registry class on fresh project emits flue-class-FlueRegistry alongside agent migrations',
	() => {
		const migrations = computeFlueMigrations(['FlueRegistry', 'Hello', 'WithSandbox'], []);
		// Sorted alphabetically per the function contract — easier to
		// assert against a fixed array than a set.
		assert.deepEqual(migrations, [
			{ tag: 'flue-class-FlueRegistry', new_sqlite_classes: ['FlueRegistry'] },
			{ tag: 'flue-class-Hello', new_sqlite_classes: ['Hello'] },
			{ tag: 'flue-class-WithSandbox', new_sqlite_classes: ['WithSandbox'] },
		]);
	},
);

await test('registry class already declared by a prior migration: no new entry emitted', () => {
	// Existing deployment that already has agent classes deployed and
	// is upgrading to this Flue version. Only FlueRegistry should
	// produce a new migration entry.
	const existing = [
		{ tag: 'flue-class-Hello', new_sqlite_classes: ['Hello'] },
		{ tag: 'flue-class-WithSandbox', new_sqlite_classes: ['WithSandbox'] },
	];
	const migrations = computeFlueMigrations(['FlueRegistry', 'Hello', 'WithSandbox'], existing);
	assert.deepEqual(migrations, [
		{ tag: 'flue-class-FlueRegistry', new_sqlite_classes: ['FlueRegistry'] },
	]);
});

await test('registry class declared via renamed_classes: not re-emitted', () => {
	const existing = [
		// Edge case: someone renamed an existing class to FlueRegistry
		// (effectively impossible in practice, but the merge logic
		// supports rename-on-to so we exercise it.)
		{ tag: 'custom-rename', renamed_classes: [{ from: 'OldRegistry', to: 'FlueRegistry' }] },
	];
	const migrations = computeFlueMigrations(['FlueRegistry'], existing);
	assert.deepEqual(migrations, []);
});

await test('idempotent re-run: no migrations on the second build of the same deploy', () => {
	const firstPass = computeFlueMigrations(['FlueRegistry', 'Hello'], []);
	const secondPass = computeFlueMigrations(['FlueRegistry', 'Hello'], firstPass);
	assert.deepEqual(secondPass, []);
});

console.log('\nmergeFlueAdditions:');

await test('FLUE_REGISTRY binding lands in durable_objects.bindings without disturbing user bindings', () => {
	const userConfig = {
		name: 'my-app',
		compatibility_date: '2026-04-01',
		compatibility_flags: ['nodejs_compat'],
		durable_objects: {
			bindings: [
				{ class_name: 'MyCustomDO', name: 'CUSTOM' },
				{ class_name: 'MySandbox', name: 'SANDBOX' },
			],
		},
	};
	const additions = {
		defaultName: 'fallback-name',
		main: '_entry.ts',
		doBindings: [
			{ class_name: 'Hello', name: 'Hello' },
			{ class_name: 'FlueRegistry', name: 'FLUE_REGISTRY' },
		],
		migrations: [{ tag: 'flue-class-FlueRegistry', new_sqlite_classes: ['FlueRegistry'] }],
	};
	const merged = mergeFlueAdditions(userConfig, additions);

	const bindings = merged.durable_objects.bindings;
	const names = bindings.map((b) => b.name);
	assert.deepEqual(
		names,
		['CUSTOM', 'SANDBOX', 'Hello', 'FLUE_REGISTRY'],
		'user bindings stay first, Flue appends in order',
	);
	const registry = bindings.find((b) => b.name === 'FLUE_REGISTRY');
	assert.equal(registry.class_name, 'FlueRegistry');
});

await test('FLUE_REGISTRY binding de-dupes on second build (idempotent)', () => {
	const userConfig = {
		durable_objects: {
			bindings: [
				// Imagine this got written by a previous Flue build.
				{ class_name: 'FlueRegistry', name: 'FLUE_REGISTRY' },
			],
		},
	};
	const additions = {
		defaultName: 'x',
		main: '_entry.ts',
		doBindings: [{ class_name: 'FlueRegistry', name: 'FLUE_REGISTRY' }],
		migrations: [],
	};
	const merged = mergeFlueAdditions(userConfig, additions);
	assert.equal(
		merged.durable_objects.bindings.length,
		1,
		'duplicate registry binding is not re-appended',
	);
});

await test('migrations append the registry tag without re-declaring existing tags', () => {
	const userConfig = {
		migrations: [{ tag: 'flue-class-Hello', new_sqlite_classes: ['Hello'] }],
	};
	const additions = {
		defaultName: 'x',
		main: '_entry.ts',
		doBindings: [],
		migrations: [
			{ tag: 'flue-class-Hello', new_sqlite_classes: ['Hello'] }, // already there
			{ tag: 'flue-class-FlueRegistry', new_sqlite_classes: ['FlueRegistry'] },
		],
	};
	const merged = mergeFlueAdditions(userConfig, additions);
	assert.deepEqual(
		merged.migrations.map((m) => m.tag),
		['flue-class-Hello', 'flue-class-FlueRegistry'],
		'Hello stays once, FlueRegistry is appended',
	);
});

console.log(`\nAll Commit B wrangler-merge tests passed (${passed}/${passed}).`);
