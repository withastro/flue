import { HttpClient, type HttpClientOptions, type RequestHeaders } from './http.ts';
import type {
	FlueConversationHistoryOptions,
	FlueConversationMessage,
	FlueConversationSnapshot,
} from './public/conversation.ts';
import {
	assertConversationStreamChunk,
	type ConversationStreamChunk,
} from './public/conversation-stream.ts';
import {
	type AgentConversationObservation,
	type AgentConversationObserveOptions,
	createAgentConversationObservation,
} from './public/observe.ts';
import {
	type AgentReadOptions,
	type AgentReadResult,
	readAgentSubmissionReply,
} from './public/read.ts';
import {
	type AgentPromptOptions,
	type AgentSendResult,
	sendConversationMessage,
} from './public/send.ts';
import { type AgentWaitOptions, waitForAgentSubmission } from './public/settle.ts';
import { createFlueEventStream } from './public/stream.ts';

export type { HttpClientOptions } from './http.ts';
export type { RequestHeaders };

/** Result of aborting the conversation's durable work. */
export interface AgentAbortResult {
	/**
	 * `true` when there was in-flight or queued work that is now being aborted;
	 * `false` when the conversation was idle (nothing to abort). Terminal
	 * settlement (the distinct aborted outcome) happens asynchronously — observe
	 * it via `wait()` (which rejects with the submission_aborted error),
	 * `observe()`, or `history()`.
	 */
	aborted: boolean;
}

/** Options for creating a client for one agent conversation. */
export type CreateFlueClientOptions = HttpClientOptions;

/**
 * Client for one agent conversation of a deployed Flue application.
 *
 * The framework does not know where an application mounts its agents — the
 * application's route map (app.ts) does. A client therefore addresses exactly
 * one conversation by URL: wherever the agent's router
 * (`createAgentRouter(...)`) is mounted plus the caller-chosen conversation
 * id. Starting a new conversation is constructing a client with a fresh id
 * appended to the mount URL.
 */
export interface FlueClient {
	/** The fully resolved conversation URL this client addresses. */
	readonly url: string;
	/** Starts one message delivery without waiting for completion (202 admission). */
	send(options: AgentPromptOptions): Promise<AgentSendResult>;
	/**
	 * Awaits one submission's settlement and resolves with its reply. The
	 * target is the admission `send()` resolved with, or a bare submission id
	 * — the re-attach form, which follows the conversation from the stream
	 * origin, so any process can read a submission at any later time; one
	 * that already settled resolves immediately. Throws `FlueExecutionError`
	 * when the submission settles failed or aborted. Composes `wait()`,
	 * `history()`, and `readSubmissionReply()` — use those directly when you
	 * only need the outcome, or already hold the conversation via `observe()`.
	 */
	read(target: AgentSendResult | string, options?: AgentReadOptions): Promise<AgentReadResult>;
	/**
	 * Awaits the admitted submission's completion. Resolves void when it
	 * settles completed and throws `FlueExecutionError` when it settles
	 * failed or aborted. The agent's reply is not returned here — `read()`
	 * returns it, or read it from the conversation via `onEvent` chunks,
	 * `observe()`, or `history()`.
	 */
	wait(admission: AgentSendResult, options?: AgentWaitOptions): Promise<void>;
	/**
	 * Aborts all in-flight and queued durable work for the conversation (the
	 * currently running submission and any queued behind it). Resolves once the
	 * abort intent is recorded; the work settles to the distinct aborted
	 * outcome asynchronously.
	 */
	abort(options?: { signal?: AbortSignal }): Promise<AgentAbortResult>;
	/** Reads one materialized conversation snapshot. */
	history(options?: FlueConversationHistoryOptions): Promise<FlueConversationSnapshot>;
	/** Observes the materialized conversation across history catch-up and live updates. */
	observe(options?: AgentConversationObserveOptions): AgentConversationObservation;
	/**
	 * Absolute URL for one `file` part's attachment bytes, suitable as an
	 * `<img>`/`<a>` source. The download endpoint is mounted on every agent
	 * router; auth composes at the mount in `app.ts` like every other agent
	 * route.
	 */
	attachmentUrl(attachmentId: string): string;
}

// The runtime can't know the HTTP mount/conversation URL, so the SDK resolves
// a ready-to-use `url` onto each durably-recorded `file` part (those with an
// `id`). This lets consumers read `part.url` directly instead of constructing
// it via `attachmentUrl`. Optimistic parts (no `id`) carry their own `data:`
// preview and are left untouched.
function withAttachmentUrls(
	message: FlueConversationMessage,
	http: HttpClient,
): FlueConversationMessage {
	let changed = false;
	const parts = message.parts.map((part) => {
		if (part.type === 'file' && part.id !== undefined && part.url === undefined) {
			changed = true;
			return {
				...part,
				url: http.url(`/attachments/${encodeURIComponent(part.id)}`),
			};
		}
		return part;
	});
	return changed ? { ...message, parts } : message;
}

function rewriteSnapshotAttachmentUrls(
	snapshot: FlueConversationSnapshot,
	http: HttpClient,
): FlueConversationSnapshot {
	return {
		...snapshot,
		messages: snapshot.messages.map((message) => withAttachmentUrls(message, http)),
	};
}

function rewriteChunkAttachmentUrls(
	chunk: ConversationStreamChunk,
	http: HttpClient,
): ConversationStreamChunk {
	if (chunk.type === 'conversation-reset') {
		return { ...chunk, snapshot: rewriteSnapshotAttachmentUrls(chunk.snapshot, http) };
	}
	if (chunk.type === 'message-appended') {
		return { ...chunk, message: withAttachmentUrls(chunk.message, http) };
	}
	return chunk;
}

/** Creates a client for one agent conversation of a deployed Flue application. */
export function createFlueClient(options: CreateFlueClientOptions): FlueClient {
	const http = new HttpClient(options);
	return {
		url: http.conversationUrl,
		send: (opts) => sendConversationMessage(http, opts),
		read: (target, opts) => readAgentSubmissionReply(http, target, opts),
		wait: (admission, opts) => waitForAgentSubmission(http, admission, opts),
		abort: (opts = {}) =>
			http.json<AgentAbortResult>({
				method: 'POST',
				path: '/abort',
				signal: opts.signal,
			}),
		history: async (opts = {}) =>
			rewriteSnapshotAttachmentUrls(
				await http.json<FlueConversationSnapshot>({
					query: { view: 'history' },
					signal: opts.signal,
				}),
				http,
			),
		observe: (opts = {}) =>
			createAgentConversationObservation(
				{
					history: async (historyOptions) =>
						rewriteSnapshotAttachmentUrls(
							await http.json<FlueConversationSnapshot>({
								query: { view: 'history' },
								signal: historyOptions.signal,
							}),
							http,
						),
					updates: (updateOptions) =>
						createFlueEventStream<ConversationStreamChunk>(
							updateOptions,
							{
								url: http.url('', { view: 'updates' }),
								fetch: http.fetchWithHeaders.bind(http),
							},
							(chunk) => rewriteChunkAttachmentUrls(assertConversationStreamChunk(chunk), http),
						),
				},
				opts,
			),
		attachmentUrl: (attachmentId) => http.url(`/attachments/${encodeURIComponent(attachmentId)}`),
	};
}
