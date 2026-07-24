import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { type Static, Type } from '@earendil-works/pi-ai';
import { composeTimeoutSignal } from './abort.ts';
import { decodeBase64 } from './base64.ts';
import type { PackagedSkillDirectory, SessionEnv } from './types.ts';

const MAX_READ_LINES = 2000;
const MAX_READ_BYTES = 50 * 1024;
const MAX_GREP_MATCHES = 100;
const MAX_GREP_LINE_LENGTH = 500;
const MAX_GLOB_RESULTS = 1000;
const BASE64_READ_LINE_LENGTH = 76;
const PACKAGED_SKILLS_ROOT = '/.flue/packaged-skills/';
export const READ_SKILL_RESOURCE_TOOL_NAME = 'read_skill_resource';

export interface TaskToolParams {
	prompt: string;
	description?: string;
	/**
	 * Required and non-blank in the model-facing schema. Agent-less blank
	 * children exist only outside the tool path: programmatic `session.task()`
	 * calls and durable replays of records without an `agent` argument.
	 */
	agent: string;
	cwd?: string;
	attachments?: Array<{ id: string }>;
}

export interface TaskToolResultDetails {
	taskId: string;
	session: string;
	messageId?: string;
	agent?: string;
	cwd?: string;
}

/**
 * Layer packaged-skill routing onto an env before handing it to model-facing
 * tool factories: `readFile` serves `/.flue/packaged-skills/` paths from the
 * in-memory catalog (and reports unknown paths under that root as missing)
 * and delegates everything else. Session-internal — `harness.sandbox` and
 * `useTool` handlers see the real env, never this overlay.
 */
export function overlayPackagedSkills(
	env: SessionEnv,
	packagedSkills: Record<string, PackagedSkillDirectory>,
): SessionEnv {
	return {
		...env,
		async readFile(path: string): Promise<string> {
			const packagedFile = readPackagedSkillFile(packagedSkills, path);
			if (packagedFile !== undefined) return packagedFile;
			if (path.startsWith(PACKAGED_SKILLS_ROOT)) {
				throw new Error(`[flue] Packaged skill file not found: ${path}`);
			}
			return env.readFile(path);
		},
	};
}

const ReadParams = Type.Object({
	path: Type.String({ description: 'Path to the file to read' }),
	offset: Type.Optional(Type.Number({ description: 'Line number to start from (1-indexed)' })),
	limit: Type.Optional(Type.Number({ description: 'Maximum number of lines to read' })),
});

export function createPackagedSkillReadTool(
	packagedSkills: Record<string, PackagedSkillDirectory>,
): AgentTool<typeof ReadParams> {
	return {
		name: READ_SKILL_RESOURCE_TOOL_NAME,
		label: 'Read Skill Resource',
		description: 'Read a packaged skill supporting file by its advertised path.',
		parameters: ReadParams,
		async execute(_toolCallId: string, params: Static<typeof ReadParams>, signal?: AbortSignal) {
			throwIfAborted(signal);
			const content = readPackagedSkillFile(packagedSkills, params.path);
			if (content === undefined)
				throw new Error(`[flue] Packaged skill file not found: ${params.path}`);
			return formatReadContent(params.path, content, params.offset, params.limit);
		},
	};
}

/**
 * The framework's standard `read` tool over a {@link SessionEnv}. Needs only
 * the file verbs. Use it (with the other `create*Tool` factories) to compose
 * a {@link SandboxFactory}'s `tools` list instead of rebuilding from scratch.
 */
export function createReadTool(env: SessionEnv): AgentTool<typeof ReadParams> {
	return {
		name: 'read',
		label: 'Read File',
		description:
			'Read a file. Output is truncated to 2000 lines or 50KB — use offset/limit for large files.',
		parameters: ReadParams,
		async execute(_toolCallId: string, params: Static<typeof ReadParams>, signal?: AbortSignal) {
			throwIfAborted(signal);
			const content = await env.readFile(params.path);
			return formatReadContent(params.path, content, params.offset, params.limit);
		},
	};
}

