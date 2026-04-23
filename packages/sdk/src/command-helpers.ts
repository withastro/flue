/**
 * Internal helpers for building `Command` objects across platform-specific
 * `defineCommand` implementations (`@flue/sdk/node`, `@flue/sdk/cloudflare`).
 *
 * NOT re-exported from any public entry point.
 */
import type { ShellResult } from './types.ts';

/**
 * Loose return shape accepted from user-supplied command executors. All forms
 * are normalized to a full `ShellResult` by `normalizeExecutor()`.
 */
export type CommandExecutorResult =
	| ShellResult
	| { stdout?: string; stderr?: string; exitCode?: number }
	| string
	| void;

/**
 * User-supplied command executor. Can return a full `ShellResult`, a partial
 * `{ stdout?, stderr?, exitCode? }` object, a bare string (treated as stdout),
 * or void (empty success). Thrown errors are caught and converted to an
 * `exitCode`-bearing `ShellResult` — no `try`/`catch` needed at the call site.
 */
export type CommandExecutor = (args: string[]) => Promise<CommandExecutorResult>;

interface ErrorLike {
	stdout?: unknown;
	stderr?: unknown;
	code?: unknown;
}

/**
 * Wrap a user-supplied `CommandExecutor` to always resolve with a full
 * `ShellResult`. Applies loose-return normalization and catches throws.
 */
export function normalizeExecutor(
	executor: CommandExecutor,
): (args: string[]) => Promise<ShellResult> {
	return async (args: string[]): Promise<ShellResult> => {
		try {
			const raw = await executor(args);
			if (raw === undefined || raw === null) {
				return { stdout: '', stderr: '', exitCode: 0 };
			}
			if (typeof raw === 'string') {
				return { stdout: raw, stderr: '', exitCode: 0 };
			}
			return {
				stdout: raw.stdout ?? '',
				stderr: raw.stderr ?? '',
				exitCode: raw.exitCode ?? 0,
			};
		} catch (err: unknown) {
			const e = (err ?? {}) as ErrorLike;
			return {
				stdout: typeof e.stdout === 'string' ? e.stdout : '',
				stderr: typeof e.stderr === 'string' ? e.stderr : String(err),
				exitCode: typeof e.code === 'number' ? e.code : 1,
			};
		}
	};
}
