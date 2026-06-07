/**
 * @flue/lmdb — LMDB persistence adapter for Flue.
 *
 * Provides a {@link PersistenceAdapter} backed by LMDB, a high-performance
 * key-value store. This is a non-SQL adapter that validates the persistence
 * interface works against a fundamentally different data model than SQL.
 *
 * @example
 * ```ts
 * // src/db.ts
 * import { lmdb } from '@flue/lmdb';
 * export default lmdb('./data/flue');
 * ```
 */

export { lmdb } from './lmdb-adapter.ts';
