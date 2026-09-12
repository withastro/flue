/**
 * Public adapter interface for persistence implementations.
 *
 * This subpath exports the types, interfaces, and helper functions needed
 * to implement a custom {@link PersistenceAdapter}. Use it when building
 * a persistence backend for a database not covered by the built-in adapters.
 *
 * ```ts
 * import type { AgentSubmissionStore, PersistenceAdapter } from '@flue/runtime/adapter';
 * import { createSessionStorageKey, parseAcceptedAt } from '@flue/runtime/adapter';
 * ```
 *
 * This surface is intentionally narrow: store interfaces, vocabulary types,
 * and pure adapter helper functions. It does not expose runtime orchestration,
 * provider plumbing, or generated-entry internals.
 *
 * There is ONE adapter contract for every backend — no SQL-only or "expert"
 * tiers. Each store interface documents its per-method invariants in prose
 * (atomicity, idempotency, gating conditions) so that non-SQL backends such
 * as MongoDB are first-class implementations. An adapter is correct when the
 * executable contract suites pass: `defineStoreContractTests`,
 * `defineConversationStreamStoreContractTests`, and
 * `defineAttachmentStoreContractTests` from `@flue/runtime/test-utils`.
 *
 * Stability: the `AgentSubmissionStore` settlement and lease method groups
 * mirror the durable-execution engine and are subject to change until 1.0 —
 * for every backend equally.
 */

// ─── Store interfaces and vocabulary types ──────────────────────────────────

export type {
	AgentDispatchAdmission,
	AgentSubmission,
	AgentSubmissionStore,
	PersistenceAdapter,
	PersistenceStores,
	SubmissionAttemptRef,
	SubmissionClaimRef,
	SubmissionDurability,
	SubmissionSettlementObligation,
} from './agent-execution-store.ts';

export {
	DURABILITY_DEFAULT_MAX_ATTEMPTS,
	DURABILITY_DEFAULT_TIMEOUT_MS,
	LEASE_DURATION_MS,
} from './agent-execution-store.ts';

// ─── Submission input types ─────────────────────────────────────────────────

export type { AgentSubmissionInput } from './runtime/agent-submissions.ts';

export { createDispatchAgentSubmissionInput } from './runtime/agent-submissions.ts';

export type { DispatchInput } from './runtime/dispatch-queue.ts';

// ─── Adapter helper functions ───────────────────────────────────────────────

export type {
	SubmissionAdmissionBackend,
	SubmissionAdmissionRow,
	SubmissionInsertRow,
	SubmissionPayloadContext,
} from './adapter-helpers.ts';
export {
	admitSubmissionWithBackend,
	clampLimit,
	isSubmissionPayload,
	parseAcceptedAt,
	SUBMISSION_HARNESS_NAME,
	SUBMISSION_SESSION_NAME,
} from './adapter-helpers.ts';

export { createSessionStorageKey, parseSessionStorageKey } from './session-identity.ts';

// ─── Format versioning ──────────────────────────────────────────────────────

export {
	AttachmentConflictError,
	AttachmentIntegrityError,
	ConversationStreamStoreError,
	PersistedFormatVersionError,
} from './errors.ts';
export { assertSupportedFlueFormatVersion, FLUE_FORMAT_VERSION } from './format-version.ts';

// ─── Submission payload chunking ─────────────────────────────────────────────

export type { SubmissionChunkRow, SubmissionChunkStore } from './persisted-image-placement.ts';
export {
	hydratePersistedSubmissionAttachments,
	matchesPersistedSubmissionAttachments,
	prepareSubmissionAttachments,
	sameSubmissionChunks,
} from './persisted-image-placement.ts';

// ─── Canonical conversation stream store ────────────────────────────────────

export type { AbandonedMessageAuthorization } from './abandoned-message.ts';
export {
	abandonedMessageSqlRow,
	checkAbandonedMessageRows,
	parseAbandonedMessageBatch,
} from './abandoned-message.ts';
export type {
	AssistantMessageAbandonedRecord,
	AttachmentRef,
	ConversationRecord,
	SubmissionSettledRecord,
} from './conversation-records.ts';
export type {
	AttachmentStore,
	GetAttachmentInput,
	PutAttachmentInput,
	StoredAttachment,
} from './runtime/attachment-store.ts';
export {
	attachmentBytesEqual,
	copyAttachmentBytes,
	createAttachmentRef,
	InMemoryAttachmentStore,
	sameAttachmentRef,
	verifyAttachmentBytes,
} from './runtime/attachment-store.ts';
export type {
	ConversationFoldCheckpoint,
	ConversationProducerClaim,
	ConversationStreamBatch,
	ConversationStreamIdentity,
	ConversationStreamMeta,
	ConversationStreamReadResult,
	ConversationStreamStore,
} from './runtime/conversation-stream-store.ts';
export {
	InMemoryConversationStreamStore,
	StreamListenerRegistry,
} from './runtime/conversation-stream-store.ts';
export type {
	SqlConversationDialect,
	SqlConversationDialectTx,
} from './runtime/sql-conversation-stream-store.ts';
export { defineSqlConversationStreamStore } from './runtime/sql-conversation-stream-store.ts';

// ─── Stream offsets ─────────────────────────────────────────────────────────

export {
	DEFAULT_READ_LIMIT,
	formatOffset,
	MAX_READ_LIMIT,
	parseOffset,
} from './runtime/stream-offsets.ts';
