import { requireRenderFrame } from './frame.ts';

/**
 * Read the instance's creation data — the `data` a caller sent with this
 * instance's first contact, recorded exactly once at creation and constant
 * for the instance's whole life.
 *
 * This is the third leg of the input model: `useInitialData()` is what the
 * instance is *about*, `useDelivery()` is what *this message* says, and
 * `usePersistentState` is what the agent has *learned*. Parse per-instance facts from
 * creation data, never from later deliveries — only the first message is
 * shaped by the code that creates the instance.
 *
 * ```ts
 * // dispatch(Triage, { id: 'issue-17307', initialData: { issue: 17307 }, message: {...} })
 * export function Triage() {
 *   const data = useInitialData<v.InferOutput<typeof Triage.initialData>>();
 *   return `Triage GitHub issue #${data.issue} end-to-end.`;
 * }
 * Triage.initialData = v.object({ issue: v.pipe(v.number(), v.integer()) });
 * ```
 *
 * Semantics:
 * - Assign an `initialData` schema static on the agent function to validate
 *   the data at instance creation — a mismatch (including absence, unless
 *   the schema accepts `undefined`) fails the creating submission, so with a
 *   required schema the value is always present here. The schema-parsed
 *   output is what this hook returns. Without a schema, whatever the creator
 *   sent is recorded and returned untyped; the type parameter is
 *   compile-time only.
 * - Constant forever: `data` on messages to an existing instance is ignored,
 *   and nothing can change the recorded value. Evolving facts belong in
 *   `usePersistentState`.
 * - The return type is exactly the type parameter you assert — with a
 *   required `initialData` schema the value is always present, so the common
 *   case needs no `undefined` narrowing (and no `!`). At runtime the value
 *   IS `undefined` when creation carried no data, on a bare tooling/test
 *   render (back it with `initialData` in the render-state context), and
 *   in subagent renders (a delegate has no creation data of its own; close
 *   over a value to share it explicitly) — when your agent can hit those
 *   cases, say so in the type: `useInitialData<Config | undefined>()`.
 * - The recorded value is part of the instance's durable record stream; it
 *   is not a secrets channel — keys and tokens stay in the environment.
 */
export function useInitialData<T = unknown>(): T {
	const frame = requireRenderFrame('useInitialData');
	if (frame.kind === 'subagent') return undefined as T;
	return frame.state?.initialData as T;
}
