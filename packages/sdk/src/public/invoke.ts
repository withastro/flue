import type { HttpClient } from '../http.ts';
import type { FlueEvent } from '../types.ts';
import { readSse } from './stream.ts';

export type InvokeOptions =
	| { mode: 'sync'; payload?: unknown; signal?: AbortSignal }
	| { mode: 'webhook'; payload?: unknown; signal?: AbortSignal }
	| { mode: 'stream'; payload?: unknown; signal?: AbortSignal };

export type SyncInvokeResult = { result: unknown; runId: string };
export type WebhookInvokeResult = { runId: string };

export function invokeAgent(
	http: HttpClient,
	name: string,
	id: string,
	options: { mode: 'stream'; payload?: unknown; signal?: AbortSignal },
): AsyncIterable<FlueEvent>;
export function invokeAgent(
	http: HttpClient,
	name: string,
	id: string,
	options: { mode: 'sync'; payload?: unknown; signal?: AbortSignal },
): Promise<SyncInvokeResult>;
export function invokeAgent(
	http: HttpClient,
	name: string,
	id: string,
	options: { mode: 'webhook'; payload?: unknown; signal?: AbortSignal },
): Promise<WebhookInvokeResult>;
export function invokeAgent(
	http: HttpClient,
	name: string,
	id: string,
	options: InvokeOptions,
): Promise<SyncInvokeResult | WebhookInvokeResult> | AsyncIterable<FlueEvent> {
	const path = `/agents/${encodeURIComponent(name)}/${encodeURIComponent(id)}`;
	if (options.mode === 'stream') return invokeStream(http, path, options);
	return http
		.json<{ result?: unknown; _meta?: { runId?: string }; runId?: string }>({
			method: 'POST',
			path,
			body: options.payload ?? {},
			headers: options.mode === 'webhook' ? { 'x-webhook': 'true' } : undefined,
			signal: options.signal,
		})
		.then((body) => {
			const runId = body._meta?.runId ?? body.runId;
			if (!runId) throw new Error('Flue response did not include a runId.');
			return options.mode === 'webhook' ? { runId } : { result: body.result, runId };
		});
}

async function* invokeStream(
	http: HttpClient,
	path: string,
	options: { payload?: unknown; signal?: AbortSignal },
): AsyncIterable<FlueEvent> {
	const response = await http.fetchImpl(http.url(path), {
		method: 'POST',
		headers: await http.requestHeaders({ accept: 'text/event-stream' }, true),
		body: JSON.stringify(options.payload ?? {}),
		signal: options.signal,
	});
	if (!response.ok) throw new Error(`Invocation stream failed with HTTP ${response.status}.`);
	if (!response.body) throw new Error('Invocation stream response has no body.');
	for await (const frame of readSse(response.body)) {
		yield JSON.parse(frame.data) as FlueEvent;
	}
}
