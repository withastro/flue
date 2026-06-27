import type * as v from 'valibot';
import {
	ActionInputValidationError,
	ActionOutputSerializationError,
	ActionOutputValidationError,
	WorkflowInputUnexpectedError,
} from './errors.ts';
import { isTopLevelObjectSchema, isValibotSchema, parseValibot } from './schema.ts';
import { cloneJsonSerializable, type JsonValue } from './json-snapshot.ts';
import type { FlueHarness, FlueLogger } from './types.ts';

export type { JsonValue } from './json-snapshot.ts';

const definedActions = new WeakSet<object>();
export type ActionInputSchema = v.GenericSchema<Record<string, unknown>, unknown>;
export type ActionOutputSchema = v.GenericSchema<any, NonNullable<unknown> | null>;

export type ActionContext<S extends ActionInputSchema | undefined> = {
	readonly harness: FlueHarness;
	readonly log: FlueLogger;
} & (S extends ActionInputSchema
	? { readonly input: v.InferOutput<S> }
	: Record<never, never>);

type ActionRunResult<S extends ActionOutputSchema | undefined> = S extends ActionOutputSchema
	? v.InferInput<S>
	: JsonValue | undefined;

export interface ActionDefinition<
	TInput extends ActionInputSchema | undefined = ActionInputSchema | undefined,
	TOutput extends ActionOutputSchema | undefined = ActionOutputSchema | undefined,
> {
	readonly __flueAction: true;
	readonly name: string;
	readonly description: string;
	readonly input: TInput;
	readonly output: TOutput;
	run(context: ActionContext<TInput>): ActionRunResult<TOutput> | Promise<ActionRunResult<TOutput>>;
}

export type ActionInput<TAction extends ActionDefinition> = TAction extends ActionDefinition<
	infer TInput,
	any
>
	? TInput extends ActionInputSchema
		? v.InferInput<TInput>
		: never
	: never;

export type ActionOutput<TAction extends ActionDefinition> = TAction extends ActionDefinition<
	any,
	infer TOutput
>
	? TOutput extends ActionOutputSchema
		? v.InferOutput<TOutput>
		: unknown
	: never;

type ActionOptions<
	TInput extends ActionInputSchema | undefined,
	TOutput extends ActionOutputSchema | undefined,
> = {
	name: string;
	description: string;
	input?: TInput;
	output?: TOutput;
	run(context: ActionContext<TInput>): ActionRunResult<TOutput> | Promise<ActionRunResult<TOutput>>;
};

export function defineAction<
	const TInput extends ActionInputSchema | undefined = undefined,
	const TOutput extends ActionOutputSchema | undefined = undefined,
>(options: ActionOptions<TInput, TOutput>): ActionDefinition<TInput, TOutput> {
	if (!options || typeof options !== 'object') {
		throw new Error('[flue] defineAction() requires an action definition object.');
	}
	assertNonEmptyString(options.name, 'defineAction({ name })');
	assertNonEmptyString(options.description, 'defineAction({ description })');
	if (options.input !== undefined) {
		if (!isValibotSchema(options.input)) {
			throw new Error('[flue] defineAction({ input }) must be a Valibot schema.');
		}
		if (!isTopLevelObjectSchema(options.input)) {
			throw new Error('[flue] defineAction({ input }) must be a top-level object schema.');
		}
	}
	if (options.output !== undefined && !isValibotSchema(options.output)) {
		throw new Error('[flue] defineAction({ output }) must be a Valibot schema.');
	}
	if (typeof options.run !== 'function') {
		throw new Error('[flue] defineAction({ run }) must be a function.');
	}
	const action = Object.freeze({
		__flueAction: true as const,
		name: options.name,
		description: options.description,
		input: options.input as TInput,
		output: options.output as TOutput,
		run: options.run,
	});
	definedActions.add(action);
	return action;
}

export function isActionDefinition(value: unknown): value is ActionDefinition {
	return Boolean(value && typeof value === 'object' && definedActions.has(value));
}

export interface ParsedActionInput {
	readonly declared: boolean;
	readonly value: unknown;
}

export function parseActionInput(action: ActionDefinition, input?: unknown): ParsedActionInput {
	if (!action.input) {
		if (input !== undefined) throw new WorkflowInputUnexpectedError();
		return { declared: false, value: undefined };
	}
	const parsed = parseValibot(action.input, input === undefined ? {} : input);
	if (!parsed.success) {
		throw new ActionInputValidationError({ action: action.name, issues: parsed.issues });
	}
	return { declared: true, value: parsed.output };
}

export async function runActionWithParsedInput<TAction extends ActionDefinition>(
	action: TAction,
	context: { harness: FlueHarness; log: FlueLogger },
	input: ParsedActionInput,
): Promise<ActionOutput<TAction>> {
	const runContext = input.declared ? { ...context, input: input.value } : context;
	const result = await action.run(runContext as never);
	let output: unknown = result;
	if (action.output) {
		const parsed = parseValibot(action.output, result);
		if (!parsed.success)
			throw new ActionOutputValidationError({ action: action.name, issues: parsed.issues });
		output = parsed.output;
	}
	if (output === undefined && !action.output) return undefined as ActionOutput<TAction>;
	if (output === undefined) throw new ActionOutputSerializationError({ action: action.name });
	try {
		return cloneJsonSerializable(output, `Action "${action.name}" output`) as ActionOutput<TAction>;
	} catch (cause) {
		throw new ActionOutputSerializationError({ action: action.name, cause });
	}
}

export async function validateAndRunAction<TAction extends ActionDefinition>(
	action: TAction,
	context: { harness: FlueHarness; log: FlueLogger },
	input?: unknown,
): Promise<ActionOutput<TAction>> {
	return runActionWithParsedInput(action, context, parseActionInput(action, input));
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
	if (typeof value !== 'string' || value.trim().length === 0) {
		throw new Error(`[flue] ${label} must be a non-empty string.`);
	}
}
