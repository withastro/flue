import type { HttpClient } from '../http.ts';

/** One image attachment on a `kind: 'user'` delivered message. */
export interface DeliveredAttachment {
	type: 'image';
	data: string;
	mimeType: string;
	/** Optional original filename, surfaced on the projected `file` part. */
	filename?: string;
}

/**
 * The message delivered into an agent's session — the same unified shape the
 * server accepts from `dispatch()`. `kind: 'user'` is a direct user chat turn;
 * `kind: 'signal'` is a structured event (webhooks, schedules, multi-user
 * surfaces the agent participates in).
 */
export type DeliveredMessage =
	| { kind: 'user'; body: string; attachments?: DeliveredAttachment[] }
	| {
			kind: 'signal';
			type: string;
			body: string;
			attributes?: Record<string, string>;
			tagName?: string;
	  };

/** Options for delivering one message into the conversation. */
export interface AgentPromptOptions {
	message: DeliveredMessage;
	/**
	 * Instance-creation data — the seed, consulted only when this send
	 * creates the conversation: validated against the agent's `initialData`
	 * schema (when declared) and recorded once; the agent reads it with
	 * `useInitialData()`. Ignored when the send continues an existing
	 * conversation (pair with `uid: null` to error instead).
	 */
	initialData?: unknown;
	/**
	 * Send condition — sends are conditional requests, with the instance uid
	 * playing the ETag:
	 * - omitted: unconditional; continues the instance or creates it.
	 * - a string (from a previous send's `uid`): continue only that
	 *   incarnation; a missing instance or mismatched uid rejects with 404
	 *   and nothing is delivered. Cannot be combined with `initialData`.
	 * - `null`: create only when no instance exists; an existing instance
	 *   rejects with 409 (`agent_instance_exists`) carrying its uid in
	 *   `error.meta.uid` (read it from the `FlueApiError`'s `body`).
	 */
	uid?: string | null;
	/**
	 * Caller-chosen name for this delivery (at most 256 characters) — a
	 * retried send carrying the same key converges on the original submission
	 * instead of admitting a duplicate: the message is delivered and answered
	 * at most once, and every admission returns the same receipt (replays
	 * with `deduplicated: true`). The key names the delivery, not the
	 * outcome — a submission that settled `failed` stays failed; retry with a
	 * fresh key to ask again. Reusing a key with a different payload rejects
	 * with a 409 `submission_conflict` (read the existing submission's id
	 * from the `FlueApiError` body's `error.meta.submissionId`).
	 */
	idempotencyKey?: string;
	signal?: AbortSignal;
}

/** Result of admitting one message. All fields are server-provided. */
export interface AgentSendResult {
	/** Fully resolved DS-compatible stream URL for observing the conversation's events. */
	streamUrl: string;
	/**
	 * Opaque DS stream offset captured at admission. Reading `streamUrl` from
	 * this offset yields exactly this prompt's events. On a deduplicated send
	 * the offset is the stream origin (`'-1'`), not a tight prompt-events
	 * window — the settlement is still observable from there.
	 */
	offset: string;
	/** Correlates the admitted prompt with its attached agent events. */
	submissionId: string;
	/**
	 * The contacted instance's uid — minted when this send created the
	 * conversation, echoed when it continued one. Pass it back as the `uid`
	 * option to guarantee later sends reach this same incarnation.
	 */
	uid: string;
	/**
	 * Present (`true`) when this send's `idempotencyKey` converged on an
	 * existing submission instead of admitting a new one — the receipt echoes
	 * the original submission's facts, and no second turn runs.
	 */
	deduplicated?: boolean;
}

/** `POST <conversation url>` — 202 admission of one delivered message. */
export async function sendConversationMessage(
	http: HttpClient,
	options: AgentPromptOptions,
): Promise<AgentSendResult> {
	// `initialData`, `uid`, and `idempotencyKey` are reserved top-level
	// siblings beside the message fields; `uid: null` is meaningful
	// (create-only), so presence keys on the option, not on undefined.
	const siblings = {
		...(options.initialData !== undefined ? { initialData: options.initialData } : {}),
		...(options.uid !== undefined ? { uid: options.uid } : {}),
		...(options.idempotencyKey !== undefined ? { idempotencyKey: options.idempotencyKey } : {}),
	};
	return http.json<AgentSendResult>({
		method: 'POST',
		body: Object.keys(siblings).length > 0 ? { ...siblings, ...options.message } : options.message,
		signal: options.signal,
	});
}
