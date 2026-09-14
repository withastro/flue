import type * as v from 'valibot';
import type { FlueHarness, FlueLogger } from './types.ts';

export type ToolInputSchema = v.GenericSchema<Record<string, unknown>, unknown>;
export type ToolOutputSchema = v.GenericSchema<any, NonNullable<unknown> | null>;

/**
 * The durable-step surface a `durable: true` tool's `run` receives. Each
 * completed step is recorded as a canonical conversation record; when the
 * runtime re-executes the tool call after an interruption, completed steps
 * return their recorded value without running again.
 */
export interface ToolStep {
	/**
	 * Run `fn` once per `name` for this tool call. The returned value is
	 * durably recorded before `do` resolves; a re-execution of the same tool
	 * call returns the recorded value without invoking `fn`. Values must be
	 * JSON-serializable and should stay small — store large artifacts in the
	 * sandbox and record a pointer. Names identify the logical work: derive
	 * them deterministically (`upsert:${id}`), and reusing a name within one
	 * call throws.
	 *
	 * `do` is exactly-once-recorded, at-least-once-executed: a crash between
	 * `fn` completing and the record landing re-executes `fn` on recovery.
	 */
	do<T>(name: string, fn: () => T | Promise<T>): Promise<T>;
}

/**
 * The context passed to a tool's `run`. Every tool gets `toolCallId` (the
 * id of the call being executed), `log` (streamed into the conversation as
 * progress events), and the tool call's `signal`. Flags on the definition
 * extend it: an `input` schema adds `data` — the call's arguments, parsed
 * by that schema; `harness: true` adds `harness` — the agent's runtime
 * surface (sandbox `shell`/`fs`, sessions, model calls); `durable: true`
 * adds `step` — the durable-step surface. Tools without `harness` are pure
 * functions of their data.
 */
export type ToolContext<
	S extends ToolInputSchema | undefined,
	H extends boolean | undefined = undefined,
	D extends boolean | undefined = undefined,
> = {
	/**
	 * The id of the tool call being executed — the same `toolCallId` carried
	 * by this call's emitted events (`tool_start`, `tool`) and its tool-result
	 * message, so a tool can key durable side effects on the call that raised
	 * them and observers can correlate by id. In a standalone run with no
	 * model turn behind it (evals, direct execution), the id is synthesized.
	 */
	readonly toolCallId: string;
	readonly signal?: AbortSignal;
	/**
	 * Progress logging for long-running tools. Lines are emitted into the
	 * conversation stream as `log` events attributed to this tool call — they
	 * are not part of the tool result and the model never sees them.
	 */
	readonly log: FlueLogger;
} & (S extends ToolInputSchema ? { readonly data: v.InferOutput<S> } : Record<never, never>) &
	// Non-distributive on purpose: for the default `boolean | undefined` the
	// harness property is absent, so generic ToolDefinition consumers see the
	// base context.
	([H] extends [true] ? { readonly harness: FlueHarness } : Record<never, never>) &
	([D] extends [true] ? { readonly step: ToolStep } : Record<never, never>);

/**
 * The canonical `run` return shape: `output` is the tool's result value
 * (validated against the declared `output` schema, and what the model sees
 * serialized as JSON), and `terminate: true` ends the agent's turn after the
 * current tool batch settles — the same loop-ending contract the built-in
 * `finish`/`give_up` tools use, honored across crash recovery. `output` is
 * required when an `output` schema is declared (forgetting the value is a bug
 * the type should catch) and optional otherwise.
 */
/**
 * `JsonValue` widened to admit `undefined` object properties. When a tool body
 * returns different object shapes from different branches, TypeScript unions
 * them by adding `?: undefined` for the missing keys, which the strict
 * `JsonValue` index signature rejects with a misleading overload error.
 * `undefined` properties are dropped by JSON serialization, so admitting them
 * here changes nothing at runtime.
 */
export type JsonOutput =
	null | boolean | number | string | JsonOutput[] | { [key: string]: JsonOutput | undefined };

export type ToolRunEnvelope<S extends ToolOutputSchema | undefined> = S extends ToolOutputSchema
	? { output: v.InferInput<S>; terminate?: boolean }
	: { output?: JsonOutput; terminate?: boolean };

// Bare-string sugar: `return 'text'` means `return { output: 'text' }`. The
// string arm exists only where a string is a valid output to begin with (no
// `output` schema, or a string-input schema) — a non-string schema keeps
// rejecting the shorthand at the type level. The sugar rides the same
// distributive conditional as the envelope (rather than a standalone
// `[string] extends [ToolRunResult<S>]` union member) so TypeScript can still
// measure the type parameter's variance: a concrete ToolDefinition must stay
// assignable to the generic default.
type ToolRunReturn<S extends ToolOutputSchema | undefined> = S extends ToolOutputSchema
	? ToolRunEnvelope<S> | ([string] extends [v.InferInput<S>] ? string : never)
	: ToolRunEnvelope<S> | string;

export interface ToolDefinition<
	TInput extends ToolInputSchema | undefined = ToolInputSchema | undefined,
	TOutput extends ToolOutputSchema | undefined = ToolOutputSchema | undefined,
	THarness extends boolean | undefined = boolean | undefined,
	TDurable extends boolean | undefined = boolean | undefined,
> {
	readonly name: string;
	readonly description: string;
	readonly input: TInput;
	readonly output: TOutput;
	/**
	 * Connect this tool to the agent's runtime: `run` receives `harness`,
	 * the one interface to the agent's environment (`harness.sandbox`, the
	 * live Sandbox) and to models (`harness.prompt()`). Harness
	 * invocations are scoped to the tool call, count against the
	 * delegation-depth cap, and retain any child conversations they open.
	 * Harness tools only run inside an agent session — never standalone.
	 */
	readonly harness?: THarness;
	/**
	 * Declare this tool durable: `run` receives `step`, and every side effect
	 * in the run is expected to go through `step.do(...)`. In exchange, an
	 * interrupted call is re-executed on recovery — completed steps replay
	 * their recorded values instead of running again — rather than being
	 * settled with an unknown-outcome error like ordinary tools.
	 */
	readonly durable?: TDurable;
	// `| void` only for the no-`output`-schema case, where an undefined
	// output is already an allowed result — a bare `() => sideEffect()` with
	// no return statement is the same value at runtime, so nothing is lost by
	// accepting it. A declared output schema keeps requiring the real return:
	// forgetting it there is a bug the type should still catch.
	run(
		context: ToolContext<TInput, THarness, TDurable>,
	):
		| ToolRunReturn<TOutput>
		| Promise<ToolRunReturn<TOutput>>
		| (TOutput extends undefined ? void | Promise<void> : never);
}

export type ToolInput<TTool extends ToolDefinition> =
	TTool extends ToolDefinition<infer TInput, any, any>
		? TInput extends ToolInputSchema
			? v.InferInput<TInput>
			: never
		: never;

export type ToolOutput<TTool extends ToolDefinition> =
	TTool extends ToolDefinition<any, infer TOutput, any>
		? TOutput extends ToolOutputSchema
			? v.InferOutput<TOutput>
			: unknown
		: never;
