import type { AgentTool } from '@mariozechner/pi-agent-core';
import { toJsonSchema } from '@valibot/to-json-schema';
import * as v from 'valibot';

/**
 * Names of the framework-injected tools used to capture structured results.
 * Surfaced for diagnostics and logging; not part of the public API.
 */
export const FINISH_TOOL_NAME = 'finish';
export const GIVE_UP_TOOL_NAME = 'give_up';

/** Footer appended to user prompts/skill bodies when a `result` schema is set. */
function buildResultFooter(): string {
	return [
		'',
		`When the task is complete, call the \`${FINISH_TOOL_NAME}\` tool with your final answer as its arguments. The arguments are validated against the required schema; if validation fails you will receive an error and may try again.`,
		`If you determine that you cannot complete the task or cannot produce a result that conforms to the required schema, call the \`${GIVE_UP_TOOL_NAME}\` tool with a clear \`reason\`.`,
		`Do not respond with the answer in plain text — only a successful \`${FINISH_TOOL_NAME}\` (or \`${GIVE_UP_TOOL_NAME}\`) call counts.`,
	].join('\n');
}

/** Follow-up prompt sent when the LLM ends a turn without calling `finish` or `give_up`. */
export function buildResultFollowUpPrompt(): string {
	return [
		`You ended your turn without calling \`${FINISH_TOOL_NAME}\` or \`${GIVE_UP_TOOL_NAME}\`.`,
		`Either call \`${FINISH_TOOL_NAME}\` with your final answer, or call \`${GIVE_UP_TOOL_NAME}\` with a reason if you cannot determine the answer.`,
	].join(' ');
}

/**
 * Build the user-facing prompt text for a `session.skill('<name>')` call,
 * where `<name>` is a name registered in the session's skill registry.
 *
 * The system prompt's "Available Skills" list tells the model where the
 * skill lives (`.agents/skills/<name>/SKILL.md`) and how to run it (read
 * the file, follow its instructions). The per-call message just names
 * the skill plus any arguments — no inlined body, no path hint.
 */
export function buildSkillByNamePrompt(
	name: string,
	args?: Record<string, unknown>,
	schema?: v.GenericSchema,
): string {
	const parts: string[] = [`Run the skill named "${name}".`];

	if (args && Object.keys(args).length > 0) {
		parts.push('', 'Arguments:', JSON.stringify(args, null, 2));
	}

	if (schema) {
		parts.push(buildResultFooter());
	}

	return parts.join('\n');
}

/**
 * Build the user-facing prompt text for a `session.skill('<path>')` call,
 * where `<path>` is a relative path under `.agents/skills/` (e.g.
 * `'triage/reproduce.md'`). Path-based references bypass the registry
 * — the skill isn't named in the system prompt's "Available Skills"
 * list — so we hand the model the resolved absolute path explicitly.
 */
export function buildSkillByPathPrompt(
	relPath: string,
	resolvedPath: string,
	args?: Record<string, unknown>,
	schema?: v.GenericSchema,
): string {
	const parts: string[] = [
		`Run the skill file \`${relPath}\`.`,
		'',
		`The file can be found at ${resolvedPath}.`,
	];

	if (args && Object.keys(args).length > 0) {
		parts.push('', 'Arguments:', JSON.stringify(args, null, 2));
	}

	if (schema) {
		parts.push(buildResultFooter());
	}

	return parts.join('\n');
}

export function buildPromptText(text: string, schema?: v.GenericSchema): string {
	const parts: string[] = [text];

	if (schema) {
		parts.push(buildResultFooter());
	}

	return parts.join('\n');
}

// ─── Result tools ───────────────────────────────────────────────────────────

/**
 * Outcome of a result-schema prompt/skill call. `pending` means the LLM ended its
 * turn without calling either of the result tools.
 */
export type ResultOutcome<T> =
	| { type: 'pending' }
	| { type: 'finished'; value: T }
	| { type: 'gave_up'; reason: string };

export interface ResultToolBundle<T> {
	tools: AgentTool<any>[];
	getOutcome(): ResultOutcome<T>;
}

/**
 * Produce the per-call `finish` and `give_up` tool pair for a given valibot schema.
 *
 * - `finish`'s parameters are derived from the schema via `@valibot/to-json-schema`.
 *   Non-object top-level schemas are wrapped in a `{ result: <schema> }` envelope
 *   because every LLM provider expects tool arguments to be a top-level object.
 * - Pi-agent-core validates args against the JSON Schema before calling `execute`.
 *   Inside `execute` we additionally run `valibot.safeParse` to enforce
 *   valibot-specific refinements and to obtain the parsed output (transforms,
 *   defaults, coercion). On valibot failure we throw — pi-agent-core surfaces
 *   the throw as a tool-error tool-result, so the LLM can self-correct.
 * - First successful `finish` (or `give_up`) call wins. Subsequent calls return
 *   a tool error rather than throwing, to keep the conversation transcript natural.
 * - Successful calls set `terminate: true` so pi-agent-core ends the loop after
 *   the current tool batch.
 */
