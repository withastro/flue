import * as v from 'valibot';
import type { SqlStorage } from './sql-storage.ts';

/** One application queue row in the conversation store's local SQLite database. */
export interface LocalQueueAcknowledgment {
	readonly table: string;
	readonly key: Readonly<Record<string, string | number | null>>;
}

const IdentifierSchema = v.pipe(v.string(), v.regex(/^[A-Za-z_][A-Za-z0-9_]*$/));
const AcknowledgmentSchema = v.strictObject({
	table: v.pipe(
		IdentifierSchema,
		v.check((name) => !/^(flue_|sqlite_)/i.test(name)),
	),
	// A record schema drops keys such as "constructor". Every column must constrain the deletion.
	key: v.pipe(
		v.custom<Record<string, unknown>>(
			(key) => typeof key === 'object' && key !== null && !Array.isArray(key),
		),
		v.transform((key) => Object.entries(key)),
		v.array(
			v.tuple([IdentifierSchema, v.union([v.string(), v.pipe(v.number(), v.finite()), v.null()])]),
		),
		v.minLength(1),
		v.transform((entries): LocalQueueAcknowledgment['key'] => Object.fromEntries(entries)),
	),
});

/** Validate and copy at staging time, before the caller can change the key. */
export function assertLocalQueueAcknowledgment(value: unknown): LocalQueueAcknowledgment {
	const parsed = v.safeParse(AcknowledgmentSchema, value);
	if (!parsed.success) {
		throw new Error(
			'[flue] A local acknowledgment requires an application table and a non-empty row key. ' +
				'Use simple SQL names and string, finite number, or null key values. ' +
				'Tables starting with flue_ or sqlite_ are reserved.',
		);
	}
	return parsed.output;
}

/** Call only inside the transaction that inserts a new conversation batch. */
export function applyLocalQueueAcknowledgments(
	sql: SqlStorage,
	acknowledgments: readonly LocalQueueAcknowledgment[],
): void {
	for (const acknowledgment of acknowledgments) {
		const { table, key } = assertLocalQueueAcknowledgment(acknowledgment);
		const entries = Object.entries(key);
		const predicate = entries.map(([column]) => `"${table}"."${column}" IS ?`).join(' AND ');
		const rows = sql
			.exec(
				`DELETE FROM main."${table}" WHERE ${predicate} RETURNING 1`,
				...entries.map(([, value]) => value),
			)
			.toArray();
		if (rows.length !== 1) {
			throw new Error('[flue] A local acknowledgment must match exactly one queued row.');
		}
	}
}
