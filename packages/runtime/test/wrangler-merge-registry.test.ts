/**
 * Cloudflare wrangler-merge handling for the framework-owned
 * `FlueRegistry` DO class. Two concerns to lock down, both pure
 * functions:
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
 */
import { describe, expect, it } from 'vitest';
import {
	computeFlueMigrations,
	mergeFlueAdditions,
} from '../../cli/src/lib/cloudflare-wrangler-merge.ts';

describe('computeFlueMigrations', () => {
	it('emits flue-class-FlueRegistry on a fresh project alongside agent migrations', () => {
		const migrations = computeFlueMigrations(['FlueRegistry', 'Hello', 'WithSandbox'], []);
		// Sorted alphabetically per the function contract.
		expect(migrations).toEqual([
			{ tag: 'flue-class-FlueRegistry', new_sqlite_classes: ['FlueRegistry'] },
			{ tag: 'flue-class-Hello', new_sqlite_classes: ['Hello'] },
			{ tag: 'flue-class-WithSandbox', new_sqlite_classes: ['WithSandbox'] },
		]);
	});

	it('does not re-emit when the registry tag already exists', () => {
		// Existing deployment with agents already deployed, upgrading to
		// this Flue version. Only FlueRegistry should produce a new entry.
		const existing = [
			{ tag: 'flue-class-Hello', new_sqlite_classes: ['Hello'] },
			{ tag: 'flue-class-WithSandbox', new_sqlite_classes: ['WithSandbox'] },
		];
		const migrations = computeFlueMigrations(['FlueRegistry', 'Hello', 'WithSandbox'], existing);
		expect(migrations).toEqual([
			{ tag: 'flue-class-FlueRegistry', new_sqlite_classes: ['FlueRegistry'] },
		]);
	});

	it('treats a registry class declared via renamed_classes as already present', () => {
		const existing = [
			// Edge case: someone renamed an existing class to FlueRegistry.
			// Effectively impossible in practice, but the merge logic supports
			// rename-on-to so we exercise it.
			{ tag: 'custom-rename', renamed_classes: [{ from: 'OldRegistry', to: 'FlueRegistry' }] },
		];
		const migrations = computeFlueMigrations(['FlueRegistry'], existing);
		expect(migrations).toEqual([]);
	});

	it('is idempotent across consecutive builds of the same deploy', () => {
		const firstPass = computeFlueMigrations(['FlueRegistry', 'Hello'], []);
		const secondPass = computeFlueMigrations(['FlueRegistry', 'Hello'], firstPass);
		expect(secondPass).toEqual([]);
	});
});

describe('mergeFlueAdditions', () => {
	it('appends FLUE_REGISTRY binding without disturbing user bindings', () => {
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
		const merged = mergeFlueAdditions(userConfig, additions) as {
			durable_objects: { bindings: Array<{ name: string; class_name: string }> };
		};

		const bindings = merged.durable_objects.bindings;
		expect(bindings.map((b) => b.name)).toEqual([
			'CUSTOM',
			'SANDBOX',
			'Hello',
			'FLUE_REGISTRY',
		]);
		const registry = bindings.find((b) => b.name === 'FLUE_REGISTRY');
		expect(registry?.class_name).toBe('FlueRegistry');
	});

	it('de-dupes FLUE_REGISTRY binding on second build', () => {
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
		const merged = mergeFlueAdditions(userConfig, additions) as {
			durable_objects: { bindings: unknown[] };
		};
		expect(merged.durable_objects.bindings).toHaveLength(1);
	});

	it('appends the registry migration tag without re-declaring existing tags', () => {
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
		const merged = mergeFlueAdditions(userConfig, additions) as {
			migrations: Array<{ tag: string }>;
		};
		expect(merged.migrations.map((m) => m.tag)).toEqual([
			'flue-class-Hello',
			'flue-class-FlueRegistry',
		]);
	});
});
