/**
 * Shared shell-exec scaffolding for `harness.shell()` and `session.shell()`,
 * which are documented as the same operation with and without transcript
 * recording. Keeping the envelope in one place keeps the event contract
 * (args redaction, exitCode sentinel, durationMs) from drifting between the
 * two surfaces.
 */

import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import { formatBashResult } from './agent.ts';
import { type FlueExecutionContext, interceptExecution } from './execution-interceptor.ts';
import { generateToolCallId } from './runtime/ids.ts';
import type {
	FlueEventInput,
	FlueObservationDetail,
	SessionEnv,
	ShellOptions,
	ShellResult,
} from './types.ts';

/**
 * Run `command` through `env.exec` wrapped in the bash tool-event envelope:
 * a `tool_start` emit up front, then a terminal `tool` emit carrying either
 * the formatted bash result or the `details: { command, exitCode: -1 }`
 * error-result shape. The optional `record` hook runs before each terminal
 * emit so `session.shell()` can append its transcript triple at the same
 * point in the sequence on both branches.
 */
export async function execShellWithEvents(
	env: SessionEnv,
	emit: (event: FlueEventInput, detail?: FlueObservationDetail) => void,
	command: string,
	options: ShellOptions | undefined,
	signal: AbortSignal | undefined,
	executionContext: FlueExecutionContext,
	record?: (
		toolCallId: string,
		args: Record<string, unknown>,
		result: AgentToolResult<any>,
		isError: boolean,
	) => Promise<void>,
): Promise<ShellResult> {
	const toolCallId = generateToolCallId();
	const startedAt = Date.now();

	// Per-call cwd/env names, when set, are part of the call's identity and
	// need to be visible in the transcript. Env values often contain
	// credentials, so transcript/tool events record only the keys while
	// env.exec receives the real values. The bash tool's own schema
	// (BashParams) doesn't formally declare these, but pi-ai's
	// ToolCall.arguments is `Record<string, any>` and providers forward
	// arguments opaquely, so extending the shape here is safe.
	const args: Record<string, unknown> = { command };
	if (options?.cwd !== undefined) args.cwd = options.cwd;
	if (options?.env !== undefined) args.env = redactEnvValues(options.env);

	emit({ type: 'tool_start', toolName: 'bash', toolCallId }, { origin: 'caller', args });

	try {
		const result = await interceptExecution(
			{ type: 'tool', toolCallId, toolName: 'bash' },
			executionContext,
			() =>
				env.exec(command, {
					env: options?.env,
					cwd: options?.cwd,
					timeoutMs: options?.timeoutMs,
					signal,
				}),
		);
		const shellResult: ShellResult = {
			stdout: result.stdout,
			stderr: result.stderr,
			exitCode: result.exitCode,
		};
		const toolResult = formatBashResult(shellResult, command);
		await record?.(toolCallId, args, toolResult, false);
		emit(
			{
				type: 'tool',
				toolName: 'bash',
				toolCallId,
				isError: false,
				result: toolResult,
				durationMs: Date.now() - startedAt,
			},
			{ origin: 'caller' },
		);
		return shellResult;
	} catch (error) {
		// Aligns with formatBashResult's `details: { command, exitCode }`
		// shape so consumers reading event.result.details.exitCode see a
		// number on both branches. -1 is the conventional sentinel for
		// "no exit recorded" (the same one env.exec uses internally for
		// sandbox-level failures — see sandbox.ts).
		const errResult: AgentToolResult<any> = {
			content: [{ type: 'text', text: getErrorMessage(error) }],
			details: { command, exitCode: -1 },
		};
		await record?.(toolCallId, args, errResult, true);
		emit(
			{
				type: 'tool',
				toolName: 'bash',
				toolCallId,
				isError: true,
				result: errResult,
				durationMs: Date.now() - startedAt,
			},
			{
				origin: 'caller',
				errorInfo: classifyShellError(error),
			},
		);
		throw error;
	}
}

function classifyShellError(error: unknown): { type: string; name?: string; message?: string } {
	if (error instanceof DOMException && error.name === 'AbortError') {
		return { type: 'AbortError', name: error.name, message: error.message };
	}
	if (error instanceof Error)
		return { type: error.name || '_OTHER', name: error.name, message: error.message };
	return { type: '_OTHER', ...(typeof error === 'string' ? { message: error } : {}) };
}

export function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function redactEnvValues(env: Record<string, string>): Record<string, string> {
	return Object.fromEntries(Object.keys(env).map((key) => [key, '<redacted>']));
}
