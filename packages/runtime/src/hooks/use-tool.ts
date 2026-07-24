import { assertToolDefinition } from '../tool.ts';
import type { ToolDefinition, ToolInputSchema, ToolOutputSchema } from '../tool-types.ts';
import { requireRenderFrame } from './frame.ts';

/**
 * Mount a model-callable tool for the current render.
 *
 * Accepts a `defineTool(...)` value or an inline definition object (same
 * validation, applied here; `run`'s `data` is typed from the `input` schema).
 * Called directly in the agent body or inside a custom hook — either way the
 * tool joins the render's single flat tool set:
 *
 * ```ts
 * function useRetention() {
 *   useTool(offerCredit);
 *   useInstruction('You may offer retention incentives.');
 * }
 * ```
 *
 * Duplicate active tool names across the whole render fail fast.
 */
export function useTool<
	const TInput extends ToolInputSchema | undefined = undefined,
	const TOutput extends ToolOutputSchema | undefined = undefined,
	const THarness extends boolean = false,
	const TDurable extends boolean = false,
>(tool: {
	name: string;
	description: string;
	input?: TInput;
	output?: TOutput;
	/**
	 * Connect this tool to the agent's runtime: `run` receives `harness` —
	 * the one interface to the agent's environment (`harness.sandbox`) and
	 * to models (`harness.prompt()`). Tools without it are pure functions of
	 * their data.
	 */
	harness?: THarness;
	/**
	 * Declare this tool durable: `run` receives `step`, every side effect
	 * goes through `step.do(...)`, and an interrupted call is re-executed on
	 * recovery with completed steps replaying their recorded values.
	 */
	durable?: TDurable;
	run: ToolDefinition<TInput, TOutput, THarness, TDurable>['run'];
}): void {
	const frame = requireRenderFrame('useTool');
	assertToolDefinition(tool, 'useTool()');
	frame.tools.push(tool as unknown as ToolDefinition);
}
