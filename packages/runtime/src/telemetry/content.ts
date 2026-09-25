/**
 * The content pipeline shared by both trace backends:
 * detach → transform → serialize → truncate-at-budget.
 *
 * Transform is policy; the budget is physics. A transform never needs to
 * truncate for correctness — after it runs, the safety net guarantees the
 * serialized attribute fits its budget, structurally, with in-band
 * sentinels. Transforms exist to redact, drop, reshape, or tighten
 * (via `truncateContent`); a transform may side-effect (ship content
 * elsewhere) and return `undefined` to omit it inline, with
 * `scope.traceId`/`scope.spanId` as the correlation handle where the backend
 * can supply them.
 *
 * Backends record span content through a per-span ledger
 * (`createContentLedger` + `drawContentAttribute`): every content attribute
 * a span carries draws from one shared `CONTENT_BUDGET_BYTES` pool, so a
 * span's content can never collectively exhaust workerd's aggregate span
 * budget and knock out the operational attributes recorded after it.
 */
import type { FlueObservation } from '../types.ts';
import {
	CONTENT_TRANSFORM_FAILED,
	CONTENT_UNSERIALIZABLE,
	MIN_BUDGET_BYTES,
	truncateContent,
} from './truncate.ts';

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
 * 56 KiB — the per-span content pool, and the ceiling for any single
 * serialized content attribute. workerd caps a span's *total* attribute
 * bytes at 64 KiB and silently drops every write after the first overflow,
 * so content shares one pool per span; the 8 KiB left over is slack for the
 * operational attributes (usage, ids, error class) that must always land.
 * Adopted by both backends so the payload contract is identical
 * everywhere; each backend's options accept a `contentBudgetBytes` override
 * for hosts that don't conform to workerd's span limits (e.g. to ship full
 * prompts and tool results to a non-workerd observability backend).
 */
export const CONTENT_BUDGET_BYTES = 57_344;

/**
 * Input-side draws (request messages, system instructions, tool
 * definitions/descriptions/arguments) leave this much of the pool untouched,
 * so the response content recorded when the span ends always has room — a
 * large prompt must not be able to starve `gen_ai.output.messages`.
 */
export const OUTPUT_CONTENT_RESERVE_BYTES = 16_384;

export interface ContentAttributeOptions {
	contentType: GenAIContentType;
	/** Emit string content as-is instead of JSON-encoding it (tool payloads, descriptions, exception text). */
	rawString?: boolean;
	/**
	 * Tighter budget for this attribute, floored at 128 bytes. Ledger draws
	 * pass the pool remainder here; the pool (default `CONTENT_BUDGET_BYTES`,
	 * overridable per backend) is the ceiling, so a raised pool allows larger
	 * single attributes.
	 */
	maxBytes?: number;
	traceId?: string;
	spanId?: string;
}

export interface ContentAttributeResult {
	value?: string;
	/**
	 * @deprecated Retained for source compatibility. Tool payloads of every
	 * shape record under the semconv `gen_ai.tool.call.*` keys, so this no
	 * longer selects an attribute key. Reports whether the post-transform
	 * value was a plain object (serialized-object strings report `false`, as
	 * they always have).
	 */
	objectShaped?: boolean;
}

const ENCODER = new TextEncoder();

/** Content types whose value must stay an array of role/parts messages. */
const MESSAGE_CONTENT_TYPES: ReadonlySet<GenAIContentType> = new Set([
	'input_messages',
	'output_messages',
]);

/**
 * Shape-preserving fallback for message-array content types: the GenAI
 * semconv schema requires `gen_ai.input.messages` / `gen_ai.output.messages`
 * to be arrays of `{ role, parts }` messages (output messages also carry
 * `finish_reason`). A bare diagnostic string would violate that contract, so
 * serialization/transform failures emit the envelope instead. The envelope
 * (~90 bytes) always fits the 128-byte minimum budget.
 */
