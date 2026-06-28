import type { HttpClient } from '../http.ts';
import type { AgentPromptResponse } from '../types.ts';

export interface AgentPromptImage {
	type: 'image';
	data: string;
	mimeType: string;
	/** Optional original filename, surfaced on the projected `file` part. */
	filename?: string;
}

/** Options for one direct-agent prompt. */
export interface AgentPromptOptions {
	message: string;
	images?: AgentPromptImage[];
	signal?: AbortSignal;
}

/** Result of admitting one agent prompt. All fields are server-provided. */
export interface AgentSendResult {
	/** Fully resolved DS-compatible stream URL for observing the agent instance's events. */
	streamUrl: string;
	/**
	 * Opaque DS stream offset captured at admission. Reading `streamUrl` from
	 * this offset yields exactly this prompt's events.
	 */
	offset: string;
	/** Correlates the admitted prompt with its attached agent events. */
	submissionId: string;
}

/** Result of one agent prompt that waited for the terminal result. */
export interface AgentPromptResult extends AgentSendResult {
	/** Terminal result of the prompt. */
	result: AgentPromptResponse;
}

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
		body: { message: options.message, ...(options.images ? { images: options.images } : {}) },
		signal: options.signal,
	});
}

export async function sendAgent(
	http: HttpClient,
	name: string,
	id: string,
	options: AgentPromptOptions,
): Promise<AgentSendResult> {
	return http.json<AgentSendResult>({
		method: 'POST',
		path: `/agents/${encodeURIComponent(name)}/${encodeURIComponent(id)}`,
		body: { message: options.message, ...(options.images ? { images: options.images } : {}) },
		signal: options.signal,
	});
}
