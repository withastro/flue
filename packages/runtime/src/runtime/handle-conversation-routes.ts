import {
	type AgentConversationSelector,
	projectAgentConversationBatch,
	projectAgentConversationSnapshot,
} from '../conversation-public.ts';
import {
	loadReducedConversationPrefix,
	loadReducedConversationState,
} from '../conversation-reader.ts';
import { reduceConversationRecords } from '../conversation-reducer.ts';
import {
	InvalidRequestError,
	StreamNotFoundError,
	toHttpResponse,
} from '../errors.ts';
import type {
	ConversationSnapshotStore,
	ConversationStreamReadResult,
	ConversationStreamStore,
} from './conversation-stream-store.ts';

const SECURITY_HEADERS = {
	'X-Content-Type-Options': 'nosniff',
	'Cross-Origin-Resource-Policy': 'cross-origin',
};
const LONG_POLL_TIMEOUT_MS = 30_000;
const SSE_HEARTBEAT_MS = 15_000;

export async function handleAgentConversationRead(options: {
	store: ConversationStreamStore;
	snapshots?: ConversationSnapshotStore;
	path: string;
	request: Request;
}): Promise<Response> {
	const url = new URL(options.request.url);
	const view = url.searchParams.get('view');
	if (view === 'history') return historyResponse(options, selectorFrom(url));
	if (view === 'updates') return updatesResponse(options, selectorFrom(url));
	if (view === 'activity') return activityResponse(options);
	return errorResponse(
		new InvalidRequestError({ reason: 'Agent stream view is required. Use history, updates, or activity.' }),
	);
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
			...(meta.closed ? { 'Stream-Closed': 'true' } : {}),
			...SECURITY_HEADERS,
		},
	});
}

async function historyResponse(
	options: {
		store: ConversationStreamStore;
		snapshots?: ConversationSnapshotStore;
		path: string;
		request: Request;
	},
	selector: AgentConversationSelector,
): Promise<Response> {
	const url = new URL(options.request.url);
	if (url.searchParams.has('offset') || url.searchParams.has('tail') || url.searchParams.has('live')) {
		return errorResponse(
			new InvalidRequestError({ reason: 'History reads do not accept offset, tail, or live parameters.' }),
		);
	}
	const meta = await options.store.getMeta(options.path);
	if (!meta) return errorResponse(new StreamNotFoundError({ path: options.path }));
	const state = await loadReducedConversationState({
		store: options.store,
		path: options.path,
		snapshots: options.snapshots,
		streamIncarnation: meta.incarnation,
	});
	const snapshot = projectAgentConversationSnapshot(state, selector);
	if (!snapshot) return errorResponse(new StreamNotFoundError({ path: options.path }));
	return Response.json(snapshot, {
		headers: {
			'cache-control': 'no-store',
			'Stream-Next-Offset': snapshot.offset,
			'Stream-Up-To-Date': 'true',
			...SECURITY_HEADERS,
		},
	});
}

async function updatesResponse(
	options: {
		store: ConversationStreamStore;
		path: string;
		request: Request;
	},
	selector: AgentConversationSelector,
): Promise<Response> {
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
	if (live === 'sse') {
		return sseResponse(options.store, options.path, offset, selector, options.request.signal, false);
	}
	let state = await loadReducedConversationPrefix({
		store: options.store,
		path: options.path,
		offset,
	});
	let read = await options.store.read(options.path, { offset });
	if (live === 'long-poll' && read.batches.length === 0 && !read.closed) {
		const wait = await waitForData(options.store, options.path, options.request.signal);
		if (wait === 'aborted') return new Response(null, { status: 499, headers: SECURITY_HEADERS });
		if (wait === 'data') read = await options.store.read(options.path, { offset });
	}
	const projected = projectRead(state, read, selector, false);
	state = projected.state;
	return dsJsonResponse(projected.items, read, projected.offset);
}

