import type { HttpClient } from '../http.ts';
import type { AttachedAgentEvent, AttachedAgentStreamError, DirectAgentPayload } from '../types.ts';
import { readSse } from './stream.ts';

interface AgentInvokeBaseOptions {
	payload: DirectAgentPayload;
	signal?: AbortSignal;
}

/** Options for one synchronous direct-agent invocation. */
export interface AgentSyncInvokeOptions extends AgentInvokeBaseOptions {
	mode: 'sync';
}

/** Options for one streamed direct-agent invocation. */
export interface AgentStreamInvokeOptions extends AgentInvokeBaseOptions {
	mode: 'stream';
}

/** Options for one direct-agent invocation. */
export type AgentInvokeOptions = AgentSyncInvokeOptions | AgentStreamInvokeOptions;

export type SyncInvokeResult = { result: unknown };

export function invokeAgent(
	http: HttpClient,
	name: string,
	id: string,
	options: AgentStreamInvokeOptions,
): AsyncIterable<AttachedAgentEvent>;
export function invokeAgent(
	http: HttpClient,
	name: string,
	id: string,
	options: AgentSyncInvokeOptions,
): Promise<SyncInvokeResult>;
export function invokeAgent(
	http: HttpClient,
	name: string,
	id: string,
	options: AgentInvokeOptions,
): Promise<SyncInvokeResult> | AsyncIterable<AttachedAgentEvent> {
	const path = `/agents/${encodeURIComponent(name)}/${encodeURIComponent(id)}`;
	if (options.mode === 'stream') return invokeStream(http, path, id, options);
	return http
		.json<{ result?: unknown }>({
			method: 'POST',
			path,
			body: options.payload,
			signal: options.signal,
		})
		.then((body) => ({ result: body.result }));
}

async function* invokeStream(
	http: HttpClient,
	path: string,
	instanceId: string,
	options: { payload: DirectAgentPayload; signal?: AbortSignal },
): AsyncIterable<AttachedAgentEvent> {
	const response = await http.fetchImpl(http.url(path), {
		method: 'POST',
		headers: await http.requestHeaders({ accept: 'text/event-stream' }, true),
		body: JSON.stringify(options.payload),
		signal: options.signal,
	});
	if (!response.ok) throw new Error(`Invocation stream failed with HTTP ${response.status}.`);
	if (!response.body) throw new Error('Invocation stream response has no body.');
	for await (const frame of readSse(response.body)) {
		const event = JSON.parse(frame.data) as unknown;
		if (frame.event === 'error') {
			if (!isAttachedAgentStreamError(event, instanceId))
				throw new Error('Agent invocation stream received an invalid error event.');
			throw new Error(event.error.message);
		}
		if (!isAttachedAgentEvent(event, instanceId))
			throw new Error('Agent invocation stream received an invalid event.');
		yield event;
	}
}

const ATTACHED_AGENT_EVENT_TYPES = new Set([
	'agent_start',
	'agent_end',
	'turn_start',
	'turn_request',
	'turn_end',
	'message_start',
	'message_update',
	'message_end',
	'text_delta',
	'thinking_start',
	'thinking_delta',
	'thinking_end',
	'tool_start',
	'tool_call',
	'turn',
	'task_start',
	'task',
	'compaction_start',
	'compaction',
	'operation_start',
	'operation',
	'log',
	'idle',
]);

function isAttachedAgentEvent(value: unknown, instanceId: string): value is AttachedAgentEvent {
	return (
		isRecord(value) &&
		typeof value.type === 'string' &&
		ATTACHED_AGENT_EVENT_TYPES.has(value.type) &&
		value.instanceId === instanceId &&
		value.runId === undefined
	);
}

function isAttachedAgentStreamError(
	value: unknown,
	instanceId: string,
): value is AttachedAgentStreamError {
	return (
		isRecord(value) &&
		value.type === 'error' &&
		value.instanceId === instanceId &&
		isRecord(value.error) &&
		typeof value.error.type === 'string' &&
		typeof value.error.message === 'string' &&
		typeof value.error.details === 'string'
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}
