import * as v from 'valibot';
import { RESERVED_SIGNAL_TYPES } from '../conversation-records.ts';
import { InvalidRequestError } from '../errors.ts';
import type { DeliveredMessage } from '../types.ts';

export const MAX_IMAGE_DATA_LENGTH = 14 * 1024 * 1024;

/** Attachment shape for a `DeliveredMessage`'s `attachments`. */
const DeliveredAttachmentSchema = v.object({
	type: v.literal('image'),
	data: v.pipe(
		v.string(),
		v.maxLength(
			MAX_IMAGE_DATA_LENGTH,
			`Image data exceeds the ${MAX_IMAGE_DATA_LENGTH} character limit.`,
		),
	),
	mimeType: v.string(),
	filename: v.optional(v.string()),
});

const DeliveredUserMessageSchema = v.object({
	kind: v.literal('user'),
	body: v.string(),
	attachments: v.optional(v.array(DeliveredAttachmentSchema)),
});

const DeliveredSignalMessageSchema = v.object({
	kind: v.literal('signal'),
	type: v.pipe(
		v.string(),
		v.nonEmpty('Signal message "type" must not be empty.'),
		// Reserved framework vocabulary: a record carrying one of these types
		// must be framework-authored (recovery classification and the
		// `useDelivery()` resume filter read provenance off the type string),
		// so no delivery surface may mint one.
		v.check(
			(type) => !RESERVED_SIGNAL_TYPES.has(type),
			(issue) =>
				`Signal type "${issue.input}" is framework-reserved vocabulary ` +
				"(the runtime's own narration and recovery signals) — use an application-specific type.",
		),
	),
	body: v.string(),
	attributes: v.optional(v.record(v.string(), v.string())),
	// The tag name is rendered unescaped as the signal's XML envelope in model
	// context, so it must be a valid XML name — anything looser would let a
	// caller-controlled value inject markup that the body/attribute escaping
	// exists to prevent.
	tagName: v.optional(
		v.pipe(
			v.string(),
			v.regex(
				/^[A-Za-z_][A-Za-z0-9_.-]*$/,
				'Signal message "tagName" must be a valid XML tag name ' +
					'(letters, digits, "_", "-", "."; must not start with a digit, "-", or ".").',
			),
		),
	),
});

/**
 * The single validated shape for a message delivered into an agent's
 * session, whether it arrives through `dispatch()` or a direct HTTP prompt
 * (whose wire body is this shape verbatim).
 */
export const DeliveredMessageSchema = v.variant('kind', [
	DeliveredUserMessageSchema,
	DeliveredSignalMessageSchema,
]);

/**
 * Validate a raw value as a {@link DeliveredMessage}. Shared by `dispatch()`
 * admission and the direct HTTP route so both transports produce the same
 * structured {@link InvalidRequestError} on bad input.
 */
export function parseDeliveredMessage(value: unknown): DeliveredMessage {
	const parsed = v.safeParse(DeliveredMessageSchema, value);
	if (parsed.success) return parsed.output;
	const specificIssue = parsed.issues.find(
		(issue) => issue.type === 'max_length' || issue.type === 'regex' || issue.type === 'check',
	);
	throw new InvalidRequestError({
		reason:
			specificIssue?.message ??
			'Delivered messages must be { kind: "user", body: string, attachments?: attachment[] } ' +
				'or { kind: "signal", type: string, body: string, attributes?: Record<string, string>, tagName?: string }.',
	});
}

/**
 * Validate a raw direct-HTTP body as a delivered input: a
 * {@link DeliveredMessage} with optional reserved top-level siblings, peeled
 * off before message validation —
 * - `initialData`: instance-creation data (the seed, used only when the send
 *   creates the instance);
 * - `uid`: the send condition (a string continues only that incarnation;
 *   `null` creates only when fresh; omitted sends unconditionally).
 */
export function parseDeliveredInput(value: unknown): {
	message: DeliveredMessage;
	initialData?: unknown;
	uid?: string | null;
} {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return { message: parseDeliveredMessage(value) };
	}
	if (!('initialData' in value) && !('uid' in value)) {
		return { message: parseDeliveredMessage(value) };
	}
	const { initialData, uid, ...rest } = value as Record<string, unknown>;
	if ('uid' in value && uid !== null && typeof uid !== 'string') {
		throw new InvalidRequestError({
			reason:
				'`uid` must be a string (continue only that incarnation) or null (create only when fresh).',
		});
	}
	return {
		message: parseDeliveredMessage(rest),
		...(initialData !== undefined ? { initialData } : {}),
		...('uid' in value ? { uid: uid as string | null } : {}),
	};
}