async function activityResponse(options: {
	store: ConversationStreamStore;
	path: string;
	request: Request;
}): Promise<Response> {
	const url = new URL(options.request.url);
	if (url.searchParams.has('tail')) {
		return errorResponse(new InvalidRequestError({ reason: 'Activity streams do not accept tail.' }));
	}
	const offset = singleOffset(url);
	if (offset instanceof Response) return offset;
	const live = liveMode(url);
	if (live instanceof Response) return live;
	const meta = await options.store.getMeta(options.path);
	if (!meta) return errorResponse(new StreamNotFoundError({ path: options.path }));
	if (live === 'sse') {
		return sseResponse(options.store, options.path, offset, {}, options.request.signal, true);
	}
	let read = await options.store.read(options.path, { offset });
	if (live === 'long-poll' && read.batches.length === 0 && !read.closed) {
		const wait = await waitForData(options.store, options.path, options.request.signal);
		if (wait === 'aborted') return new Response(null, { status: 499, headers: SECURITY_HEADERS });
		if (wait === 'data') read = await options.store.read(options.path, { offset });
	}
	return dsJsonResponse(
		read.batches.flatMap((batch) =>
			batch.records.map((record) => ({ v: 1, type: 'conversation_activity', record })),
		),
		read,
		read.nextOffset,
	);
}

function projectRead(
	initialState: Awaited<ReturnType<typeof loadReducedConversationPrefix>>,
	read: ConversationStreamReadResult,
	selector: AgentConversationSelector,
	raw: boolean,
) {
	let state = initialState;
	const items: unknown[] = [];
	let offset = initialState.recordsThroughOffset;
	for (const batch of read.batches) {
		const previousState = state;
		state = reduceConversationRecords(state, batch.records, batch.offset);
		items.push(
			...(raw
				? batch.records.map((record) => ({ v: 1, type: 'conversation_activity', record }))
				: projectAgentConversationBatch({
						state,
						previousState,
						selector,
						records: batch.records,
					})),
		);
		offset = batch.offset;
	}
	return { state, items, offset };
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
			...(read.closed && read.upToDate ? { 'Stream-Closed': 'true' } : {}),
			...SECURITY_HEADERS,
		},
	});
}

function sseResponse(
	store: ConversationStreamStore,
	path: string,
	offset: string,
	selector: AgentConversationSelector,
	signal: AbortSignal,
	raw: boolean,
): Response {
	const encoder = new TextEncoder();
	let active = true;
	let unsubscribe = () => {};
	let heartbeat: ReturnType<typeof setInterval> | undefined;
	const body = new ReadableStream<Uint8Array>({
		async start(controller) {
			let state = await loadReducedConversationPrefix({ store, path, offset });
			let currentOffset = offset;
			let wake: (() => void) | undefined;
			unsubscribe = store.subscribe(path, () => wake?.());
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
					const read = await store.read(path, { offset: currentOffset });
					const projected = projectRead(state, read, selector, raw);
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
						...(read.closed && read.upToDate ? { streamClosed: true } : {}),
					};
					controller.enqueue(encoder.encode(`event: control\ndata:${JSON.stringify(control)}\n\n`));
					if (read.closed && read.upToDate) break;
					if (!read.upToDate) continue;
					await new Promise<void>((resolve) => {
						wake = resolve;
						setTimeout(resolve, LONG_POLL_TIMEOUT_MS);
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

function selectorFrom(url: URL): AgentConversationSelector {
	return {
		...(url.searchParams.get('conversationId')
			? { conversationId: url.searchParams.get('conversationId') as string }
			: {}),
		...(url.searchParams.get('harness') ? { harness: url.searchParams.get('harness') as string } : {}),
		...(url.searchParams.get('session') ? { session: url.searchParams.get('session') as string } : {}),
	};
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

function waitForData(
	store: ConversationStreamStore,
	path: string,
	signal: AbortSignal,
): Promise<'data' | 'timeout' | 'aborted'> {
	return new Promise((resolve) => {
		if (signal.aborted) return resolve('aborted');
		let settled = false;
		const finish = (value: 'data' | 'timeout' | 'aborted') => {
			if (settled) return;
			settled = true;
			unsubscribe();
			clearTimeout(timer);
			signal.removeEventListener('abort', onAbort);
			resolve(value);
		};
		const unsubscribe = store.subscribe(path, () => finish('data'));
		const timer = setTimeout(() => finish('timeout'), LONG_POLL_TIMEOUT_MS);
		const onAbort = () => finish('aborted');
		signal.addEventListener('abort', onAbort, { once: true });
	});
}

function errorResponse(error: InvalidRequestError | StreamNotFoundError): Response {
	return toHttpResponse(error);
}

function headError(error: StreamNotFoundError): Response {
	const response = toHttpResponse(error);
	return new Response(null, { status: response.status, headers: response.headers });
}
