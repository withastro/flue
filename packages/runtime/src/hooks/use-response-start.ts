import type { ResponseMetadataCallback, ResponseStartContext } from '../message-output.ts';
import { requireRenderFrame } from './frame.ts';

/**
 * Observe the response's true start — once per response, synchronously,
 * before the first model call and before any `useAgentStart` hook. Return an
 * object to deep-merge onto the response message's metadata (AI SDK
 * convention: the message's `metadata` field, envelope facts clients read
 * outside the content flow). Return nothing to observe without attaching.
 *
 * ```ts
 * function useResponseTimestamps() {
 *   useResponseStart(({ metadata }) => ({ ...metadata, startedAt: Date.now() }));
 *   useResponseFinish(({ metadata }) => ({
 *     finishedAt: Date.now(),
 *     elapsed: Date.now() - (metadata.startedAt as number),
 *   }));
 * }
 * ```
 *
 * Semantics:
 * - Once per response: deliveries that JOIN a live response re-fire
 *   `useAgentStart`, but the response only wakes once — this hook does not
 *   re-fire. A resume re-entry whose response already has durable assistant
 *   steps skips it (it ran on the original attempt); a re-attempt from before
 *   the first durable step re-runs it (at-least-once).
 * - Synchronous observer: callbacks cannot steer (no append, no dispatch, no
 *   harness) and must not be async — a returned promise fails the submission.
 *   Async work at the start seam belongs in `useAgentStart`.
 * - `ctx.metadata` is the metadata accumulated so far this response (earlier
 *   hooks' contributions, in declaration order), handed in at call time —
 *   never a stale render capture. Returns compose by deep-merge; later keys
 *   win, `undefined` values are skipped.
 * - Fail-fast: a throw fails the submission — no retry, no recovery.
 * - No durable identity — declare hooks conditionally, reorder them, add or
 *   remove them across deploys; the wake runs whatever the render declares.
 * - Output is model-invisible and non-reactive: metadata never reaches the
 *   prompt and never re-runs the agent.
 */
export function useResponseStart(run: ResponseMetadataCallback<ResponseStartContext>): void {
	const frame = requireRenderFrame('useResponseStart');
	if (frame.kind === 'subagent') {
		throw new Error(
			"[flue] useResponseStart() is not available in a subagent render. Response metadata decorates the agent's public conversation; delegates run detached tasks with no client-facing output.",
		);
	}
	if (typeof run !== 'function') {
		throw new Error('[flue] useResponseStart(run) takes a callback as its only argument.');
	}
	frame.responseStarts.push({ run });
}
