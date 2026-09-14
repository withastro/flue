import { getConversationFoldHost } from '../conversation-fold-host.ts';
import {
	type ConversationStreamCheckpointChunk,
	projectAgentConversationSnapshot,
} from '../conversation-public.ts';
import { loadReducedConversationPrefix } from '../conversation-reader.ts';
import type { ReducedInstanceState } from '../conversation-reducer.ts';
import {
	AttachmentNotFoundError,
	InvalidRequestError,
	StreamNotFoundError,
	StreamOffsetGoneError,
	toHttpResponse,
} from '../errors.ts';
import type { AttachmentStore } from './attachment-store.ts';
import {
	LONG_POLL_TIMEOUT_MS,
	projectConversationRead,
	waitForConversationData,
} from './conversation-observer.ts';
import type {
	ConversationStreamReadResult,
	ConversationStreamStore,
} from './conversation-stream-store.ts';
import { parseOffset } from './stream-offsets.ts';

const SECURITY_HEADERS = {
	'X-Content-Type-Options': 'nosniff',
	'Cross-Origin-Resource-Policy': 'cross-origin',
};
const SSE_HEARTBEAT_MS = 15_000;

export async function handleAgentConversationRead(options: {
	store: ConversationStreamStore;
	path: string;
	request: Request;
}): Promise<Response> {
	const url = new URL(options.request.url);
	const view = url.searchParams.get('view') ?? 'history';
	if (view === 'history') return historyResponse(options);
	if (view === 'updates') return updatesResponse(options);
	return errorResponse(
		new InvalidRequestError({ reason: 'Invalid agent conversation view. Use history or updates.' }),
	);
}

/**
 * Serves the bytes of one attachment referenced by the default conversation.
 *
 * Resolves the agent instance's default conversation id and scopes the lookup to
 * it, so attachments belonging to task/action child conversations are never
 * served through the public route. The byte content is immutable (digest-keyed),
 * hence the long-lived private cache. The route is mounted on every agent
 * router; auth composes at the mount in `app.ts` like every other agent route.
 */
export async function handleAgentAttachmentRead(options: {
	conversationStore: ConversationStreamStore;
	attachmentStore: AttachmentStore;
	path: string;
	attachmentId: string;
}): Promise<Response> {
	const meta = await options.conversationStore.getMeta(options.path);
	if (!meta) return errorResponse(new StreamNotFoundError({ path: options.path }));
	// Resolving the default conversation id requires the reduced state — served
	// from the shared fold host, so a byte read folds only batches appended
	// since the instance's last read or write.
	const state = await getConversationFoldHost(
		options.conversationStore,
		options.path,
	).getStateAtHead();
	const snapshot = projectAgentConversationSnapshot(state);
	if (!snapshot) return errorResponse(new StreamNotFoundError({ path: options.path }));
	const stored = await options.attachmentStore.get({
		streamPath: options.path,
		conversationId: snapshot.conversationId,
		attachmentId: options.attachmentId,
	});
	if (!stored)
		return errorResponse(new AttachmentNotFoundError({ attachmentId: options.attachmentId }));
	return new Response(stored.bytes, {
		headers: {
			'content-type': stored.attachment.mimeType,
			'content-length': String(stored.attachment.size),
			'content-disposition': 'inline',
			'cache-control': 'private, max-age=31536000, immutable',
			// The mime type is uploader-controlled, so a malicious "image" could be
			// served as text/html. `sandbox` neutralizes script/HTML execution on
			// direct navigation (treating it as an opaque origin) without affecting
			// <img>/<a> sub-resource loads.
			'content-security-policy': 'sandbox',
			...SECURITY_HEADERS,
		},
	});
}

export async function handleAgentConversationHead(
	store: ConversationStreamStore,
	path: string,
): Promise<Response> {
	const meta = await store.getMeta(path);
	if (!meta) return headError(new StreamNotFoundError({ path }));
	return new Response(null, {
		headers: {
			'content-type': 'application/json',
			'cache-control': 'no-store',
			'Stream-Next-Offset': meta.nextOffset,
			'Stream-Up-To-Date': 'true',
			...SECURITY_HEADERS,
		},
	});
}

