import type { HttpClient } from '../http.ts';
import type { DirectAgentPayload } from '../types.ts';

/** Options for one synchronous direct-agent invocation. */
export interface AgentInvokeOptions {
	payload: DirectAgentPayload;
	signal?: AbortSignal;
}

export type SyncInvokeResult = { result: unknown };

export async function invokeAgent(
	http: HttpClient,
	name: string,
	id: string,
	options: AgentInvokeOptions,
): Promise<SyncInvokeResult> {
	const path = `/agents/${encodeURIComponent(name)}/${encodeURIComponent(id)}`;
	return http
		.json<{ result?: unknown }>({
			method: 'POST',
			path,
			body: options.payload,
			signal: options.signal,
		})
		.then((body) => ({ result: body.result }));
}