function messageContentFallback(
	diagnostic: string,
	options: ContentAttributeOptions,
): string | undefined {
	return serialize(
		[
			{
				role: 'flue',
				parts: [{ type: 'text', content: diagnostic }],
				...(options.contentType === 'output_messages' ? { finish_reason: 'error' } : {}),
			},
		],
		options,
	);
}

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
			return MESSAGE_CONTENT_TYPES.has(options.contentType)
				? {
						value:
							messageContentFallback(CONTENT_TRANSFORM_FAILED, options) ?? CONTENT_TRANSFORM_FAILED,
					}
				: { value: CONTENT_TRANSFORM_FAILED };
		}
		if (value === undefined) return {};
	}
	const objectShaped = isPlainObject(value);
	const budget =
		typeof options.maxBytes === 'number' && Number.isFinite(options.maxBytes)
			? Math.max(Math.floor(options.maxBytes), MIN_BUDGET_BYTES)
			: CONTENT_BUDGET_BYTES;
	let serialized = serialize(value, options);
	if (serialized === undefined) {
		return MESSAGE_CONTENT_TYPES.has(options.contentType)
			? { value: messageContentFallback(CONTENT_UNSERIALIZABLE, options) ?? CONTENT_UNSERIALIZABLE }
			: { value: CONTENT_UNSERIALIZABLE };
	}
	if (ENCODER.encode(serialized).byteLength > budget) {
		serialized = serialize(truncateContent(value, { maxBytes: budget }), options);
		if (serialized === undefined) {
			return MESSAGE_CONTENT_TYPES.has(options.contentType)
				? {
						value:
							messageContentFallback(CONTENT_UNSERIALIZABLE, options) ?? CONTENT_UNSERIALIZABLE,
					}
				: { value: CONTENT_UNSERIALIZABLE };
		}
	}
	return { value: serialized, objectShaped };
}

/** Content types that describe the request; everything else records the outcome. */
const INPUT_CONTENT_TYPES: ReadonlySet<GenAIContentType> = new Set([
	'input_messages',
	'system_instructions',
	'tool_definitions',
	'tool_description',
	'tool_arguments',
]);

/**
 * One span's shared content pool. `remaining` may end slightly negative:
 * a pool too dry for real content still emits the in-band truncation
 * sentinels at the 128-byte floor, and that overshoot (bounded by the
 * handful of content attributes a span carries) lands in the operational
 * slack above `CONTENT_BUDGET_BYTES`. The pool defaults to
 * `CONTENT_BUDGET_BYTES`; backends thread a configurable `contentBudgetBytes`
 * through when their host does not need workerd's span limits.
 */
export interface ContentLedger {
	remaining: number;
}

export function assertContentBudgetBytes(
	budgetBytes: unknown,
): asserts budgetBytes is number | undefined {
	if (budgetBytes === undefined) return;
	if (
		typeof budgetBytes !== 'number' ||
		!Number.isSafeInteger(budgetBytes) ||
		budgetBytes < MIN_BUDGET_BYTES
	) {
		throw new TypeError(
			`contentBudgetBytes must be a safe integer of at least ${MIN_BUDGET_BYTES} bytes; got ${String(budgetBytes)}.`,
		);
	}
}

export function createContentLedger(budgetBytes?: number): ContentLedger {
	assertContentBudgetBytes(budgetBytes);
	return { remaining: budgetBytes === undefined ? CONTENT_BUDGET_BYTES : budgetBytes };
}

export interface ContentDrawOptions extends Omit<ContentAttributeOptions, 'maxBytes'> {
	/**
	 * Attribute key the value will be recorded under — its bytes are charged
	 * against the pool alongside the value, matching how workerd bills spans.
	 */
	key: string;
}

/**
 * `contentAttribute` drawing from a span's pool instead of the flat
 * per-attribute ceiling. The producer is lazy so projection is skipped
 * entirely under `content: false`; input-side content types leave
 * `OUTPUT_CONTENT_RESERVE_BYTES` untouched. Nothing is charged for
 * attributes that end up omitted (absent content, transform drops).
 */
export function drawContentAttribute(
	ledger: ContentLedger,
	policy: ContentOption | undefined,
	produce: () => unknown,
	event: FlueObservation,
	options: ContentDrawOptions,
): ContentAttributeResult {
	if (policy === false) return {};
	const keyBytes = ENCODER.encode(options.key).byteLength;
	const reserve = INPUT_CONTENT_TYPES.has(options.contentType) ? OUTPUT_CONTENT_RESERVE_BYTES : 0;
	const result = contentAttribute(policy, produce(), event, {
		...options,
		maxBytes: ledger.remaining - reserve - keyBytes,
	});
	if (result.value !== undefined) {
		ledger.remaining -= keyBytes + ENCODER.encode(result.value).byteLength;
	}
	return result;
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