/**
 * Per-file mutation locks shared by the standard `write` and `edit` tools.
 *
 * A tool batch executes in parallel, so two mutations of the same file would
 * otherwise read one snapshot and last-write-wins — silently losing edits
 * and, when a shorter truncating write finishes after a longer one, leaving
 * corrupt tail bytes. Chaining mutations per resolved path keeps cross-file
 * parallelism while every read → modify → write transaction sees its
 * predecessor's result, in dispatch order — so a genuine conflict surfaces
 * as a real "could not find" error instead of a silent loss.
 *
 * Keyed per env instance (one tool list per batch shares one env), with
 * paths canonicalized through `env.resolvePath` — alias coalescing is as
 * good as the adapter's resolution. A `bash` command mutating the same file
 * concurrently remains unsynchronized; a shell cannot take this lock.
 *
 * Abort discipline (matching pi's file-mutation queue): the locked operation
 * checks the signal between awaits rather than rejecting from an abort
 * listener, so the lock never releases while a filesystem write is in
 * flight.
 */
const fileMutationLocks = new WeakMap<SessionEnv, Map<string, Promise<void>>>();

function withFileMutationLock<T>(
	env: SessionEnv,
	path: string,
	operation: () => Promise<T>,
): Promise<T> {
	let locks = fileMutationLocks.get(env);
	if (!locks) {
		locks = new Map();
		fileMutationLocks.set(env, locks);
	}
	let key: string;
	try {
		key = env.resolvePath(path);
	} catch {
		key = path;
	}
	const tail = locks.get(key) ?? Promise.resolve();
	const run = tail.then(operation);
	const next = run.then(
		() => undefined,
		() => undefined,
	);
	locks.set(key, next);
	void next.then(() => {
		if (locks.get(key) === next) locks.delete(key);
	});
	return run;
}

const WriteParams = Type.Object({
	path: Type.String({ description: 'Path to the file to write' }),
	content: Type.String({ description: 'Content to write to the file' }),
});

/**
 * The framework's standard `write` tool over a {@link SessionEnv}. Needs only
 * the file verbs.
 */
export function createWriteTool(env: SessionEnv): AgentTool<typeof WriteParams> {
	return {
		name: 'write',
		label: 'Write File',
		description:
			'Write content to a file. Creates the file and parent directories if they do not exist.',
		parameters: WriteParams,
		async execute(_toolCallId: string, params: Static<typeof WriteParams>, signal?: AbortSignal) {
			throwIfAborted(signal);
			return withFileMutationLock(env, params.path, async () => {
				// Re-check after the lock wait; never between write start and end.
				throwIfAborted(signal);
				// SessionEnv.writeFile creates missing parent directories itself
				// (the FlueFs.writeFile guarantee), so no eager mkdir here.
				await env.writeFile(params.path, params.content);
				return {
					content: [
						{
							type: 'text',
							text: `Successfully wrote ${params.content.length} bytes to ${params.path}`,
						},
					],
					details: { path: params.path, size: params.content.length },
				};
			});
		},
	};
}

const EditParams = Type.Object({
	path: Type.String({ description: 'Path to the file to edit' }),
	oldText: Type.String({ description: 'Exact text to find (must be unique)' }),
	newText: Type.String({ description: 'Replacement text' }),
	replaceAll: Type.Optional(Type.Boolean({ description: 'Replace all occurrences' })),
});

/**
 * The framework's standard `edit` tool over a {@link SessionEnv}. Needs only
 * the file verbs.
 */
export function createEditTool(env: SessionEnv): AgentTool<typeof EditParams> {
	return {
		name: 'edit',
		label: 'Edit File',
		description:
			'Edit a file using exact text replacement. The oldText must match a unique region of the file. Use replaceAll to replace all occurrences.',
		parameters: EditParams,
		async execute(_toolCallId: string, params: Static<typeof EditParams>, signal?: AbortSignal) {
			throwIfAborted(signal);
			if (params.oldText === '') {
				throw new Error('oldText must be a non-empty string.');
			}
			// The whole read → replace → write transaction holds the lock, so a
			// same-file edit in the same parallel batch sees this one's result.
			return withFileMutationLock(env, params.path, async () => {
				throwIfAborted(signal);
				const content = await env.readFile(params.path);
				throwIfAborted(signal);

				// Function replacer: a plain-string second argument would interpret
				// `$$`/`$&`-style replacement patterns in the model-supplied text.
				if (params.replaceAll) {
					const newContent = content.replaceAll(params.oldText, () => params.newText);
					if (newContent === content) {
						throw new Error(`Could not find the text in ${params.path}. No changes made.`);
					}
					await env.writeFile(params.path, newContent);
					const count = content.split(params.oldText).length - 1;
					return {
						content: [{ type: 'text', text: `Replaced ${count} occurrences in ${params.path}` }],
						details: { path: params.path, replacements: count },
					};
				}

				const occurrences = countOccurrences(content, params.oldText);
				if (occurrences === 0) {
					throw new Error(
						`Could not find the exact text in ${params.path}. Make sure your oldText matches exactly, including whitespace and indentation.`,
					);
				}
				if (occurrences > 1) {
					throw new Error(
						`Found ${occurrences} occurrences of the text in ${params.path}. Provide more surrounding context to make the match unique, or use replaceAll.`,
					);
				}

				const newContent = content.replace(params.oldText, () => params.newText);
				await env.writeFile(params.path, newContent);
				return {
					content: [{ type: 'text', text: `Successfully edited ${params.path}` }],
					details: { path: params.path },
				};
			});
		},
	};
}

