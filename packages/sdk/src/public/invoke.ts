import type { HttpClient } from '../http.ts';
/** Options for one direct-agent prompt. */
export interface AgentPromptOptions {
	message: string;
	signal?: AbortSignal;
}

export type AgentPromptResult = { result: unknown; streamUrl: string; offset: string };

export async function promptAgent(
	http: HttpClient,
	name: string,
	id: string,
	options: AgentPromptOptions,
): Promise<AgentPromptResult> {
	const path = `/agents/${encodeURIComponent(name)}/${encodeURIComponent(id)}?wait=result`;
	return http.json<AgentPromptResult>({
		method: 'POST',
		path,
		body: { message: options.message },
		signal: options.signal,
	});
}

export async function sendAgent(
	http: HttpClient,
	name: string,
	id: string,
	options: AgentPromptOptions,
): Promise<{ streamUrl: string; offset: string }> {
	return http.json({
		method: 'POST',
		path: `/agents/${encodeURIComponent(name)}/${encodeURIComponent(id)}`,
		body: { message: options.message },
		signal: options.signal,
	});
}
