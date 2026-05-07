import { toJsonSchema } from '@valibot/to-json-schema';
import * as v from 'valibot';
import type { InferResult, ResultSchema, StandardJSONSchemaV1 } from './types.ts';

export const HEADLESS_PREAMBLE =
	'You are running in headless mode with no human operator. Work autonomously — never ask questions, never wait for user input. Make your best judgment and proceed independently.';

interface NormalizedResultSchema<T> {
	jsonSchema: Record<string, unknown>;
	parse(value: unknown, rawOutput: string): Promise<T> | T;
}

type MaybeStandardProps = StandardJSONSchemaV1['~standard'] & {
	jsonSchema?: StandardJSONSchemaV1['~standard']['jsonSchema'];
};

export function buildResultInstructions(schema: ResultSchema): string {
	const { jsonSchema } = normalizeResultSchema(schema);
	const { $schema: _, ...schemaWithoutMeta } = jsonSchema;
	return [
		'',
		'```json',
		JSON.stringify(schemaWithoutMeta, null, 2),
		'```',
		'',
		'Example: (Object)',
		'---RESULT_START---',
		'{"key": "value"}',
		'---RESULT_END---',
		'',
		'Example: (String)',
		'---RESULT_START---',
		'Hello, world!',
		'---RESULT_END---',
	].join('\n');
}

/** Follow-up prompt used when the LLM forgets to include RESULT_START/RESULT_END delimiters. */
export function buildResultExtractionPrompt(schema: ResultSchema): string {
	return [
		'Your task is complete. Now respond with ONLY your final result.',
		'No explanation, no preamble — just the result in the following format, conforming to this schema:',
		buildResultInstructions(schema),
	].join('\n');
}

export function buildSkillPrompt(
	skillInstructions: string,
	args?: Record<string, unknown>,
	schema?: ResultSchema,
): string {
	const parts: string[] = [HEADLESS_PREAMBLE, '', skillInstructions];

	if (args && Object.keys(args).length > 0) {
		parts.push(`\nArguments:\n${JSON.stringify(args, null, 2)}`);
	}

	if (schema) {
		parts.push(
			'When complete, you MUST output your result between these exact delimiters conforming to this schema:',
		);
		parts.push(buildResultInstructions(schema));
	}

	return parts.join('\n');
}

export function buildPromptText(text: string, schema?: ResultSchema): string {
	const parts: string[] = [HEADLESS_PREAMBLE, '', text];

	if (schema) {
		parts.push(
			'When complete, you MUST output your result between these exact delimiters conforming to this schema:',
		);
		parts.push(buildResultInstructions(schema));
	}

	return parts.join('\n');
}

/** Extract the last ---RESULT_START---/---RESULT_END--- block from agent text and validate against schema. */
export async function extractResult<S extends ResultSchema>(
	text: string,
	schema: S,
): Promise<InferResult<S>> {
	const resultBlock = extractLastResultBlock(text);

	if (resultBlock === null) {
		throw new ResultExtractionError(
			'No ---RESULT_START--- / ---RESULT_END--- block found in the assistant response.',
			text,
		);
	}

	const normalized = normalizeResultSchema(schema);
	const result = parseResultBlock(resultBlock, normalized.jsonSchema);
	return (await normalized.parse(result, resultBlock)) as InferResult<S>;
}

function parseResultBlock(resultBlock: string, jsonSchema: Record<string, unknown>): unknown {
	if (shouldParseJsonResult(jsonSchema, resultBlock)) {
		try {
			return JSON.parse(resultBlock);
		} catch {
			throw new ResultExtractionError(
				'Result block contains invalid JSON for the expected schema.',
				resultBlock,
			);
		}
	}

	return resultBlock;
}