const BashParams = Type.Object({
	command: Type.String({ description: 'Bash command to execute' }),
	timeout: Type.Optional(Type.Number({ description: 'Timeout in seconds' })),
});

/**
 * The framework's standard `bash` tool over a {@link SessionEnv}. Requires a
 * working `env.exec` — leave it out of a `tools` list for sandboxes that
 * don't execute shell commands.
 */
export function createBashTool(env: SessionEnv): AgentTool<typeof BashParams> {
	return {
		name: 'bash',
		label: 'Run Command',
		description:
			'Execute a bash command. Returns stdout and stderr. Output is truncated to the last 2000 lines or 50KB.',
		parameters: BashParams,
		async execute(_toolCallId: string, params: Static<typeof BashParams>, signal?: AbortSignal) {
			throwIfAborted(signal);

			// Two layers cooperate to enforce `params.timeout` (the
			// model-facing parameter stays in seconds, matching bash-tool
			// convention; it is converted to milliseconds here):
			//
			//   1. Pass `timeoutMs` to env.exec as a hint. Sandbox adapters
			//      forward it to their provider's native timeout option
			//      (E2B `timeoutMs`, Daytona `timeout`, etc.) so signal-
			//      blind providers still observe the deadline with full
			//      fidelity. Bash factories translate it into a signal
			//      internally.
			//   2. Compose a local AbortSignal.timeout into `signal` as a
			//      backstop. Sandbox adapters that ignore both fields will at
			//      least see the merged signal aborted on the way out.
			//
			// On timeout we return a 124-shaped ShellResult so the model
			// can recover. On host abort we rethrow so the outer call
			// cancels. This timeout-as-recoverable-result behavior lives
			// here in the LLM-facing tool, not in SessionEnv/SandboxApi:
			// Programmatic callers express timeouts via AbortSignal.timeout(...) and
			// accept abort semantics; the model can only emit JSON, so it
			// needs `params.timeout` and a recoverable shape on timeout.
			const timeoutMs = typeof params.timeout === 'number' ? params.timeout * 1000 : undefined;
			const { timeoutSignal, mergedSignal: execSignal } = composeTimeoutSignal(timeoutMs, signal);

			const timedOut = () =>
				formatBashResult(
					{
						stdout: '',
						stderr: `[flue] Command timed out after ${params.timeout} seconds.`,
						exitCode: 124,
					},
					params.command,
				);
			try {
				const result = await env.exec(params.command, {
					timeoutMs,
					signal: execSignal,
				});
				// Some sandbox adapters don't observe the signal mid-flight and
				// just return whatever the remote produced. If the timeout
				// fired during that window and the host signal didn't,
				// surface it as a recoverable timeout instead of a stale
				// success.
				if (timeoutSignal?.aborted && !signal?.aborted) return timedOut();
				return formatBashResult(result, params.command);
			} catch (err) {
				// Same rule on the throwing path: timeout-only → recoverable
				// 124-shape; host signal involved → rethrow so the caller's
				// cancellation surfaces as an AbortError.
				if (timeoutSignal?.aborted && !signal?.aborted) return timedOut();
				throw err;
			}
		},
	};
}

const TaskParams = Type.Object({
	description: Type.Optional(
		Type.String({ description: 'Short human-readable label for the delegated work' }),
	),
	prompt: Type.String({ description: 'Focused instructions for the child agent' }),
	// Required in the schema, but a plain string rather than an enum: the
	// live roster can outgrow the frozen baseline (a dynamically declared
	// subagent is delegable the same turn its `resources` signal announced
	// it), and an enum would rewrite the tool spec on every roster flip.
	agent: Type.String({
		minLength: 1,
		description:
			'Subagent to run the task with, from the list of currently available agents. ' +
			'Agents that have been removed from the list are no longer usable (until re-introduced, if ever).',
	}),
	cwd: Type.Optional(
		Type.String({
			description:
				'Working directory for the child agent. AGENTS.md and skills are discovered from here.',
		}),
	),
	attachments: Type.Optional(
		Type.Array(
			Type.Object({
				id: Type.String({ description: 'Attachment ID shown in the current conversation' }),
			}),
			{ description: 'Images from this conversation to include in the child agent prompt' },
		),
	),
});

