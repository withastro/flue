/**
 * Public adapter interface for persistence implementations.
 *
 * This subpath exports the types, interfaces, and helper functions needed
 * to implement a custom {@link PersistenceAdapter}. Use it when building
 * a persistence backend for a database not covered by the built-in adapters.
 *
 * ```ts
 * import type { AgentExecutionStore, PersistenceAdapter } from '@flue/runtime/adapter';
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
 * `defineRunStoreContractTests`, and `defineEventStreamStoreContractTests`
 * from `@flue/runtime/test-utils`.
 *
 * Stability: `RunStore` and `EventStreamStore` are stable.
 * The `AgentSubmissionStore` turn-journal, settlement, and lease method
 * groups mirror the durable-execution engine and are subject to change until
 * 1.0 — for every backend equally.
 */

// ─── Store interfaces and vocabulary types ──────────────────────────────────

export type {
	AgentAttemptMarker,
	AgentDispatchAdmission,
	AgentDispatchReceipt,
	AgentExecutionStore,
	AgentSubmission,
	AgentSubmissionStore,
	AgentTurnJournal,
	AgentTurnJournalPhase,
	CreateTurnJournalInput,
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

export type {
	DirectAgentSubmissionInput,
	DispatchAgentSubmissionInput,
} from './runtime/agent-submissions.ts';

export { createDispatchAgentSubmissionInput } from './runtime/agent-submissions.ts';

export type { DispatchInput } from './runtime/dispatch-queue.ts';

// ─── Adapter helper functions ───────────────────────────────────────────────

export type { SubmissionPayloadContext } from './adapter-helpers.ts';
export {
	clampLimit,
	isSubmissionPayload,
	parseAcceptedAt,
	SUBMISSION_HARNESS_NAME,
	SUBMISSION_SESSION_NAME,
} from './adapter-helpers.ts';

export { createSessionStorageKey } from './session-identity.ts';

// ─── Schema versioning ──────────────────────────────────────────────────────

export {
	AttachmentConflictError,
	AttachmentIntegrityError,
	ConversationStreamStoreError,
	PersistedSchemaVersionError,
} from './errors.ts';
export { assertSupportedFlueSchemaVersion, FLUE_SCHEMA_VERSION } from './schema-version.ts';

// ─── Persisted chunk placement ───────────────────────────────────────────────

export type {
	PersistedChunkOwner,
	PersistedChunkRow,
	PersistedChunkStore,
} from './persisted-image-placement.ts';
export {
	hydratePersistedDirectSubmission,
	matchesPersistedDirectSubmission,
	prepareDirectSubmission,
	samePersistedChunks,
	submissionChunkOwner,
} from './persisted-image-placement.ts';

// ─── Run store types ─────────────────────────────────────────────────────────

export type {
	CreateRunInput,
	EndRunInput,
	ListRunsOpts,
	ListRunsResponse,
	RunPointer,
	RunRecord,
	RunStatus,
	RunStore,
} from './runtime/run-store.ts';
export {
	DEFAULT_LIST_LIMIT,
	decodeRunCursor,
	encodeRunCursor,
	MAX_LIST_LIMIT,
} from './runtime/run-store.ts';

// ─── Canonical conversation stream store ────────────────────────────────────

export type {
	AttachmentRef,
	ConversationRecord,
	SubmissionSettledRecord,
} from './conversation-records.ts';
export type {
	AttachmentOwner,
	AttachmentStore,
	BindSubmissionAttachmentInput,
	GetAttachmentInput,
	PutAttachmentInput,
	StoredAttachment,
} from './runtime/attachment-store.ts';
export {
	attachmentBytesEqual,
	copyAttachmentBytes,
	createAttachmentRef,
	InMemoryAttachmentStore,
	sameAttachmentOwner,
	sameAttachmentRef,
	verifyAttachmentBytes,
} from './runtime/attachment-store.ts';
export { InMemoryConversationStreamStore } from './runtime/conversation-stream-store.ts';
export type {
	ConversationProducerClaim,
	ConversationStreamBatch,
	ConversationStreamIdentity,
	ConversationStreamMeta,
	ConversationStreamReadResult,
	ConversationStreamStore,
} from './runtime/conversation-stream-store.ts';

// ─── Event stream store ─────────────────────────────────────────────────────

export type {
	EventStreamMeta,
	EventStreamReadResult,
	EventStreamStore,
} from './runtime/event-stream-store.ts';
export {
	DEFAULT_READ_LIMIT,
	formatOffset,
	MAX_READ_LIMIT,
	parseOffset,
} from './runtime/event-stream-store.ts';
