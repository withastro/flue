import * as v from 'valibot';
import type { SubmissionAttemptRef } from './agent-execution-store.ts';
import {
	type AssistantMessageAbandonedRecord,
	type ConversationRecord,
	encodeCanonicalId,
} from './conversation-records.ts';
import { parseSessionStorageKey } from './session-identity.ts';

/** Stored evidence for one old dispatch. No old attempt or outcome is inferred. */
export interface AbandonedMessageAuthorization {
	before: SubmissionAttemptRef;
	target: {
		submissionId: string;
		sessionKey: string;
		sequence: number;
		settledAt: number;
	};
}

type Check<T> = { ok: true; value: T } | { ok: false; reason: string };

const Id = v.pipe(v.string(), v.minLength(1));
const Sequence = v.pipe(v.number(), v.safeInteger(), v.minValue(1));
const Timestamp = v.pipe(
	v.number(),
	v.safeInteger(),
	v.minValue(0),
	v.maxValue(8_640_000_000_000_000),
);
const RecordSchema = v.strictObject({
	v: v.literal(2),
	id: Id,
	type: v.literal('assistant_message_abandoned'),
	conversationId: Id,
	harness: v.literal('default'),
	session: v.literal('default'),
	timestamp: v.pipe(
		v.string(),
		v.check((value) => {
			const at = Date.parse(value);
			return Number.isFinite(at) && new Date(at).toISOString() === value;
		}),
	),
	submissionId: Id,
	messageId: Id,
});
const AuthorizationSchema = v.strictObject({
	before: v.strictObject({ submissionId: Id, attemptId: Id }),
	target: v.strictObject({
		submissionId: Id,
		sessionKey: Id,
		sequence: Sequence,
		settledAt: Timestamp,
	}),
});
const RowSchema = v.object({
	submissionId: Id,
	sessionKey: Id,
	sequence: Sequence,
	kind: v.picklist(['direct', 'dispatch']),
	status: v.picklist(['queued', 'running', 'terminalizing', 'settled', 'joining', 'joined']),
	attemptId: v.nullish(Id),
	joinedInto: v.nullish(Id),
	settledAt: v.nullish(Timestamp),
});
const StreamSchema = v.object({ agentName: Id, instanceId: Id });

/** Each message has one cleanup ID, across successors and retries. */
export function abandonedMessageRecordId(
	conversationId: string,
	submissionId: string,
	messageId: string,
): string {
	return `record_abandoned_${encodeCanonicalId(JSON.stringify([conversationId, submissionId, messageId]))}`;
}

/** Parse the new record before it enters the reducer or a storage adapter. */
export function parseAbandonedMessageRecord(
	value: unknown,
): Check<AssistantMessageAbandonedRecord> {
	const parsed = v.safeParse(RecordSchema, value);
	if (!parsed.success) return { ok: false, reason: 'Abandoned message record is malformed.' };
	const record = parsed.output;
	if (
		record.id !==
		abandonedMessageRecordId(record.conversationId, record.submissionId, record.messageId)
	) {
		return { ok: false, reason: 'Abandoned message record ID does not match its target.' };
	}
	return { ok: true, value: record };
}

/** Only a single cleanup record can use terminal-row evidence instead of an old attempt. */
export function parseAbandonedMessageBatch(
	records: readonly ConversationRecord[],
	authorization: unknown,
	submission: unknown,
): Check<
	| { record: AssistantMessageAbandonedRecord; authorization: AbandonedMessageAuthorization }
	| undefined
> {
	const hasCleanup = records.some((record) => record.type === 'assistant_message_abandoned');
	if (authorization === undefined && !hasCleanup) return { ok: true, value: undefined };
	if (submission !== undefined || records.length !== 1 || !hasCleanup) {
		return {
			ok: false,
			reason: 'Abandoned message cleanup requires one dedicated record and no ordinary attempt.',
		};
	}
	const parsedRecord = parseAbandonedMessageRecord(records[0]);
	if (!parsedRecord.ok) return parsedRecord;
	const parsed = v.safeParse(AuthorizationSchema, authorization);
	if (!parsed.success)
		return { ok: false, reason: 'Abandoned message authorization is malformed.' };
	if (parsed.output.target.submissionId !== parsedRecord.value.submissionId) {
		return { ok: false, reason: 'Abandoned message authorization names another target.' };
	}
	return { ok: true, value: { record: parsedRecord.value, authorization: parsed.output } };
}

/** Check current stored rows inside the append transaction, without changing the old row. */
export function checkAbandonedMessageRows(
	authorization: AbandonedMessageAuthorization,
	targetValue: unknown,
	beforeValue: unknown,
	streamValue: unknown,
): Check<void> {
	const target = v.safeParse(RowSchema, targetValue);
	const before = v.safeParse(RowSchema, beforeValue);
	const stream = v.safeParse(StreamSchema, streamValue);
	if (!target.success || !before.success || !stream.success) {
		return { ok: false, reason: 'Abandoned message stored evidence is missing or malformed.' };
	}
	const old = target.output;
	const next = before.output;
	const selected = authorization.target;
	if (
		old.kind !== 'dispatch' ||
		old.status !== 'settled' ||
		old.joinedInto != null ||
		old.settledAt == null
	) {
		return { ok: false, reason: 'Abandoned message target is not a settled unjoined dispatch.' };
	}
	if (
		old.submissionId !== selected.submissionId ||
		old.sessionKey !== selected.sessionKey ||
		old.sequence !== selected.sequence ||
		old.settledAt !== selected.settledAt
	) {
		return { ok: false, reason: 'Abandoned message terminal evidence changed.' };
	}
	if (
		next.submissionId !== authorization.before.submissionId ||
		next.attemptId !== authorization.before.attemptId ||
		next.status !== 'running'
	) {
		return { ok: false, reason: 'Abandoned message successor attempt is no longer running.' };
	}
	const session = parseSessionStorageKey(old.sessionKey);
	if (
		old.sessionKey !== next.sessionKey ||
		old.sequence >= next.sequence ||
		!session ||
		session.harness !== 'default' ||
		session.session !== 'default' ||
		session.agentName !== stream.output.agentName ||
		session.instanceId !== stream.output.instanceId
	) {
		return {
			ok: false,
			reason: 'Abandoned message target is outside the earlier submission scope.',
		};
	}
	return { ok: true, value: undefined };
}

/** SQL drivers can return integer columns as decimal strings. Other values remain invalid. */
export function abandonedMessageSqlRow(row: Record<string, unknown> | undefined): unknown {
	if (!row) return undefined;
	const integer = (value: unknown): unknown =>
		typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
	return {
		submissionId: row.submission_id,
		sessionKey: row.session_key,
		sequence: integer(row.sequence),
		kind: row.kind,
		status: row.status,
		attemptId: row.attempt_id,
		joinedInto: row.joined_into,
		settledAt: integer(row.settled_at),
	};
}
