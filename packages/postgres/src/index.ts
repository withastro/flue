/**
 * @flue/postgres — Postgres persistence adapter for Flue.
 *
 * Provides a {@link PersistenceAdapter} backed by PostgreSQL. Bring your own
 * configured driver (node-postgres, porsager `postgres`, Neon WebSocket Pool, …)
 * wrapped in the {@link PostgresRunner} shape — this package does not pick or
 * bundle a driver.
 *
 * @example
 * ```ts
 * // src/db.ts
 * import { postgres, type PostgresQuery } from '@flue/postgres';
 * import sql from 'postgres';
 *
 * const db = sql(process.env.DATABASE_URL!);
 *
 * export default postgres({
 *   query: (text, params) => db.unsafe(text, params),
 *   transaction: <T>(fn: (tx: { query: PostgresQuery }) => Promise<T>) =>
 *     db.begin((tx) => fn({ query: (text, params) => tx.unsafe(text, params) })) as Promise<T>,
 *   close: () => db.end(),
 * });
 * ```
 */

export type { PostgresParameter, PostgresQuery, PostgresRunner } from './postgres-adapter.ts';
export { postgres } from './postgres-adapter.ts';