/**
 * Build Flue's framework-owned `task` tool. Always in the tool set, and the
 * spec is fully STATIC — no roster, no per-agent text — so the serialized
 * tools block never changes and keeps hitting the provider's prompt-cache
 * prefix regardless of roster state. The roster lives in the system prompt's
 * "Available Agents" section (same freeze semantics as the skill catalog);
 * mid-window changes are announced as `resources` signals; and `agent` is
 * schema-required, resolving against the live roster at run time — an agent
 * with no `useSubagent()` declarations has no valid value to pass.
 */
export function createTaskTool(
	runTask: (
		params: TaskToolParams,
		signal?: AbortSignal,
		toolCallId?: string,
	) => Promise<AgentToolResult<TaskToolResultDetails>>,
): AgentTool<typeof TaskParams> {
	return {
		name: 'task',
		label: 'Run Task',
		description:
			'Delegate a focused task to a detached child agent with its own context. ' +
			'Use this for independent research, file exploration, or parallel work. ' +
			'Pass attachment IDs shown in the conversation to include those images. ' +
			'The task returns only its final answer to this conversation. ' +
			'Agents available for delegation are listed under "Available Agents" in the system prompt.',
		parameters: TaskParams,
		async execute(toolCallId: string, params: Static<typeof TaskParams>, signal?: AbortSignal) {
			throwIfAborted(signal);
			return runTask(params, signal, toolCallId);
		},
	};
}

/**
 * The `name` schema is a plain string, validated at run time — a literal
 * union of skill names would rewrite the tool spec (and invalidate the
 * provider's prompt cache) every time a dynamically declared skill flips.
 * An unknown name returns a factual miss listing the available skills.
 */
export function createActivateSkillTool(
	activate: (name: string, signal?: AbortSignal) => Promise<string>,
): AgentTool<any> {
	const ActivateSkillParams = Type.Object({
		name: Type.String({ description: 'Name of the skill to activate' }),
	});

	return {
		name: 'activate_skill',
		label: 'Activate Skill',
		description:
			'Load the full instructions for one available skill before performing work that matches its description. Supporting resources remain lazy until explicitly read.',
		parameters: ActivateSkillParams,
		async execute(_toolCallId: string, params: unknown, signal?: AbortSignal) {
			throwIfAborted(signal);
			const name =
				typeof params === 'object' &&
				params !== null &&
				'name' in params &&
				typeof params.name === 'string'
					? params.name
					: '';
			return {
				content: [{ type: 'text', text: await activate(name, signal) }],
				details: { skill: name },
			};
		},
	};
}

export function formatBashResult(
	result: { stdout: string; stderr: string; exitCode: number },
	command: string,
): AgentToolResult<any> {
	const combined = (result.stdout + (result.stderr ? `\n${result.stderr}` : '')).trim();
	const { text: output } = truncateTail(combined, MAX_READ_LINES, MAX_READ_BYTES);
	const exitLine = `Command exited with code ${result.exitCode}`;

	return {
		content: [
			{
				type: 'text',
				text:
					result.exitCode === 0
						? output || '(no output)'
						: `${output || '(no output)'}\n\n${exitLine}`,
			},
		],
		details: { command, exitCode: result.exitCode },
	};
}

const GrepParams = Type.Object({
	pattern: Type.String({ description: 'Search pattern (regex)' }),
	path: Type.Optional(Type.String({ description: 'Directory or file to search (default: .)' })),
	include: Type.Optional(Type.String({ description: 'Glob filter, e.g. "*.ts"' })),
	literal: Type.Optional(Type.Boolean({ description: 'Match the pattern as literal text' })),
});

// Keyed on env.exec rather than the env object: the session hands tool
// factories a fresh per-call overlay env (packaged-skill routing), but the
// exec function reference is stable across overlays — so the probe still
// runs once per underlying sandbox.
const grepBackends = new WeakMap<SessionEnv['exec'], Promise<'rg' | 'grep'>>();

