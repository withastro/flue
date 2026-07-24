/** Shared per-agent HTTP dispatcher for the Node and Cloudflare targets. */

import type { FlueContextInternal } from '../client.ts';
import { InvalidRequestError, parseJsonBody, toHttpResponse } from '../errors.ts';
import { extractTraceCarrier } from '../execution-interceptor.ts';
import type { AttachedAgentSubmissionAdmission } from './agent-submissions.ts';
import type { DispatchInput } from './dispatch-queue.ts';
import { parseDeliveredInput } from './schemas.ts';

export function assertAgentDispatchAdmissionInput(input: unknown): asserts input is DispatchInput {
	if (!isDispatchInput(input))
		throw new Error('[flue] Internal dispatch admission received an invalid payload.');
}

function isDispatchInput(value: unknown): value is DispatchInput {
	if (!value || typeof value !== 'object') return false;
	const input = value as Partial<DispatchInput>;
	return (
		typeof input.submissionId === 'string' &&
		input.submissionId.trim() !== '' &&
		typeof input.agent === 'string' &&
		input.agent.trim() !== '' &&
		typeof input.id === 'string' &&
		input.id.trim() !== '' &&
		!!input.message &&
		typeof input.message === 'object' &&
		(input.uid === undefined || input.uid === null || typeof input.uid === 'string') &&
		typeof input.acceptedAt === 'string' &&
		input.acceptedAt.trim() !== ''
	);
}

/**
 * Caller-provided context factory. Differs per-target:
 *   - Node: env=process.env with adapter-backed canonical conversation stores.
 *   - Cloudflare: env=DO env with Durable Object canonical conversation stores.
 */
export interface CreateAgentContextOptions {
	id: string;
	agentName: string;
	request: Request;
	submissionId?: string;
}

export type CreateAgentContextFn = (options: CreateAgentContextOptions) => FlueContextInternal;

export interface HandleAgentOptions {
	request: Request;
	id: string;
	agentName: string;
	admitAttachedSubmission: AttachedAgentSubmissionAdmission;
}

/**
 * Derive the absolute DS stream URL advertised in invocation responses from
 * the incoming request URL (query stripped). Agent prompts stream at the
 * request URL itself.
 */
function invocationStreamUrl(request: Request): string {
	const url = new URL(request.url);
	url.search = '';
	return url.toString();
}

/**
 * Build the 202 admission response for an agent prompt. The stream
 * coordinates are mirrored as `Location` and `Stream-Next-Offset` headers,
 * matching the Durable Streams stream-creation convention.
 */
function admissionResponse(
	body: Record<string, unknown>,
	streamUrl: string,
	offset: string,
): Response {
	return new Response(JSON.stringify(body), {
		status: 202,
		headers: {
			'content-type': 'application/json',
			Location: streamUrl,
			'Stream-Next-Offset': offset,
		},
	});
}

/**
 * Handle one attached `/agents/:name/:id` prompt interaction.
 *
 * Admission is fire-and-forget: it returns accepted stream coordinates.
 * Events are available via the DS stream read endpoint (GET on the same URL).
 */
export async function handleAgentRequest(opts: HandleAgentOptions): Promise<Response> {
	const { request } = opts;

	try {
		if (new URL(request.url).searchParams.has('wait')) {
			throw new InvalidRequestError({
				reason:
					'Agent prompts are fire-and-forget and do not support `?wait=result`. ' +
					"Await completion with the SDK client's `wait()`, or read the conversation stream (GET this URL).",
			});
		}
		// The wire body IS a DeliveredMessage (plus optional reserved
		// `initialData` and `uid` siblings for instance creation / send
		// conditions) — the same
		// validated shape a `dispatch()` call admits, so both transports share
		// one schema and produce the same structured InvalidRequestError on bad
		// input.
		const { message, initialData, uid } = parseDeliveredInput(await parseJsonBody(request));
		const traceCarrier = extractTraceCarrier(request.headers);
		const streamUrl = invocationStreamUrl(request);
		const receipt = await opts.admitAttachedSubmission(message, {
			...(traceCarrier !== undefined ? { traceCarrier } : {}),
			...(initialData !== undefined ? { initialData } : {}),
			...(uid !== undefined ? { uid } : {}),
		});
		return admissionResponse(
			{
				streamUrl,
				offset: receipt.offset,
				submissionId: receipt.submissionId,
				uid: receipt.uid,
			},
			streamUrl,
			receipt.offset,
		);
	} catch (err) {
		return toHttpResponse(err);
	}
}
