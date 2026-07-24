import { enqueueDispatch } from '../runtime/dispatch.ts';
import { getFlueRuntime } from '../runtime/flue-app.ts';
import { normalizeMessageInput } from '../runtime/message-input.ts';
import type { DeliveredMessageInput, DispatchReceipt } from '../types.ts';
import { isRendering, requireRenderFrame } from './frame.ts';

/**
 * Get a dispatcher bound to this agent instance — the agent-scoped form of
 * the global `dispatch()`, the way a router hook overloads a browser
 * primitive with the router-scoped version. The returned function takes just
 * the message: the instance already exists, so there is no creation `data`
 * (that is initial data) and no `uid` condition to pass.
 *
 * ```ts
 * export default function IssueTriage() {
 *   const dispatch = useDispatchMessage();
 *
 *   useTool({
 *     name: 'run_intake',
 *     description: 'Load the issue and decide whether triage is warranted.',
 *     harness: true,
 *     run: async ({ harness }) => {
 *       const issue = await loadIssue(harness);
 *       await dispatch({
 *         kind: 'signal',
 *         type: 'intake',
 *         body: `Issue #${issue.number} loaded; triage warranted.`,
 *         attributes: { issue: String(issue.number) },
 *       });
 *       return 'Intake complete.';
 *     },
 *   });
 * }
 * ```
 *
 * Semantics — identical to the global `dispatch()` by construction (same
 * queue, same admission, same delivery), and identical for direct HTTP
 * prompts to the instance (one accepted order, one join behavior):
 * - A dispatch to a BUSY instance joins the live response at the next turn
 *   boundary: durably admitted, its own `useAgentStart` run, read by the
 *   model on its very next turn — without interrupting the turn in flight.
 *   A dispatch to an IDLE instance wakes a new response; messages piled up
 *   before turn one collect into it together. A delivery that misses the
 *   live response (it settled first, or a crash interrupted the join) runs
 *   as its own submission from the same durable queue — never lost.
 * - A joined delivery settles when the response that carried it settles,
 *   with the same outcome, under the host response's durability budget.
 * - Both message kinds work: a `signal` annotates the conversation; a `user`
 *   message reads as a real user message (a bare string is shorthand for
 *   `{ kind: 'user', body }`, as everywhere `dispatch` appears).
 * - Each call is a durable delivery with its own receipt. Like any
 *   external side effect in a re-attempted tool, a re-run dispatches again —
 *   design for at-least-once.
 * - The dispatcher throws during render (renders are pure reads) and on bare
 *   tooling/test renders with no runtime behind them.
 */
export function useDispatchMessage(): (message: DeliveredMessageInput) => Promise<DispatchReceipt> {
	const frame = requireRenderFrame('useDispatchMessage');
	if (frame.kind === 'subagent') {
		throw new Error(
			'[flue] useDispatchMessage() is not available in a subagent render. A delegate has no instance of its own to dispatch to — return what it produced as its task result instead.',
		);
	}
	const agentName = frame.state?.agentName;
	const instanceId = frame.state?.instanceId;
	return async (message: DeliveredMessageInput): Promise<DispatchReceipt> => {
		if (isRendering()) {
			throw new Error(
				'[flue] The useDispatchMessage() dispatcher was called during render. Renders are pure reads — dispatch from tool run functions, effects, and other callbacks.',
			);
		}
		if (agentName === undefined || instanceId === undefined) {
			throw new Error(
				'[flue] The useDispatchMessage() dispatcher has no durable runtime behind this render, so self-dispatch is unavailable.',
			);
		}
		const rt = getFlueRuntime();
		if (!rt) {
			throw new Error(
				'[flue] The useDispatchMessage() dispatcher was called before the Flue runtime was configured. This usually means the agent is running outside a Flue-built server entry.',
			);
		}
		return enqueueDispatch({
			request: { agent: agentName, id: instanceId, message: normalizeMessageInput(message) },
			dispatchQueue: rt.dispatchQueue,
		});
	};
}