function resolveGrepBackend(env: SessionEnv): Promise<'rg' | 'grep'> {
	let backend = grepBackends.get(env.exec);
	if (!backend) {
		// No caller signal here: the probe result is cached per-env, so an
		// operation abort mid-probe would poison the cache with 'grep'. A
		// short deadline keeps a hung exec from wedging the first search.
		backend = env
			.exec('rg --version', { timeoutMs: 10_000 })
			.then((result) => (result.exitCode === 0 ? 'rg' : 'grep'))
			.catch(() => 'grep');
		grepBackends.set(env.exec, backend);
	}
	return backend;
}

/**
 * The framework's standard `grep` tool over a {@link SessionEnv}. Requires a
 * working `env.exec` (searches via `rg` or `grep` in the sandbox).
 */
export function createGrepTool(env: SessionEnv): AgentTool<typeof GrepParams> {
	return {
		name: 'grep',
		label: 'Search Files',
		description:
			'Search file contents for a regex pattern. Returns matching lines with file paths and line numbers.',
		parameters: GrepParams,
		async execute(_toolCallId: string, params: Static<typeof GrepParams>, signal?: AbortSignal) {
			throwIfAborted(signal);

			const searchPath = params.path || '.';
			const backend = await resolveGrepBackend(env);
			let cmd: string;
			if (backend === 'rg') {
				const literalFlag = params.literal ? ' --fixed-strings' : '';
				const includeFlag = params.include ? ` --glob ${shellQuote(params.include)}` : '';
				cmd = `rg --line-number --with-filename --color never${literalFlag}${includeFlag} -- ${shellQuote(params.pattern)} ${shellQuote(searchPath)}`;
			} else {
				const patternFlag = params.literal ? '-F' : '-E';
				const includeFlag = params.include ? ` --include=${shellQuote(params.include)}` : '';
				cmd = `grep -rnH ${patternFlag}${includeFlag} -- ${shellQuote(params.pattern)} ${shellQuote(searchPath)}`;
			}

			const result = await env.exec(cmd, { signal });

			if (result.exitCode === 1 && !result.stdout.trim()) {
				return {
					content: [{ type: 'text', text: 'No matches found.' }],
					details: { matchCount: 0 },
				};
			}
			if (result.exitCode > 1) {
				throw new Error(`grep failed: ${result.stderr}`);
			}

			const lines = result.stdout.trim().split('\n');
			const truncatedLines = lines.slice(0, MAX_GREP_MATCHES);
			const output = truncatedLines
				.map((line) =>
					line.length > MAX_GREP_LINE_LENGTH ? `${line.slice(0, MAX_GREP_LINE_LENGTH)}...` : line,
				)
				.join('\n');

			let finalOutput = output;
			if (lines.length > MAX_GREP_MATCHES) {
				finalOutput += `\n\n[Showing ${MAX_GREP_MATCHES} of ${lines.length} matches. Narrow your search.]`;
			}

			return {
				content: [{ type: 'text', text: finalOutput }],
				details: { matchCount: Math.min(lines.length, MAX_GREP_MATCHES) },
			};
		},
	};
}

const GlobParams = Type.Object({
	pattern: Type.String({ description: 'Filename pattern, e.g. "*.ts"' }),
	path: Type.Optional(Type.String({ description: 'Directory to search in (default: .)' })),
});

/**
 * The framework's standard `glob` tool over a {@link SessionEnv}. Requires a
 * working `env.exec` (finds files via `find` in the sandbox).
 */
export function createGlobTool(env: SessionEnv): AgentTool<typeof GlobParams> {
	return {
		name: 'glob',
		label: 'Find Files',
		description:
			'Find files by filename pattern using shell find -name semantics. Returns matching file paths.',
		parameters: GlobParams,
		async execute(_toolCallId: string, params: Static<typeof GlobParams>, signal?: AbortSignal) {
			throwIfAborted(signal);

			const searchPath = params.path || '.';
			const cmd = `find ${shellQuote(searchPath)} -type f -name ${shellQuote(params.pattern)} 2>/dev/null | head -${MAX_GLOB_RESULTS}`;
			const result = await env.exec(cmd, { signal });

			if (result.exitCode !== 0 && !result.stdout.trim()) {
				return {
					content: [{ type: 'text', text: 'No files found matching pattern.' }],
					details: { matchCount: 0 },
				};
			}

			const paths = result.stdout.trim().split('\n').filter(Boolean);

			if (paths.length === 0) {
				return {
					content: [{ type: 'text', text: 'No files found matching pattern.' }],
					details: { matchCount: 0 },
				};
			}

			return {
				content: [{ type: 'text', text: paths.join('\n') }],
				details: { matchCount: paths.length },
			};
		},
	};
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error('Operation aborted');
}

