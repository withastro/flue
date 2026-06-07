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
 */

// ─── Store interfaces and vocabulary types ──────────────────────────────────

export type {
	AgentDispatchAdmission,
	AgentDispatchReceipt,
	AgentExecutionStore,
	AgentSubmission,
	AgentSubmissionStore,
	AgentTurnJournal,
	AgentTurnJournalPhase,
	CreateTurnJournalInput,
	PersistenceAdapter,
	SubmissionAttemptRef,
	SubmissionDurability,
} from './agent-execution-store.ts';

export {
	DURABILITY_DEFAULT_MAX_RETRY,
	DURABILITY_DEFAULT_TIMEOUT_MINUTES,
} from './agent-execution-store.ts';

// ─── Submission input types ─────────────────────────────────────────────────

export type {
	DirectAgentSubmissionInput,
	DispatchAgentSubmissionInput,
} from './runtime/agent-submissions.ts';

export { createDispatchAgentSubmissionInput } from './runtime/agent-submissions.ts';

export type { DispatchInput } from './runtime/dispatch-queue.ts';

// ─── Adapter helper functions ───────────────────────────────────────────────

export {
	deduplicateSessionDeletion,
	isSubmissionPayload,
	parseAcceptedAt,
	SUBMISSION_HARNESS_NAME,
} from './adapter-helpers.ts';

export type { SubmissionPayloadContext } from './adapter-helpers.ts';

export { createSessionStorageKey } from './session-identity.ts';

// ─── Re-export session types needed for SessionStore implementations ────────

export type { SessionData, SessionStore } from './types.ts';
