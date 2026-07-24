import type { DeliveredMessage } from '../types.ts';
import { requireRenderFrame } from './frame.ts';

/**
 * Read the message currently in front of the model — the latest input the
 * response has received, as the same validated `DeliveredMessage` shape a
 * `dispatch()` call or a direct HTTP prompt admits. The value is a CURSOR:
 * it starts as the delivery that woke the response and advances whenever a
 * new message reaches the model — a delivery joining the live response at a
 * turn boundary, or a signal appended by a lifecycle callback. The hook
 * gives *code* the same access the model has, so tools no longer depend on
 * the model echoing values back into their input.
 *
 * ```ts
 * // dispatch(triage, { id: `issue-${n}`, message: { kind: 'signal',
 * //   type: 'issue.triage', body: '...', attributes: { issue: String(n) } } })
 * export default function IssueTriage() {
 *   const delivery = useDelivery();
 *   const issue =
 *     delivery.kind === 'signal' ? Number(delivery.attributes?.issue) : undefined;
 *
 *   useTool({
 *     name: 'load_issue',
 *     description: 'Fetch the GitHub issue named by the dispatch. Call this first.',
 *     run: async () => loadIssueDigest(issue),
 *   });
 * }
 * ```
 *
 * Semantics:
 * - Transport- and origin-agnostic: a direct API call, a `dispatch()` call,
 *   and a lifecycle callback's `append` all produce the same shapes here —
 *   a signal is a signal, whatever put it in front of the model.
 * - Framework narration signals (`resources`/`instructions`/`environment`
 *   bookkeeping about the agent's own declared surface) do not advance the
 *   cursor — it stays on the input the response is answering.
 * - Constant within one render; fresh at the next. Renders happen before
 *   every model call — each turn, and the moment a delivery joins the live
 *   response (so a `useAgentStart` closure firing for a joined message
 *   reads THAT message). When several messages collect into one response,
 *   the cursor walks them in the order the model read them.
 * - Crash-safe: a resumed attempt derives the same cursor from the durable
 *   record stream that the live attempt saw.
 * - In a subagent render, the delivery is the parent's task prompt as a
 *   `kind: 'user'` message (task images ride as `attachments`) — a delegate
 *   reads its triggering input exactly like a root agent reads its dispatch.
 * - Always present: every response starts from a delivered message, so the
 *   return is non-optional. A render with no delivery behind it (a bare
 *   tooling/test render outside the runtime) throws — supply one through
 *   the render-state context there.
 */
export function useDelivery(): DeliveredMessage {
	const frame = requireRenderFrame('useDelivery');
	const delivery = frame.state?.delivery;
	if (!delivery) {
		throw new Error(
			'[flue] useDelivery() found no delivered message behind this render. Every agent run in the runtime is triggered by one; a direct render outside the runtime (tests, tooling) must supply a `delivery` in its render-state context.',
		);
	}
	return delivery;
}
