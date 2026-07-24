import type { ResponseFinishContext, ResponseMetadataCallback } from '../message-output.ts';
import { requireRenderFrame } from './frame.ts';

/**
 * Observe the response's true end — once per response, synchronously, after
 * the last `useAgentFinish` cycle settles and every queued output write has
 * flushed. Return an object to deep-merge onto the response message's
 * metadata (AI SDK convention: the message's `metadata` field). Return
 * nothing to observe without attaching.
 *
 * ```ts
 * function useRunStats() {
 *   useResponseStart(() => ({ startedAt: Date.now() }));
 *   useResponseFinish(({ metadata, response }) => ({
 *     finishedAt: Date.now(),
 *     elapsed: Date.now() - (metadata.startedAt as number),
 *     totalTokens: response.usage.totalTokens,
 *     toolCalls: response.toolCalls.length,
 *   }));
 * }
 * ```
 *
 * Semantics:
 * - Once per response, at the true end: `useAgentFinish` runs at every
 *   would-stop (and may continue the response); this hook runs after the
 *   final cycle, when the response is actually settling. Its `response`
 *   aggregates are final.
 * - Synchronous observer: callbacks cannot steer (no append, no dispatch, no
 *   harness) and must not be async — a returned promise fails the submission.
 *   Async work at the finish seam belongs in `useAgentFinish`.
 * - `ctx.metadata` is the response's accumulated metadata — what
 *   `useResponseStart` hooks attached (read from the durable record log, so
 *   it survives re-attempts) plus earlier finish hooks' contributions.
 *   Returns compose by deep-merge; later keys win.
 * - Fail-fast: a throw fails the submission — no retry, no recovery.
 * - No durable identity — declare hooks conditionally, reorder them, add or
 *   remove them across deploys; the settle runs whatever the render declares.
 * - Output is model-invisible and non-reactive: metadata never reaches the
 *   prompt and never re-runs the agent.
 */
export function useResponseFinish(run: ResponseMetadataCallback<ResponseFinishContext>): void {
	const frame = requireRenderFrame('useResponseFinish');
	if (frame.kind === 'subagent') {
		throw new Error(
			"[flue] useResponseFinish() is not available in a subagent render. Response metadata decorates the agent's public conversation; delegates run detached tasks with no client-facing output.",
		);
	}
	if (typeof run !== 'function') {
		throw new Error('[flue] useResponseFinish(run) takes a callback as its only argument.');
	}
	frame.responseFinishes.push({ run });
}
