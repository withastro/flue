import type * as v from 'valibot';
import type { JsonValue } from './json-snapshot.ts';

export type ToolInputSchema = v.GenericSchema<Record<string, unknown>, unknown>;
export type ToolOutputSchema = v.GenericSchema<any, NonNullable<unknown> | null>;

export type ToolContext<S extends ToolInputSchema | undefined> = {
	readonly signal?: AbortSignal;
} & (S extends ToolInputSchema
	? { readonly input: v.InferOutput<S> }
	: Record<never, never>);

type ToolRunResult<S extends ToolOutputSchema | undefined> = S extends ToolOutputSchema
	? v.InferInput<S>
	: JsonValue | undefined;

export interface ToolDefinition<
	TInput extends ToolInputSchema | undefined = ToolInputSchema | undefined,
	TOutput extends ToolOutputSchema | undefined = ToolOutputSchema | undefined,
> {
	readonly name: string;
	readonly description: string;
	readonly input: TInput;
	readonly output: TOutput;
	run(context: ToolContext<TInput>): ToolRunResult<TOutput> | Promise<ToolRunResult<TOutput>>;
}

export type ToolInput<TTool extends ToolDefinition> = TTool extends ToolDefinition<
	infer TInput,
	any
>
	? TInput extends ToolInputSchema
		? v.InferInput<TInput>
		: never
	: never;

export type ToolOutput<TTool extends ToolDefinition> = TTool extends ToolDefinition<
	any,
	infer TOutput
>
	? TOutput extends ToolOutputSchema
		? v.InferOutput<TOutput>
		: unknown
	: never;
