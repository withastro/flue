/**
 * The content pipeline shared by both trace backends:
 * detach → transform → serialize → truncate-at-budget.
 *
 * Transform is policy; the budget is physics. A transform never needs to
 * truncate for correctness — after it runs, the safety net guarantees the
 * serialized attribute fits `CONTENT_BUDGET_BYTES`, structurally, with
 * in-band sentinels. Transforms exist to redact, drop, reshape, or tighten
 * (via `truncateContent`); a transform may side-effect (ship content
 * elsewhere) and return `undefined` to omit it inline, with
 * `scope.traceId`/`scope.spanId` as the correlation handle where the backend
 * can supply them.
 */
import type { FlueObservation } from '../types.ts';
import { CONTENT_TRANSFORM_FAILED, CONTENT_UNSERIALIZABLE, truncateContent } from './truncate.ts';

export type GenAIContentType =
	| 'input_messages'
	| 'output_messages'
	| 'system_instructions'
	| 'tool_definitions'
	| 'tool_description'
	| 'tool_arguments'
	| 'tool_result'
	| 'exception_message'
	| 'exception_stacktrace';

export interface GenAIContentScope {
	contentType: GenAIContentType;
	eventType: FlueObservation['type'];
	agentName?: string;
	harness?: string;
	session?: string;
	parentSession?: string;
	instanceId?: string;
	submissionId?: string;
	conversationId?: string;
	operationId?: string;
	turnId?: string;
	taskId?: string;
	/** Supplied by `@flue/opentelemetry` from the span context; absent on the Cloudflare backend (platform spans expose no ids). */
	traceId?: string;
	spanId?: string;
}

export type ContentTransform = (content: unknown, scope: GenAIContentScope) => unknown | undefined;

/**
 * The whole content surface: `false` opts out, `{ transform }` is policy,
 * absent means content on with the safety net alone.
 */
export type ContentOption = false | { transform?: ContentTransform };

/**
 * 56 KiB — headroom under the workerd ~64 KB per-attribute cap, adopted by
 * both backends so the payload contract is identical everywhere.
 */
export const CONTENT_BUDGET_BYTES = 57_344;

export interface ContentAttributeOptions {
	contentType: GenAIContentType;
	/** Emit string content as-is instead of JSON-encoding it (tool payloads, descriptions, exception text). */
	rawString?: boolean;
	traceId?: string;
	spanId?: string;
}

export interface ContentAttributeResult {
	value?: string;
	/** Post-transform value was a plain object — decides `gen_ai.tool.call.*` vs the `flue.*` raw fallback keys. */
	objectShaped?: boolean;
}

const ENCODER = new TextEncoder();

export function contentAttribute(
	policy: ContentOption | undefined,
	content: unknown,
	event: FlueObservation,
	options: ContentAttributeOptions,
): ContentAttributeResult {
	if (policy === false || content === undefined) return {};
	let value: unknown = content;
	if (policy?.transform) {
		// The transform gets a private copy: it must never be able to mutate the
		// caller's original content, and its own copy must never be visible back
		// to the caller. A transform failure emits the sentinel, never the
		// un-transformed content — a failed redaction must not leak.
		try {
			value = policy.transform(structuredClone(content), contentScope(event, options));
		} catch {
			return { value: CONTENT_TRANSFORM_FAILED };
		}
		if (value === undefined) return {};
	}
	const objectShaped = isPlainObject(value);
	let serialized = serialize(value, options);
	if (serialized === undefined) return { value: CONTENT_UNSERIALIZABLE };
	if (ENCODER.encode(serialized).byteLength > CONTENT_BUDGET_BYTES) {
		serialized = serialize(truncateContent(value, { maxBytes: CONTENT_BUDGET_BYTES }), options);
		if (serialized === undefined) return { value: CONTENT_UNSERIALIZABLE };
	}
	return { value: serialized, objectShaped };
}

function serialize(value: unknown, options: ContentAttributeOptions): string | undefined {
	if (options.rawString && typeof value === 'string') return value;
	try {
		return JSON.stringify(value);
	} catch {
		return undefined;
	}
}

function contentScope(event: FlueObservation, options: ContentAttributeOptions): GenAIContentScope {
	return {
		contentType: options.contentType,
		eventType: event.type,
		...(event.agentName ? { agentName: event.agentName } : {}),
		...(event.harness ? { harness: event.harness } : {}),
		...(event.session ? { session: event.session } : {}),
		...(event.parentSession ? { parentSession: event.parentSession } : {}),
		...(event.instanceId ? { instanceId: event.instanceId } : {}),
		...(event.submissionId ? { submissionId: event.submissionId } : {}),
		...(event.conversationId ? { conversationId: event.conversationId } : {}),
		...(event.operationId ? { operationId: event.operationId } : {}),
		...(event.turnId ? { turnId: event.turnId } : {}),
		...(event.taskId ? { taskId: event.taskId } : {}),
		...(options.traceId ? { traceId: options.traceId } : {}),
		...(options.spanId ? { spanId: options.spanId } : {}),
	};
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== 'object') return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}
