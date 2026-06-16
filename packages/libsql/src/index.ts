/**
 * @flue/libsql — libSQL / Turso persistence adapter for Flue.
 *
 * Provides a {@link PersistenceAdapter} backed by libSQL (Turso, embedded
 * replicas, or a local SQLite file). Bring your own configured `@libsql/client`
 * wrapped in the {@link LibsqlRunner} shape — this package does not pick or
 * bundle a driver.
 *
 * @example
 * ```ts
 * // src/db.ts
 * import { libsql } from '@flue/libsql';
 * import { createClient } from '@libsql/client';
 *
 * const client = createClient({
 *   url: process.env.LIBSQL_URL!,
 *   authToken: process.env.LIBSQL_AUTH_TOKEN,
 * });
 *
 * const toRows = (rs: { rows: ArrayLike<Record<string, unknown>>; columns: string[] }) =>
 *   Array.from(rs.rows, (row) =>
 *     Object.fromEntries(rs.columns.map((column) => [column, row[column]])));
 *
 * let tail: Promise<unknown> = Promise.resolve();
 * const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
 *   const result = tail.then(operation, operation);
 *   tail = result.then(() => undefined, () => undefined);
 *   return result;
 * };
 *
 * export default libsql({
 *   query: (text, params = []) =>
 *     serialize(async () => toRows(await client.execute({ sql: text, args: params }))),
 *   transaction: (fn) => serialize(async () => {
 *     const tx = await client.transaction('write');
 *     try {
 *       const result = await fn({
 *         query: async (text, params = []) =>
 *           toRows(await tx.execute({ sql: text, args: params })),
 *       });
 *       await tx.commit();
 *       return result;
 *     } catch (error) {
 *       await tx.rollback();
 *       throw error;
 *     } finally {
 *       tx.close();
 *     }
 *   }),
 *   close: () => client.close(),
 * });
 * ```
 */

export type { LibsqlParameter, LibsqlQuery, LibsqlRunner } from './libsql-adapter.ts';
export { libsql } from './libsql-adapter.ts';
