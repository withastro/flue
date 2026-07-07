/**
 * A2A protocol types — re-exported from the official @a2a-js/sdk.
 * Flue-specific constants and error types are defined locally.
 *
 * @see https://a2a-protocol.org/v1.0.0/specification/
 */

import { TaskState } from '@a2a-js/sdk';

// ---------------------------------------------------------------------------
// Type re-exports (A2A-prefixed aliases for backward compatibility)
// ---------------------------------------------------------------------------

export type { Part as A2APart } from '@a2a-js/sdk';
export type { Role as A2ARole } from '@a2a-js/sdk';
export type { Message as A2AMessage } from '@a2a-js/sdk';
export type { Artifact as A2AArtifact } from '@a2a-js/sdk';
export type { TaskState as A2ATaskState } from '@a2a-js/sdk';
export type { TaskStatus as A2ATaskStatus } from '@a2a-js/sdk';
export type { Task as A2ATask } from '@a2a-js/sdk';
export type { SendMessageConfiguration as A2ASendMessageConfiguration } from '@a2a-js/sdk';
export type { SendMessageRequest as A2ASendMessageRequest } from '@a2a-js/sdk';
export type { AgentInterface as A2AAgentInterface } from '@a2a-js/sdk';
export type { AgentCapabilities as A2AAgentCapabilities } from '@a2a-js/sdk';
export type { AgentSkill as A2AAgentSkill } from '@a2a-js/sdk';
export type { AgentProvider as A2AAgentProvider } from '@a2a-js/sdk';
export type { AgentCard as A2AAgentCard } from '@a2a-js/sdk';

// ---------------------------------------------------------------------------
// Value re-exports (enums, MessageFns, converters, constants)
// ---------------------------------------------------------------------------

export {
	TaskState,
	Role,
	Message,
	Task,
	Part,
	Artifact,
	SendMessageConfiguration,
	SendMessageRequest,
	SendMessageResponse,
	AgentCard,
	AgentInterface,
	AgentCapabilities,
	AgentSkill,
	AgentProvider,
	taskStateFromJSON,
	taskStateToJSON,
	roleFromJSON,
	roleToJSON,
	A2A_CONTENT_TYPE,
} from '@a2a-js/sdk';

// ---------------------------------------------------------------------------
// Flue-specific constants
// ---------------------------------------------------------------------------

/** Terminal states that cannot accept further messages. */
export const TERMINAL_TASK_STATES: ReadonlySet<TaskState> = new Set([
	TaskState.TASK_STATE_COMPLETED,
	TaskState.TASK_STATE_FAILED,
	TaskState.TASK_STATE_CANCELED,
	TaskState.TASK_STATE_REJECTED,
]);

/**
 * A2A error reason codes per Section 11.6.
 *
 * These are used as `reason` values inside `google.rpc.ErrorInfo`
 * details — not as URIs.
 */
export const A2A_ERROR_REASONS = {
	TASK_NOT_FOUND: 'TASK_NOT_FOUND',
	TASK_NOT_CANCELABLE: 'TASK_NOT_CANCELABLE',
	UNSUPPORTED_OPERATION: 'UNSUPPORTED_OPERATION',
	CONTENT_TYPE_NOT_SUPPORTED: 'CONTENT_TYPE_NOT_SUPPORTED',
	VERSION_NOT_SUPPORTED: 'VERSION_NOT_SUPPORTED',
} as const;

// ---------------------------------------------------------------------------
// Error response types (A2A HTTP+JSON binding, Section 11.6)
// ---------------------------------------------------------------------------

/** google.rpc.ErrorInfo detail entry used in A2A error responses. */
export interface A2ARpcErrorDetail {
	'@type': string;
	reason: string;
	domain: string;
}

/**
 * Error response envelope using the `google.rpc.Status` JSON
 * representation required by the A2A HTTP+JSON binding (Section 11.6).
 */
export interface A2ARpcStatus {
	error: {
		/** HTTP status code. */
		code: number;
		/** Canonical gRPC/Google-API status name (e.g. `"NOT_FOUND"`). */
		status: string;
		/** Human-readable error message. */
		message: string;
		/** Structured error details. */
		details: A2ARpcErrorDetail[];
	};
}
