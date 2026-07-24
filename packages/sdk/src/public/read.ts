/**
 * `read()` — await one submission's settlement and resolve with its reply.
 *
 * The HTTP counterpart of the runtime handle's `read()`: it composes the
 * settlement follow (`wait()`), a `history()` read, and the
 * `readSubmissionReply()` projection into the one-shot round trip:
 *
 * ```ts
 * const admission = await conversation.send({ message });
 * const reply = await conversation.read(admission);
 * ```
 *
 * The bare-id form re-attaches: it follows the conversation from the stream
 * origin, so any process holding just the submission id can read the reply at
 * any later time, and a submission that already settled resolves immediately.
 */

import type { HttpClient } from '../http.ts';
import type { FlueConversationSnapshot } from './conversation.ts';
import { type AgentSubmissionReply, readSubmissionReply } from './reply.ts';
import type { AgentSendResult } from './send.ts';
import {
	type AgentSettlementTarget,
	type AgentWaitOptions,
	waitForAgentSubmission,
} from './settle.ts';

/** Options for one `read()`. The same knobs as `wait()`, which it composes. */
export type AgentReadOptions = AgentWaitOptions;

/**
 * The read target `normalizeReadTarget` resolves to — a real `send()`
 * admission (uid always present) or the bare-id re-attach path's synthesized
 * origin-offset target, which carries no uid.
 */
interface ReadTarget extends AgentSettlementTarget {
	uid?: string;
}

/** The settled reply a `read()` resolves with. */
export interface AgentReadResult extends AgentSubmissionReply {
	/** The settled submission's id. */
	submissionId: string;
	/** The contacted instance's uid, when the target admission carried one. */
	uid?: string;
}

export async function readAgentSubmissionReply(
	http: HttpClient,
	target: AgentSendResult | string,
	options: AgentReadOptions = {},
): Promise<AgentReadResult> {
	const admission = normalizeReadTarget(http, target);
	await waitForAgentSubmission(http, admission, options);
	const snapshot = await http.json<FlueConversationSnapshot>({
		query: { view: 'history' },
		signal: options.signal,
	});
	const reply = readSubmissionReply(snapshot, admission.submissionId);
	return {
		...reply,
		submissionId: admission.submissionId,
		...(admission.uid !== undefined ? { uid: admission.uid } : {}),
	};
}

/**
 * A read target is the admission `send()` resolved with, or the bare
 * submission id. The bare form synthesizes an origin-offset admission against
 * the client's own conversation URL — the re-attach path for a caller that
 * persisted only the id.
 */
function normalizeReadTarget(http: HttpClient, target: AgentSendResult | string): ReadTarget {
	if (typeof target === 'string') {
		if (target.trim() === '') {
			throw new Error('The client read() requires a non-empty submission id.');
		}
		return { streamUrl: http.url(''), offset: '-1', submissionId: target };
	}
	if (
		typeof target !== 'object' ||
		target === null ||
		typeof target.submissionId !== 'string' ||
		target.submissionId === ''
	) {
		throw new Error('The client read() takes a send() admission or a submission id string.');
	}
	// An admission belongs to one conversation. Waiting on the admission's
	// stream but reading the reply from this client's conversation would
	// silently return a message from the wrong conversation — compare by
	// pathname, since service-binding setups never dial the URL's host.
	const admissionPath = pathnameOf(target.streamUrl);
	if (admissionPath !== undefined && admissionPath !== pathnameOf(http.url(''))) {
		throw new Error(
			'The client read() was given an admission from a different conversation ' +
				`("${admissionPath}" vs this client's "${pathnameOf(http.url(''))}"). ` +
				'Use a client constructed for that conversation URL.',
		);
	}
	return target;
}

function pathnameOf(url: string): string | undefined {
	try {
		return new URL(url).pathname;
	} catch {
		return undefined;
	}
}
