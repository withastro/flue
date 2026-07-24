import type { AgentFinishContext } from '../message-output.ts';
import { requireRenderFrame } from './frame.ts';

/**
 * Run a callback when the agent would otherwise finish responding — the model
 * has no more tool calls and the response is about to settle. The enforcement
 * seam: inspect what the response actually did (`ctx.response.toolCalls`
 * spans every turn, durably, across re-attempts) and, if the work is not
 * done, `ctx.append` a signal to send the model back to work within the same
 * response.
 *
 * ```ts
 * function Assistant() {
 *   useTool(postMessage(data));
 *
 *   useAgentFinish(({ response, append }) => {
 *     const posted = response.toolCalls.some(
 *       (call) => call.tool === 'post_message' && !call.isError,
 *     );
 *     if (posted) return; // nothing appended → the response settles
 *     append({
 *       kind: 'signal',
 *       type: 'reminder',
 *       body: 'You ended without calling post_message — nothing reached the user. Call it now with your answer.',
 *     });
 *   });
 * }
 * ```
 *
 * Semantics:
 * - A control seam, not a passive event tap: the callback is awaited before
 *   the response settles. `ctx.append` steers a signal into the same
 *   response — another turn runs, and once that continuation is dealt with
 *   the hook runs again at the next would-stop point. It is legal only
 *   during the callback's execution window (a captured reference throws
 *   after the callback settles) and takes the same signal form dispatch
 *   messages use. The response settles only when a cycle completes with no
 *   appends AND no delivered input is waiting: queued deliveries join the
 *   live response before any finish evaluation, so several messages collect
 *   into several `useAgentStart()` runs and ONE final `useAgentFinish()`.
 * - Append vs dispatch: an append is the response steering itself — no
 *   `useAgentStart` run, no submission of its own, counted against the
 *   continuation ceiling. A `useDispatchMessage()` dispatch made from this
 *   callback is a real delivery — it joins the same response and the hook
 *   fires again at the new true end (its own `useAgentStart` run; never
 *   counted against the ceiling).
 * - Runs on delivered submissions only, in declaration order, sequentially;
 *   multiple hooks share each cycle, and the response continues if any of
 *   them appended. A throw fails the submission.
 * - Durable: a continued cycle is a response-control checkpoint, recorded
 *   batch-atomically with its signals — a resumed response drives a
 *   checkpoint's pending continuation turn instead of re-evaluating, so it
 *   never re-runs a completed cycle or appends twice, and the continuation
 *   count survives restarts. An evaluation interrupted BEFORE its checkpoint
 *   leaves nothing durable and re-runs wholesale (every callback,
 *   at-least-once) on the re-attempt — durable effects never duplicate, but
 *   a callback's external side effects may rarely happen twice. Runaway
 *   protection is a fixed framework ceiling; the submission's durability
 *   timeout remains the total wall-clock backstop — neither continuations
 *   nor joins extend it.
 * - No durable identity — declare hooks conditionally, reorder them, add or
 *   remove them across deploys; each would-stop evaluation runs whatever the
 *   current render declares.
 */
export function useAgentFinish(run: (ctx: AgentFinishContext) => void | Promise<void>): void {
	const frame = requireRenderFrame('useAgentFinish');
	if (frame.kind === 'subagent') {
		throw new Error(
			"[flue] useAgentFinish() is not available in a subagent render. Lifecycle hooks run against the root agent's durable record log; a delegate's contract is its task result — validate it in the parent.",
		);
	}
	if (typeof run !== 'function') {
		throw new Error('[flue] useAgentFinish(run) takes a callback as its only argument.');
	}
	frame.agentFinishes.push({ run });
}
