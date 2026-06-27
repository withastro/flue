import {
	ToolInputValidationError,
	ToolLegacyDefinitionError,
	ToolOutputSerializationError,
	ToolOutputValidationError,
} from './errors.ts';
import { cloneJsonSerializable } from './json-snapshot.ts';
import { isTopLevelObjectSchema, isValibotSchema, parseValibot } from './schema.ts';
import type {
	ToolDefinition,
	ToolInputSchema,
	ToolOutput,
	ToolOutputSchema,
} from './tool-types.ts';

export function defineTool<
	const TInput extends ToolInputSchema | undefined = undefined,
	const TOutput extends ToolOutputSchema | undefined = undefined,
>(options: {
	name: string;
	description: string;
	input?: TInput;
	output?: TOutput;
	run: ToolDefinition<TInput, TOutput>['run'];
}): ToolDefinition<TInput, TOutput> {
	assertToolDefinition(options, 'defineTool()');
	return Object.freeze({
		name: options.name,
		description: options.description,
		input: options.input as TInput,
		output: options.output as TOutput,
		run: options.run,
	});
}

export function assertToolDefinition(
	value: unknown,
	label: string,
): asserts value is ToolDefinition {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error(`[flue] ${label} requires a tool definition object.`);
	}
	const legacyFields = ['parameters', 'execute'].filter((field) => Object.hasOwn(value, field));
	if (legacyFields.length > 0) throw new ToolLegacyDefinitionError({ fields: legacyFields });
	const tool = value as Partial<ToolDefinition>;
	assertNonEmptyString(tool.name, `${label} name`);
	assertNonEmptyString(tool.description, `${label} description`);
	if (tool.input !== undefined) {
		if (!isValibotSchema(tool.input)) {
			throw new Error(`[flue] ${label} input must be a Valibot schema.`);
		}
		if (!isTopLevelObjectSchema(tool.input)) {
			throw new Error(`[flue] ${label} input must be a top-level object schema.`);
		}
	}
	if (tool.output !== undefined && !isValibotSchema(tool.output)) {
		throw new Error(`[flue] ${label} output must be a Valibot schema.`);
	}
	if (typeof tool.run !== 'function') {
		throw new Error(`[flue] ${label} run must be a function.`);
	}
}

export function parseToolInput<TTool extends ToolDefinition>(
	tool: TTool,
	input?: unknown,
	signal?: AbortSignal,
): { context: Parameters<TTool['run']>[0]; input: unknown } {
	if (!tool.input)
		return { context: { signal } as Parameters<TTool['run']>[0], input: undefined };
	const parsedInput = parseValibot(tool.input, input === undefined ? {} : input);
	if (!parsedInput.success) {
		throw new ToolInputValidationError({ tool: tool.name, issues: parsedInput.issues });
	}
	return {
		context: { input: parsedInput.output, signal } as Parameters<TTool['run']>[0],
		input: parsedInput.output,
	};
}

export function validateToolOutput<TTool extends ToolDefinition>(
	tool: TTool,
	result: unknown,
): ToolOutput<TTool> {
	let output: unknown = result;
	if (tool.output) {
		const parsedOutput = parseValibot(tool.output, result);
		if (!parsedOutput.success) {
			throw new ToolOutputValidationError({ tool: tool.name, issues: parsedOutput.issues });
		}
		output = parsedOutput.output;
	}
	if (output === undefined && !tool.output) return undefined as ToolOutput<TTool>;
	if (output === undefined) throw new ToolOutputSerializationError({ tool: tool.name });
	try {
		return cloneJsonSerializable(output, `Tool "${tool.name}" output`) as ToolOutput<TTool>;
	} catch (cause) {
		throw new ToolOutputSerializationError({ tool: tool.name, cause });
	}
}

export async function validateAndRunTool<TTool extends ToolDefinition>(
	tool: TTool,
	input?: unknown,
	signal?: AbortSignal,
): Promise<ToolOutput<TTool>> {
	const parsed = parseToolInput(tool, input, signal);
	return validateToolOutput(tool, await tool.run(parsed.context));
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
	if (typeof value !== 'string' || value.trim().length === 0) {
		throw new Error(`[flue] ${label} must be a non-empty string.`);
	}
}
