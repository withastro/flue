import type { ToolDefinition, ToolInputSchema } from '@flue/runtime';
import { useInstruction, usePersistentState } from '@flue/runtime';
import * as v from 'valibot';

/**
 * A tiny phase machine built entirely from public hooks — proof that authors
 * can layer their own conventions on top of the custom-hooks model without
 * any framework support. There is nothing special here: `useMachine` just
 * calls `usePersistentState` and `useInstruction`.
 *
 * The machine is advisory, not structural: every phase hook stays mounted
 * for the agent's whole life (see `agents/support.ts` — hook calls are
 * never conditional). `check(phase)` and `enter(phase)` give phase-guarded
 * tools a deterministic legality check and a way to announce a move through
 * the transition tool's own result, without ever reshaping the render.
 */
export function useMachine<P extends string>(options: {
	name: string;
	phases: readonly P[];
	initial: P;
}) {
	const [phase, setPhase] = usePersistentState<P>(options.name, options.initial);
	// The core hook is untyped at runtime; a composed hook layers its own
	// guarantee — a persisted phase from before a rename fails loudly here.
	v.assert(v.picklist(options.phases), phase);
	useInstruction(
		`You operate a phased workflow: ${options.phases.join(' → ')}. Your current phase is ` +
			"announced by transition tool results. Trust your judgment about when a phase's work is done.",
	);
	return {
		phase,
		/** `null` means the calling tool is allowed; otherwise its refusal text. */
		check: (target: P) => (): string | null =>
			phase === target
				? null
				: `Refused: that tool belongs to the "${target}" phase; you are in "${phase}".`,
		/** Transition then announce the move — rides the transition tool's result. */
		enter: (target: P) => (): string => {
			setPhase(target);
			return `You are now in the "${target}" phase.`;
		},
	};
}

/**
 * Wrap a tool so it refuses — via the guard's message — instead of running
 * when `check()` fails. Pairs with `useMachine(...).check(phase)`: the tool
 * stays mounted for the agent's whole life, so guarding, not mounting, is
 * what makes it phase-scoped.
 */
export function guarded<TInput extends ToolInputSchema | undefined>(
	check: () => string | null,
	tool: ToolDefinition<TInput, undefined>,
): ToolDefinition<TInput, undefined> {
	return {
		...tool,
		run: (context) => check() ?? tool.run(context),
	};
}