function normalizeResultSchema<S extends ResultSchema>(
	schema: S,
): NormalizedResultSchema<InferResult<S>> {
	if (isStandardJsonSchema(schema)) {
		const standard = schema['~standard'];
		return {
			jsonSchema: standard.jsonSchema.input({ target: 'draft-07' }),
			async parse(value, rawOutput) {
				const parsed = await standard.validate(value);
				if (parsed.issues) {
					throw new ResultExtractionError(
						`Result does not match the expected schema: ${formatStandardIssues(parsed.issues)}`,
						rawOutput,
					);
				}
				return parsed.value as InferResult<S>;
			},
		};
	}

	if (isValibotSchema(schema)) {
		return {
			jsonSchema: toJsonSchema(schema, { errorMode: 'ignore' }) as Record<string, unknown>,
			parse(value, rawOutput) {
				const parsed = v.safeParse(schema, value);
				if (!parsed.success) {
					throw new ResultExtractionError(
						`Result does not match the expected schema: ${parsed.issues.map((i) => i.message).join(', ')}`,
						rawOutput,
					);
				}
				return parsed.output as InferResult<S>;
			},
		};
	}

	throw new Error(
		'[flue] result must be a Valibot schema or a Standard JSON Schema compatible schema.',
	);
}

function isStandardJsonSchema(value: unknown): value is StandardJSONSchemaV1 {
	const standard = getStandardProps(value);
	return (
		standard?.version === 1 &&
		typeof standard.validate === 'function' &&
		typeof standard.jsonSchema === 'object' &&
		standard.jsonSchema !== null &&
		typeof standard.jsonSchema.input === 'function'
	);
}

function isValibotSchema(value: unknown): value is v.GenericSchema {
	const schema = value as { type?: unknown } | null;
	return (
		typeof schema === 'object' &&
		schema !== null &&
		typeof schema.type === 'string' &&
		typeof getStandardProps(schema)?.validate === 'function'
	);
}

function getStandardProps(value: unknown): MaybeStandardProps | undefined {
	const props = (value as { '~standard'?: unknown } | null)?.['~standard'];
	if (typeof props !== 'object' || props === null) return undefined;
	return props as MaybeStandardProps;
}

function formatStandardIssues(issues: readonly { message: string }[]): string {
	return issues.map((issue) => issue.message).join(', ');
}

function shouldParseJsonResult(jsonSchema: Record<string, unknown>, resultBlock: string): boolean {
	const types = getSchemaTypes(jsonSchema.type);
	if (types.length > 0) {
		if (types.every((type) => type === 'string')) return false;
		if (types.includes('string')) return looksLikeJsonValue(resultBlock);
		return true;
	}

	if (
		'properties' in jsonSchema ||
		'additionalProperties' in jsonSchema ||
		'items' in jsonSchema ||
		'prefixItems' in jsonSchema
	) {
		return true;
	}

	if ('anyOf' in jsonSchema || 'oneOf' in jsonSchema || 'allOf' in jsonSchema) {
		return looksLikeJsonValue(resultBlock);
	}

	return looksLikeJsonValue(resultBlock);
}

function getSchemaTypes(type: unknown): string[] {
	if (typeof type === 'string') return [type];
	if (Array.isArray(type)) return type.filter((item): item is string => typeof item === 'string');
	return [];
}

function looksLikeJsonValue(value: string): boolean {
	const trimmed = value.trim();
	return (
		trimmed.startsWith('{') ||
		trimmed.startsWith('[') ||
		trimmed.startsWith('"') ||
		trimmed === 'true' ||
		trimmed === 'false' ||
		trimmed === 'null' ||
		/^-?\d/.test(trimmed)
	);
}

function extractLastResultBlock(text: string): string | null {
	const regex = /---RESULT_START---\s*\n([\s\S]*?)---RESULT_END---/g;
	const matches = text.matchAll(regex);
	let lastMatch: string | null = null;

	for (const match of matches) {
		lastMatch = match[1]?.trim() ?? null;
	}

	return lastMatch;
}

export class ResultExtractionError extends Error {
	constructor(
		message: string,
		public readonly rawOutput: string,
	) {
		super(message);
		this.name = 'ResultExtractionError';
	}
}
