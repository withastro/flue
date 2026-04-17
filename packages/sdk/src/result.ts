import { toJsonSchema } from '@valibot/to-json-schema';
import * as v from 'valibot';

export const HEADLESS_PREAMBLE =
	'You are running in headless mode with no human operator. Work autonomously — never ask questions, never wait for user input. Make your best judgment and proceed independently.';

export function buildResultInstructions(schema: v.GenericSchema): string {
	const jsonSchema = toJsonSchema(schema, { errorMode: 'ignore' });
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
export function buildResultExtractionPrompt(schema: v.GenericSchema): string {
	return [
		'Your task is complete. Now respond with ONLY your final result.',
		'No explanation, no preamble — just the result in the following format, conforming to this schema:',
		buildResultInstructions(schema),
	].join('\n');
}

export function buildSkillPrompt(
	skillInstructions: string,
	args?: Record<string, unknown>,
	schema?: v.GenericSchema,
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

export function buildPromptText(text: string, schema?: v.GenericSchema): string {
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
export function extractResult<S extends v.GenericSchema>(
	text: string,
	schema: S,
): v.InferOutput<S> {
	const resultBlock = extractLastResultBlock(text);

	if (resultBlock === null) {
		throw new ResultExtractionError(
			'No ---RESULT_START--- / ---RESULT_END--- block found in the assistant response.',
			text,
		);
	}

	let result: unknown = resultBlock;
	if (schema.type === 'object' || schema.type === 'array') {
		try {
			result = JSON.parse(resultBlock);
		} catch {
			throw new ResultExtractionError(
				'Result block contains invalid JSON for the expected schema.',
				resultBlock,
			);
		}
	}

	const parsed = v.safeParse(schema, result);
	if (!parsed.success) {
		throw new ResultExtractionError(
			`Result does not match the expected schema: ${parsed.issues.map((i) => i.message).join(', ')}`,
			resultBlock,
		);
	}

	return parsed.output;
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
