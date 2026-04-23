/**
 * Cloudflare-specific `defineCommand`. Function form only — Workers cannot
 * spawn host processes, so there is no pass-through sugar. The user supplies
 * an executor (typically `fetch`-based or SDK-based) and benefits from
 * return-shape normalization plus automatic throw-catching.
 *
 * ```ts
 * const issues = defineCommand('issues', async (args) => {
 *   const res = await fetch(`https://api.github.com/...`);
 *   return { stdout: await res.text() };
 * });
 * ```
 */
import { normalizeExecutor, type CommandExecutor } from '../command-helpers.ts';
import type { Command } from '../types.ts';

export function defineCommand(name: string, execute: CommandExecutor): Command {
	return { name, execute: normalizeExecutor(execute) };
}
