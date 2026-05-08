import type { SessionStore, SessionData } from '@flue/sdk/client';

/** Structural subset of `pg.Client` and `pg.Pool` — accepts either. */
interface PgQueryable {
	query<R = unknown>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

export interface PostgresStoreOptions {
	/** Table name. Defaults to `flue_sessions`. */
	tableName?: string;
}

/**
 * Wrap a configured `pg` Client or Pool into a Flue `SessionStore`. The user
 * owns the client lifecycle (credentials, TLS, pool sizing); this adapter
 * just translates `save / load / delete` to SQL.
 */
export function postgresStore(
	client: PgQueryable,
	options?: PostgresStoreOptions,
): SessionStore {
	const table = quoteIdent(options?.tableName ?? 'flue_sessions');

	return {
		async save(id: string, data: SessionData): Promise<void> {
			await client.query(
				`INSERT INTO ${table} (id, data, updated_at)
           VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (id) DO UPDATE
           SET data = EXCLUDED.data,
               updated_at = NOW()`,
				[id, JSON.stringify(data)],
			);
		},

		async load(id: string): Promise<SessionData | null> {
			const { rows } = await client.query<{ data: SessionData }>(
				`SELECT data FROM ${table} WHERE id = $1`,
				[id],
			);
			return rows[0]?.data ?? null;
		},

		async delete(id: string): Promise<void> {
			await client.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
		},
	};
}

// Duplicated in d1.ts on purpose — these recipes are copied independently
// into user projects, so they don't share a helper module.
function quoteIdent(name: string): string {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
		throw new Error(
			`[flue:postgres] Invalid table name "${name}". ` +
				'Use only letters, digits, and underscores; must not start with a digit.',
		);
	}
	return `"${name}"`;
}