function readPackagedSkillFile(
	skills: Record<string, PackagedSkillDirectory>,
	path: string,
): string | undefined {
	for (const skill of Object.values(skills)) {
		for (const [filePath, file] of Object.entries(skill.files)) {
			if (path !== formatPackagedSkillFilePath(skill.id, filePath)) continue;
			return file.kind === 'binary'
				? wrapBase64ForReading(file.content)
				: new TextDecoder().decode(decodeBase64(file.content));
		}
	}
	return undefined;
}

function wrapBase64ForReading(content: string): string {
	const lines: string[] = [];
	for (let offset = 0; offset < content.length; offset += BASE64_READ_LINE_LENGTH) {
		lines.push(content.slice(offset, offset + BASE64_READ_LINE_LENGTH));
	}
	return lines.join('\n');
}

function formatReadContent(path: string, content: string, offset?: number, limit?: number) {
	const allLines = content.split('\n');
	const startLine = offset ? Math.max(0, offset - 1) : 0;
	if (startLine >= allLines.length) {
		throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`);
	}

	const endLine = limit ? startLine + limit : allLines.length;
	const lines = allLines.slice(startLine, endLine);
	const {
		text: truncatedText,
		wasTruncated,
		linesEmitted,
	} = truncateHead(lines, MAX_READ_LINES, MAX_READ_BYTES);

	let output = truncatedText;
	if (wasTruncated && linesEmitted === 0) {
		// The first requested line alone exceeds the byte budget (e.g. a
		// minified single-line file). There is no line-based offset that
		// reaches the rest of it, so say so instead of advising a skip-ahead
		// that would silently drop the line's content.
		output += `\n\n[Line ${startLine + 1} exceeds the ${MAX_READ_BYTES}-byte read limit; showing the first ${MAX_READ_BYTES} bytes of it. The remainder of this line is not accessible via offset/limit.]`;
	} else if (wasTruncated) {
		const shownEnd = startLine + linesEmitted;
		output += `\n\n[Showing lines ${startLine + 1}-${shownEnd} of ${allLines.length}. Use offset=${shownEnd + 1} to continue.]`;
	}

	return {
		content: [{ type: 'text' as const, text: output }],
		details: { path, lines: allLines.length },
	};
}

export function formatPackagedSkillFilePath(skillId: string, filePath: string): string {
	return `${PACKAGED_SKILLS_ROOT}${encodeURIComponent(skillId)}/${filePath}`;
}

function countOccurrences(str: string, substr: string): number {
	let count = 0;
	let pos = str.indexOf(substr, 0);
	while (pos !== -1) {
		count++;
		pos = str.indexOf(substr, pos + Math.max(substr.length, 1));
	}
	return count;
}

function shellQuote(arg: string): string {
	return `'${arg.replace(/'/g, `'\\''`)}'`;
}

function truncateHead(
	lines: string[],
	maxLines: number,
	maxBytes: number,
): { text: string; wasTruncated: boolean; linesEmitted: number } {
	let result = '';
	let lineCount = 0;
	let wasTruncated = false;

	for (const line of lines) {
		if (lineCount >= maxLines) {
			wasTruncated = true;
			break;
		}
		const next = lineCount === 0 ? line : `\n${line}`;
		if (result.length + next.length > maxBytes) {
			wasTruncated = true;
			if (lineCount === 0) {
				// The first line alone exceeds the byte budget (e.g. a minified
				// single-line file) — surface a byte-budget-sized prefix instead
				// of returning nothing.
				result = line.slice(0, maxBytes);
			}
			break;
		}
		result += next;
		lineCount++;
	}

	return { text: result, wasTruncated, linesEmitted: lineCount };
}

function truncateTail(
	text: string,
	maxLines: number,
	maxBytes: number,
): { text: string; wasTruncated: boolean } {
	const lines = text.split('\n');
	if (lines.length <= maxLines && text.length <= maxBytes) {
		return { text, wasTruncated: false };
	}

	let result = lines.slice(-maxLines).join('\n');
	if (result.length > maxBytes) {
		result = result.slice(-maxBytes);
	}
	return { text: result, wasTruncated: true };
}