export function createResultTools<S extends v.GenericSchema>(
	schema: S,
): ResultToolBundle<v.InferOutput<S>> {
	let outcome: ResultOutcome<v.InferOutput<S>> = { type: 'pending' };

	const wrapped = needsEnvelope(schema);
	const innerJsonSchema = stripJsonSchemaMeta(
		toJsonSchema(schema, { errorMode: 'ignore' }) as Record<string, unknown>,
	);
	const finishParameters = wrapped
		? {
				type: 'object',
				properties: { result: innerJsonSchema },
				required: ['result'],
				additionalProperties: false,
			}
		: innerJsonSchema;

	const finishDescription =
		`Call this tool when the task is complete. Provide your final answer as the arguments. ` +
		`The arguments are validated against the required schema; if validation fails you will ` +
		`receive an error message and may try again. ` +
		`The first successful \`${FINISH_TOOL_NAME}\` call wins — once the task is finished, do ` +
		`not call \`${FINISH_TOOL_NAME}\` again.`;

	const giveUpDescription =
		`Call this tool only if you have determined that you cannot complete the task or ` +
		`cannot produce a result that conforms to the required schema. Provide a clear \`reason\`. ` +
		`This ends the task with a failure.`;

	const finishTool: AgentTool<any> = {
		name: FINISH_TOOL_NAME,
		label: FINISH_TOOL_NAME,
		description: finishDescription,
		parameters: finishParameters as any,
		async execute(_toolCallId, params) {
			if (outcome.type !== 'pending') {
				return alreadyDoneToolError(outcome);
			}

			const candidate = wrapped ? (params as { result: unknown }).result : params;
			const parsed = v.safeParse(schema, candidate);
			if (!parsed.success) {
				const issues = parsed.issues
					.map((i) => i.message + (i.path ? ` (at ${formatIssuePath(i.path)})` : ''))
					.join('; ');
				// Throw — pi-agent-core encodes this as a tool-error tool-result, which
				// the LLM sees on its next turn and can correct.
				throw new Error(
					`Result does not match the required schema: ${issues}. ` +
						`Please call \`${FINISH_TOOL_NAME}\` again with a corrected payload.`,
				);
			}

			outcome = { type: 'finished', value: parsed.output };
			return {
				content: [{ type: 'text', text: 'Result accepted. The task is complete.' }],
				details: { tool: FINISH_TOOL_NAME, result: parsed.output },
				terminate: true,
			};
		},
	};

	const giveUpTool: AgentTool<any> = {
		name: GIVE_UP_TOOL_NAME,
		label: GIVE_UP_TOOL_NAME,
		description: giveUpDescription,
		parameters: {
			type: 'object',
			properties: {
				reason: {
					type: 'string',
					minLength: 1,
					description: 'A clear explanation of why the task cannot be completed.',
				},
			},
			required: ['reason'],
			additionalProperties: false,
		} as any,
		async execute(_toolCallId, params) {
			if (outcome.type !== 'pending') {
				return alreadyDoneToolError(outcome);
			}

			const reason = (params as { reason: unknown }).reason;
			if (typeof reason !== 'string' || reason.trim().length === 0) {
				throw new Error(`\`${GIVE_UP_TOOL_NAME}\` requires a non-empty \`reason\` string.`);
			}

			outcome = { type: 'gave_up', reason };
			return {
				content: [{ type: 'text', text: 'Acknowledged.' }],
				details: { tool: GIVE_UP_TOOL_NAME, reason },
				terminate: true,
			};
		},
	};

	return {
		tools: [finishTool, giveUpTool],
		getOutcome: () => outcome,
	};
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function needsEnvelope(schema: v.GenericSchema): boolean {
	// Valibot's runtime `type` discriminator. Tool parameters must be an
	// object at the top level; anything else gets wrapped in `{ result: ... }`.
	const type = (schema as { type?: string }).type;
	return type !== 'object';
}

function stripJsonSchemaMeta(jsonSchema: Record<string, unknown>): Record<string, unknown> {
	const { $schema: _schema, ...rest } = jsonSchema as { $schema?: unknown } & Record<string, unknown>;
	return rest;
}

function formatIssuePath(path: ReadonlyArray<{ key?: unknown }>): string {
	return path
		.map((p) => (typeof p.key === 'number' ? `[${p.key}]` : `.${String(p.key ?? '?')}`))
		.join('')
		.replace(/^\./, '');
}

function alreadyDoneToolError<T>(outcome: ResultOutcome<T>) {
	const detail =
		outcome.type === 'finished'
			? 'A result was already submitted; the task is complete.'
			: 'The task was already given up; it cannot be resumed.';
	// Returning an error-shaped tool result (rather than throwing) keeps the
	// transcript natural and avoids re-triggering termination logic.
	return {
		content: [
			{
				type: 'text' as const,
				text: `${detail} Do not call this tool again.`,
			},
		],
		details: { alreadyDone: true },
	};
}

// ─── Errors ─────────────────────────────────────────────────────────────────

/**
 * Thrown when the LLM calls the `give_up` tool, indicating it cannot produce a
 * result that conforms to the required schema. Carries the LLM-supplied
 * `reason` and the assistant transcript leading up to the give-up.
 */
export class ResultUnavailableError extends Error {
	constructor(
		public readonly reason: string,
		public readonly assistantText: string,
	) {
		super(`The agent gave up: ${reason}`);
		this.name = 'ResultUnavailableError';
	}
}
