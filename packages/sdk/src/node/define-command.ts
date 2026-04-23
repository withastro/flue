/**
 * Node-specific `defineCommand`. Supports three forms:
 *
 * ```ts
 * defineCommand('agent-browser');
 * defineCommand('gh', { env: { GH_TOKEN: process.env.GH_TOKEN } });
 * defineCommand('gh', async (args) => ({ stdout: '...' }));
 * ```
 *
 * Forms A and B shell out via `child_process.execFile`. Form C lets the user
 * implement the command however they like. All three forms benefit from
 * return-shape normalization and throw-catching — no `try`/`catch` or
 * `return { stdout, stderr, exitCode: 0 }` boilerplate required.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { normalizeExecutor, type CommandExecutor } from '../command-helpers.ts';
import type { Command } from '../types.ts';

/**
 * Options forwarded directly to Node's `child_process.execFile`. Full pass-through.
 */
export type CommandOptions = NonNullable<Parameters<typeof execFile>[2]>;

const execFileAsync = promisify(execFile);

/**
 * Essential, non-sensitive environment variables automatically forwarded to
 * pass-through commands (forms A and B). Users can override any of these —
 * or add their own (e.g. `GH_TOKEN`) — via `options.env`. Anything not listed
 * here (API keys, tokens, secrets, etc.) stays on the host and is NEVER
 * exposed to the spawned process unless the caller opts in explicitly.
 *
 * If you need full control over the env, use the function form:
 * `defineCommand('gh', async (args) => { ... })`.
 */
const DEFAULT_ENV: Record<string, string | undefined> = {
	PATH: process.env.PATH,
	HOME: process.env.HOME,
	USER: process.env.USER,
	LOGNAME: process.env.LOGNAME,
	HOSTNAME: process.env.HOSTNAME,
	SHELL: process.env.SHELL,
	LANG: process.env.LANG,
	LC_ALL: process.env.LC_ALL,
	LC_CTYPE: process.env.LC_CTYPE,
	TZ: process.env.TZ,
	TERM: process.env.TERM,
	TMPDIR: process.env.TMPDIR,
	TMP: process.env.TMP,
	TEMP: process.env.TEMP,
};

export function defineCommand(name: string): Command;
export function defineCommand(name: string, options: CommandOptions): Command;
export function defineCommand(name: string, execute: CommandExecutor): Command;
export function defineCommand(
	name: string,
	arg?: CommandOptions | CommandExecutor,
): Command {
	// Form C: user-supplied executor. Just wrap with normalization.
	if (typeof arg === 'function') {
		return { name, execute: normalizeExecutor(arg) };
	}

	// Forms A + B: pass-through to execFile.
	const userOpts = (arg ?? {}) as CommandOptions;
	const mergedOpts: CommandOptions = {
		maxBuffer: 50 * 1024 * 1024,
		...userOpts,
		env: { ...DEFAULT_ENV, ...(userOpts.env ?? {}) } as NodeJS.ProcessEnv,
	};

	const executor: CommandExecutor = async (args) => {
		const { stdout, stderr } = await execFileAsync(name, args, mergedOpts);
		return { stdout: String(stdout ?? ''), stderr: String(stderr ?? '') };
	};

	return { name, execute: normalizeExecutor(executor) };
}
