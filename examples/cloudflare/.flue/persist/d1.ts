import type { SessionStore, SessionData } from '@flue/sdk/client';

/** Structural subset of Cloudflare's `D1Database`. */
interface D1Like {
	prepare(sql: string): {
		bind(...values: unknown[]): {
			first<T = unknown>(): Promise<T | null>;
			run(): Promise<unknown>;
		};
	};
}

export interface D1StoreOptions {
	/** Table name. Defaults to `flue_sessions`. */
	tableName?: string;
}

/**
 * Wrap a Cloudflare D1 binding into a Flue `SessionStore`. Pass `env.DB`
 * (or whatever your binding name is). Typed as `unknown` to match the
 * convention used by `getVirtualSandbox(bucket: unknown)` in the same
 * package — users with `@cloudflare/workers-types` installed pass a
 * `D1Database`, users without it work fine too.
 */
export function d1Store(db: unknown, options?: D1StoreOptions): SessionStore {
	const table = quoteIdent(options?.tableName ?? 'flue_sessions');
	const d1 = asD1Like(db);

	return {
		async save(id: string, data: SessionData): Promise<void> {
			await d1
				.prepare(
					`INSERT INTO ${table} (id, data, updated_at)
             VALUES (?1, ?2, ?3)
           ON CONFLICT(id) DO UPDATE SET
             data = excluded.data,
             updated_at = excluded.updated_at`,
				)
				.bind(id, JSON.stringify(data), Date.now())
				.run();
		},

		async load(id: string): Promise<SessionData | null> {
			const row = await d1
				.prepare(`SELECT data FROM ${table} WHERE id = ?1`)
				.bind(id)
				.first<{ data: string }>();
			return row ? (JSON.parse(row.data) as SessionData) : null;
		},

		async delete(id: string): Promise<void> {
			await d1.prepare(`DELETE FROM ${table} WHERE id = ?1`).bind(id).run();
		},
	};
}

function asD1Like(db: unknown): D1Like {
	if (
		db === null ||
		typeof db !== 'object' ||
		typeof (db as { prepare?: unknown }).prepare !== 'function'
	) {
		throw new Error(
			'[flue:d1] Expected a Cloudflare D1 binding. Pass env.DB ' +
				'(or your configured binding name) to d1Store().',
		);
	}
	return db as D1Like;
}

// Duplicated in postgres.ts on purpose — these recipes are copied
// independently into user projects, so they don't share a helper module.
function quoteIdent(name: string): string {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
		throw new Error(
			`[flue:d1] Invalid table name "${name}". ` +
				'Use only letters, digits, and underscores; must not start with a digit.',
		);
	}
	return `"${name}"`;
}