async function historyResponse(options: {
	store: ConversationStreamStore;
	path: string;
	request: Request;
}): Promise<Response> {
	const url = new URL(options.request.url);
	if (
		url.searchParams.has('offset') ||
		url.searchParams.has('tail') ||
		url.searchParams.has('live')
	) {
		return errorResponse(
			new InvalidRequestError({
				reason: 'History reads do not accept offset, tail, or live parameters.',
			}),
		);
	}
	const meta = await options.store.getMeta(options.path);
	if (!meta) return errorResponse(new StreamNotFoundError({ path: options.path }));
	const state = await getConversationFoldHost(options.store, options.path).getStateAtHead();
	const snapshot = projectAgentConversationSnapshot(state);
	if (!snapshot) return errorResponse(new StreamNotFoundError({ path: options.path }));
	// The projection is meta-free; the route stamps the stream's generation
	// identity so `observe()` can detect a reset-and-regrown stream mid-follow
	// (via the stream-checkpoint chunk) against the generation it hydrated from.
	return Response.json({ ...snapshot, incarnation: meta.incarnation } satisfies typeof snapshot, {
		headers: {
			'cache-control': 'no-store',
			'Stream-Next-Offset': snapshot.offset,
			'Stream-Up-To-Date': 'true',
			...SECURITY_HEADERS,
		},
	});
}

async function updatesResponse(options: {
	store: ConversationStreamStore;
	path: string;
	request: Request;
}): Promise<Response> {
	const url = new URL(options.request.url);
	if (url.searchParams.has('tail')) {
		return errorResponse(new InvalidRequestError({ reason: 'Update streams do not accept tail.' }));
	}
	const offset = singleOffset(url);
	if (offset instanceof Response) return offset;
	const live = liveMode(url);
	if (live instanceof Response) return live;
	const meta = await options.store.getMeta(options.path);
	if (!meta) return errorResponse(new StreamNotFoundError({ path: options.path }));
	// Reads start strictly after the requested offset, so equal-to-head is a
	// legal empty wait; strictly beyond the head is a resume checkpoint that
	// no longer exists (e.g. the store was reset and regrown shorter). Fail
	// loud with a structured 416 before any response commits — this guard
	// covers the plain, long-poll, and SSE paths, and without it the
	// store-level invariant throw would surface as a silently-retried 500
	// (or, on SSE, after the 200 already streamed). Compare numerically:
	// the offset format check above does not require fixed-width padding.
	if (parseOffset(offset) > parseOffset(meta.nextOffset)) {
		return errorResponse(
			new StreamOffsetGoneError({ path: options.path, offset, nextOffset: meta.nextOffset }),
		);
	}
	// Every wire response leads with a stream-checkpoint chunk carrying the
	// stream's generation identity. Riding an ordinary data frame is
	// deliberate: the durable-stream client verifiably strips response headers
	// and unknown control-frame fields before they reach SDK code, so an
	// in-band chunk is the only channel a client can see.
	const checkpoint: ConversationStreamCheckpointChunk = {
		type: 'stream-checkpoint',
		incarnation: meta.incarnation,
	};
	if (live === 'sse') {
		return sseResponse(options.store, options.path, offset, checkpoint, options.request.signal);
	}
	const state = await stateAtOffset(options.store, options.path, offset);
	let read = await options.store.read(options.path, { offset });
	if (live === 'long-poll' && read.batches.length === 0) {
		const waited = await waitForConversationData(
			options.store,
			options.path,
			offset,
			options.request.signal,
		);
		if (waited === 'aborted') return new Response(null, { status: 499, headers: SECURITY_HEADERS });
		read = waited;
	}
	const projected = projectConversationRead(state, read);
	return dsJsonResponse([checkpoint, ...projected.items], read, projected.offset);
}

/**
 * Reduced state at a reader's resume offset. The shared fold host serves the
 * head directly — the overwhelmingly common case: clients resume from a
 * history response's or admission receipt's `Stream-Next-Offset`. A lagging
 * offset (older than the head) rebuilds its prefix by replay, exactly as
 * before. Compared numerically: the wire offset format does not require
 * fixed-width padding.
 */
async function stateAtOffset(
	store: ConversationStreamStore,
	path: string,
	offset: string,
): Promise<ReducedInstanceState> {
	const state = await getConversationFoldHost(store, path).getStateAtHead();
	if (parseOffset(state.recordsThroughOffset) === parseOffset(offset)) return state;
	return loadReducedConversationPrefix({ store, path, offset });
}

