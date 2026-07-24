import {
	ToolInputValidationError,
	ToolOutputSerializationError,
	ToolOutputValidationError,
} from './errors.ts';
import { cloneJsonSerializable } from './json-snapshot.ts';
import { generateToolCallId } from './runtime/ids.ts';
import { isTopLevelObjectSchema, isValibotSchema, parseValibot } from './schema.ts';
import type {
	ToolContext,
	ToolDefinition,
	ToolInputSchema,
	ToolOutput,
	ToolOutputSchema,
	ToolStep,
} from './tool-types.ts';
import type { FlueHarness, FlueLogger } from './types.ts';

export function defineTool<
	const TInput extends ToolInputSchema | undefined = undefined,
	const TOutput extends ToolOutputSchema | undefined = undefined,
	const THarness extends boolean = false,
	const TDurable extends boolean = false,
>(options: {
	name: string;
	description: string;
	input?: TInput;
	output?: TOutput;
	harness?: THarness;
	durable?: TDurable;
	run: ToolDefinition<TInput, TOutput, THarness, TDurable>['run'];
}): ToolDefinition<TInput, TOutput, THarness, TDurable> {
	assertToolDefinition(options, 'defineTool()');
	return Object.freeze({
		name: options.name,
		description: options.description,
		input: options.input as TInput,
		output: options.output as TOutput,
		harness: options.harness as THarness,
		durable: options.durable as TDurable,
		run: options.run,
	});
}

const TOOL_DEFINITION_FIELDS = new Set([
	'name',
	'description',
	'input',
	'output',
	'harness',
	'durable',
	'run',
]);

export function assertToolDefinition(
	value: unknown,
	label: string,
): asserts value is ToolDefinition {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error(`[flue] ${label} requires a tool definition object.`);
	}
	// Reject unknown fields like the other authoring surfaces (useModel,
	// useSandbox) do: a `harnes: true` typo must not silently produce a pure
	// tool whose run crashes on ctx.harness at model-call time.
	for (const key of Object.keys(value)) {
		if (!TOOL_DEFINITION_FIELDS.has(key)) {
			throw new Error(
				`[flue] ${label} received unknown field "${key}". Tool definitions accept: ${[...TOOL_DEFINITION_FIELDS].join(', ')}.`,
			);
		}
	}
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
	if (tool.harness !== undefined && typeof tool.harness !== 'boolean') {
		throw new Error(`[flue] ${label} harness must be a boolean.`);
	}
	if (tool.durable !== undefined && typeof tool.durable !== 'boolean') {
		throw new Error(`[flue] ${label} durable must be a boolean.`);
	}
	if (typeof tool.run !== 'function') {
		throw new Error(`[flue] ${label} run must be a function.`);
	}
}

/** Runtime facilities the executing session injects into {@link ToolContext}. */
export interface ToolRunFacilities {
	log: FlueLogger;
	/** The model turn's tool-call id; synthesized when absent (standalone runs). */
	toolCallId?: string;
	/** Present only for `harness: true` tools, created per invocation. */
	harness?: FlueHarness;
	/** Present only for `durable: true` tools, created per invocation. */
	step?: ToolStep;
}

export function parseToolInput<TTool extends ToolDefinition>(
	tool: TTool,
	data?: unknown,
	signal?: AbortSignal,
	facilities?: ToolRunFacilities,
): { context: Parameters<TTool['run']>[0]; data: unknown } {
	const base: Record<string, unknown> = {
		signal,
		log: facilities?.log ?? NOOP_LOGGER,
		toolCallId: facilities?.toolCallId ?? generateToolCallId(),
		...(facilities?.harness ? { harness: facilities.harness } : {}),
		// A durable tool always sees `step`. Outside a session (standalone
		// runs, evals) nothing is durable to begin with, so the step executes
		// without recording — same semantics, no persistence.
		...(tool.durable ? { step: facilities?.step ?? createEphemeralToolStep(tool.name) } : {}),
	};
	if (!tool.input) return { context: base as Parameters<TTool['run']>[0], data: undefined };
	const parsed = parseValibot(tool.input, data === undefined ? {} : data);
	if (!parsed.success) {
		throw new ToolInputValidationError({ tool: tool.name, issues: parsed.issues });
	}
	return {
		context: { ...base, data: parsed.output } as Parameters<TTool['run']>[0],
		data: parsed.output,
	};
}

/** Standalone runs have no conversation stream to log into. */
const NOOP_LOGGER: FlueLogger = {
	info: () => {},
	warn: () => {},
	error: () => {},
};

/**
 * Guard one invocation's step names: non-empty, and never reused — a reused
 * name would silently alias two steps onto one memo, which only surfaces as
 * wrong values during recovery. Shared by the session's durable step and the
 * ephemeral one so the contract is identical everywhere.
 */
export function claimStepName(name: unknown, toolName: string, used: Set<string>): string {
	if (typeof name !== 'string' || name.trim().length === 0) {
		throw new Error(`[flue] Tool "${toolName}" step.do() requires a non-empty step name.`);
	}
	if (used.has(name)) {
		throw new Error(
			`[flue] Tool "${toolName}" ran step.do("${name}") twice in one call. Step names ` +
				'identify the logical work for replay — derive a distinct name per step ' +
				'(e.g. "item:" + id).',
		);
	}
	used.add(name);
	return name;
}

/** Clone a step value, enforcing the JSON-serializability contract. */
export function cloneStepValue(value: unknown, toolName: string, stepName: string): unknown {
	return cloneJsonSerializable(value, `Tool "${toolName}" step "${stepName}" value`);
}

/**
 * The `step` a durable tool sees outside an agent session: identical
 * semantics (name discipline, JSON-serializable values), no persistence —
 * a standalone run has no durability for the memo to extend.
 */
function createEphemeralToolStep(toolName: string): ToolStep {
	const used = new Set<string>();
	return {
		async do(name, fn) {
			const stepName = claimStepName(name, toolName, used);
			return cloneStepValue(await fn(), toolName, stepName) as Awaited<ReturnType<typeof fn>>;
		},
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
	data?: unknown,
	signal?: AbortSignal,
): Promise<ToolOutput<TTool>> {
	if (tool.harness) {
		throw new Error(
			`[flue] Tool "${tool.name}" declares \`harness: true\` and can only run inside an agent session — a standalone run has no harness.`,
		);
	}
	const parsed = parseToolInput(tool, data, signal);
	return validateToolOutput(tool, await tool.run(parsed.context));
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
	if (typeof value !== 'string' || value.trim().length === 0) {
		throw new Error(`[flue] ${label} must be a non-empty string.`);
	}
}