function dsJsonResponse(
	items: unknown[],
	read: ConversationStreamReadResult,
	offset: string,
): Response {
	return Response.json(items, {
		headers: {
			'cache-control': 'no-store',
			'Stream-Next-Offset': offset,
			...(read.upToDate ? { 'Stream-Up-To-Date': 'true' } : {}),
			...SECURITY_HEADERS,
		},
	});
}

function sseResponse(
	store: ConversationStreamStore,
	path: string,
	offset: string,
	checkpoint: ConversationStreamCheckpointChunk,
	signal: AbortSignal,
): Response {
	const encoder = new TextEncoder();
	let active = true;
	let unsubscribe = () => {};
	let heartbeat: ReturnType<typeof setInterval> | undefined;
	const body = new ReadableStream<Uint8Array>({
		async start(controller) {
			// One checkpoint per SSE connection, as the first data frame. The DS
			// client buffers data frames until the first control frame, so this
			// rides ahead of (or together with) the first read cycle's items —
			// and every DS-internal reconnect is a fresh server connection,
			// which re-delivers it.
			controller.enqueue(encoder.encode(`event: data\ndata:${JSON.stringify([checkpoint])}\n\n`));
			let state = await stateAtOffset(store, path, offset);
			let currentOffset = offset;
			let wake: (() => void) | undefined;
			// A notification can fire while the loop is suspended in store.read
			// (whose result was snapshotted before the concurrent append), when
			// no wake is armed. The pending flag keeps it from being dropped —
			// without it the loop would sleep the full long-poll window.
			let pending = false;
			unsubscribe = store.subscribe(path, () => {
				pending = true;
				wake?.();
			});
			heartbeat = setInterval(() => {
				if (active) controller.enqueue(encoder.encode(': heartbeat\n\n'));
			}, SSE_HEARTBEAT_MS);
			const onAbort = () => {
				active = false;
				wake?.();
			};
			signal.addEventListener('abort', onAbort, { once: true });
			try {
				while (active) {
					pending = false;
					const read = await store.read(path, { offset: currentOffset });
					const projected = projectConversationRead(state, read);
					state = projected.state;
					if (projected.items.length > 0) {
						controller.enqueue(
							encoder.encode(`event: data\ndata:${JSON.stringify(projected.items)}\n\n`),
						);
					}
					currentOffset = read.nextOffset;
					const control = {
						streamNextOffset: currentOffset,
						...(read.upToDate ? { upToDate: true } : {}),
					};
					controller.enqueue(encoder.encode(`event: control\ndata:${JSON.stringify(control)}\n\n`));
					if (!read.upToDate) continue;
					if (pending) continue;
					await new Promise<void>((resolve) => {
						wake = resolve;
						setTimeout(resolve, LONG_POLL_TIMEOUT_MS);
						if (pending || !active) resolve();
					});
					wake = undefined;
				}
			} finally {
				active = false;
				unsubscribe();
				if (heartbeat) clearInterval(heartbeat);
				signal.removeEventListener('abort', onAbort);
				controller.close();
			}
		},
		cancel() {
			active = false;
			unsubscribe();
			if (heartbeat) clearInterval(heartbeat);
		},
	});
	return new Response(body, {
		headers: {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache',
			...SECURITY_HEADERS,
		},
	});
}

function singleOffset(url: URL): string | Response {
	const offsets = url.searchParams.getAll('offset');
	if (offsets.length !== 1) {
		return errorResponse(new InvalidRequestError({ reason: 'Exactly one offset is required.' }));
	}
	const offset = offsets[0] as string;
	if (offset !== '-1' && !/^\d+_\d+$/.test(offset)) {
		return errorResponse(new InvalidRequestError({ reason: 'Invalid offset format.' }));
	}
	return offset;
}

function liveMode(url: URL): 'long-poll' | 'sse' | null | Response {
	const live = url.searchParams.get('live');
	if (live === null) return null;
	if (live === 'long-poll' || live === 'sse') return live;
	return errorResponse(
		new InvalidRequestError({ reason: 'Invalid live mode. Use long-poll or sse.' }),
	);
}

function errorResponse(
	error:
		InvalidRequestError | StreamNotFoundError | StreamOffsetGoneError | AttachmentNotFoundError,
): Response {
	return toHttpResponse(error);
}

function headError(error: StreamNotFoundError): Response {
	const response = toHttpResponse(error);
	return new Response(null, { status: response.status, headers: response.headers });
}
