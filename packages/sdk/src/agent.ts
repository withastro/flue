import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { type Static, Type } from '@mariozechner/pi-ai';
import type { Role, SessionEnv } from './types.ts';

const MAX_READ_LINES = 2000;
const MAX_READ_BYTES = 50 * 1024;
const MAX_GREP_MATCHES = 100;
const MAX_GREP_LINE_LENGTH = 500;
const MAX_GLOB_RESULTS = 1000;

export const BUILTIN_TOOL_NAMES = new Set([
	'read',
	'write',
	'edit',
	'bash',
	'grep',
	'glob',
	'task',
]);

export interface TaskToolParams {
	prompt: string;
	description?: string;
	role?: string;
	cwd?: string;
}

export interface TaskToolResultDetails {
	taskId: string;
	sessionId: string;
	messageId?: string;
	role?: string;
	cwd?: string;
}

export interface CreateToolsOptions {
	task?: (
		params: TaskToolParams,
		signal?: AbortSignal,
	) => Promise<AgentToolResult<TaskToolResultDetails>>;
	roles?: Record<string, Role>;
}

export function createTools(env: SessionEnv, options?: CreateToolsOptions): AgentTool<any>[] {
	const tools: AgentTool<any>[] = [
		createReadTool(env),
		createWriteTool(env),
		createEditTool(env),
		createBashTool(env),
		createGrepTool(env),
		createGlobTool(env),
	];
	if (options?.task) tools.push(createTaskTool(options.task, options.roles ?? {}));
	return tools;
}

const ReadParams = Type.Object({
	path: Type.String({ description: 'Path to the file to read' }),
	offset: Type.Optional(Type.Number({ description: 'Line number to start from (1-indexed)' })),
	limit: Type.Optional(Type.Number({ description: 'Maximum number of lines to read' })),
});

function createReadTool(env: SessionEnv): AgentTool<typeof ReadParams> {
	return {
		name: 'read',
		label: 'Read File',
		description:
			'Read a file or list a directory. For files, output is truncated to 2000 lines or 50KB — use offset/limit for large files. For directories, returns the list of entries.',
		parameters: ReadParams,
		async execute(_toolCallId: string, params: Static<typeof ReadParams>, signal?: AbortSignal) {
			throwIfAborted(signal);

			try {
				const fileStat = await env.stat(params.path);
				if (fileStat.isDirectory) {
					const entries = await env.readdir(params.path);
					const listing = entries.join('\n');
					return {
						content: [{ type: 'text', text: listing || '(empty directory)' }],
						details: { path: params.path, isDirectory: true, entries: entries.length },
					};
				}
			} catch {
				// stat failed — fall through to readFile
			}

			const content = await env.readFile(params.path);
			const allLines = content.split('\n');

			const startLine = params.offset ? Math.max(0, params.offset - 1) : 0;
			if (startLine >= allLines.length) {
				throw new Error(
					`Offset ${params.offset} is beyond end of file (${allLines.length} lines total)`,
				);
			}

			const endLine = params.limit ? startLine + params.limit : allLines.length;
			const lines = allLines.slice(startLine, endLine);
			const { text: truncatedText, wasTruncated } = truncateHead(
				lines,
				MAX_READ_LINES,
				MAX_READ_BYTES,
			);

			let output = truncatedText;
			if (wasTruncated) {
				const shownEnd = startLine + truncatedText.split('\n').length;
				output += `\n\n[Showing lines ${startLine + 1}-${shownEnd} of ${allLines.length}. Use offset=${shownEnd + 1} to continue.]`;
			}

			return {
				content: [{ type: 'text', text: output }],
				details: { path: params.path, lines: allLines.length },
			};
		},
	};
}

const WriteParams = Type.Object({
	path: Type.String({ description: 'Path to the file to write' }),
	content: Type.String({ description: 'Content to write to the file' }),
});

function createWriteTool(env: SessionEnv): AgentTool<typeof WriteParams> {
	return {
		name: 'write',
		label: 'Write File',
		description:
			'Write content to a file. Creates the file and parent directories if they do not exist.',
		parameters: WriteParams,
		async execute(_toolCallId: string, params: Static<typeof WriteParams>, signal?: AbortSignal) {
			throwIfAborted(signal);
			const resolved = env.resolvePath(params.path);
			const dir = resolved.replace(/\/[^/]*$/, '');
			if (dir && dir !== resolved) {
				await env.mkdir(dir, { recursive: true });
			}
			await env.writeFile(resolved, params.content);
			return {
				content: [
					{
						type: 'text',
						text: `Successfully wrote ${params.content.length} bytes to ${params.path}`,
					},
				],
				details: { path: params.path, size: params.content.length },
			};
		},
	};
}

const EditParams = Type.Object({
	path: Type.String({ description: 'Path to the file to edit' }),
	oldText: Type.String({ description: 'Exact text to find (must be unique)' }),
	newText: Type.String({ description: 'Replacement text' }),
	replaceAll: Type.Optional(Type.Boolean({ description: 'Replace all occurrences' })),
});

function createEditTool(env: SessionEnv): AgentTool<typeof EditParams> {
	return {
		name: 'edit',
		label: 'Edit File',
		description:
			'Edit a file using exact text replacement. The oldText must match a unique region of the file. Use replaceAll to replace all occurrences.',
		parameters: EditParams,
		async execute(_toolCallId: string, params: Static<typeof EditParams>, signal?: AbortSignal) {
			throwIfAborted(signal);
			const content = await env.readFile(params.path);

			if (params.replaceAll) {
				const newContent = content.replaceAll(params.oldText, params.newText);
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

			const newContent = content.replace(params.oldText, params.newText);
			await env.writeFile(params.path, newContent);
			return {
				content: [{ type: 'text', text: `Successfully edited ${params.path}` }],
				details: { path: params.path },
			};
		},
	};
}

const BashParams = Type.Object({
	command: Type.String({ description: 'Bash command to execute' }),
	timeout: Type.Optional(Type.Number({ description: 'Timeout in seconds' })),
});

function createBashTool(env: SessionEnv): AgentTool<typeof BashParams> {
	return {
		name: 'bash',
		label: 'Run Command',
		description:
			'Execute a bash command. Returns stdout and stderr. Output is truncated to the last 2000 lines or 50KB.',
		parameters: BashParams,
		async execute(_toolCallId: string, params: Static<typeof BashParams>, signal?: AbortSignal) {
			throwIfAborted(signal);
			const result = await env.exec(params.command, { timeout: params.timeout, signal });
			return formatBashResult(result, params.command);
		},
	};
}

const TaskParams = Type.Object({
	description: Type.Optional(
		Type.String({ description: 'Short human-readable label for the delegated work' }),
	),
	prompt: Type.String({ description: 'Focused instructions for the child agent' }),
	role: Type.Optional(Type.String({ description: 'Role to use for the child agent' })),
	cwd: Type.Optional(
		Type.String({
			description:
				'Working directory for the child agent. AGENTS.md and skills are discovered from here.',
		}),
	),
});

function createTaskTool(
	runTask: (
		params: TaskToolParams,
		signal?: AbortSignal,
	) => Promise<AgentToolResult<TaskToolResultDetails>>,
	roles: Record<string, Role>,
): AgentTool<typeof TaskParams> {
	const roleNames = Object.keys(roles);
	const roleDescription =
		roleNames.length > 0
			? ` Available roles: ${roleNames.join(', ')}.`
			: ' No roles are currently defined.';

	return {
		name: 'task',
		label: 'Run Task',
		description:
			'Delegate a focused task to a detached child agent with its own context. ' +
			'Use this for independent research, file exploration, or parallel work. ' +
			'The task returns only its final answer to this conversation.' +
			roleDescription,
		parameters: TaskParams,
		async execute(_toolCallId: string, params: Static<typeof TaskParams>, signal?: AbortSignal) {
			throwIfAborted(signal);
			return runTask(params, signal);
		},
	};
}

export function formatBashResult(
	result: { stdout: string; stderr: string; exitCode: number },
	command: string,
): AgentToolResult<any> {
	const combined = (result.stdout + (result.stderr ? '\n' + result.stderr : '')).trim();
	const { text: output } = truncateTail(combined, MAX_READ_LINES, MAX_READ_BYTES);
	const exitLine = `Command exited with code ${result.exitCode}`;

	return {
		content: [
			{
				type: 'text',
				text: result.exitCode === 0 ? output || '(no output)' : `${output || '(no output)'}\n\n${exitLine}`,
			},
		],
		details: { command, exitCode: result.exitCode },
	};
}

const GrepParams = Type.Object({
	pattern: Type.String({ description: 'Search pattern (regex)' }),
	path: Type.Optional(Type.String({ description: 'Directory or file to search (default: .)' })),
	include: Type.Optional(Type.String({ description: 'Glob filter, e.g. "*.ts"' })),
});

function createGrepTool(env: SessionEnv): AgentTool<typeof GrepParams> {
	return {
		name: 'grep',
		label: 'Search Files',
		description:
			'Search file contents for a regex pattern. Returns matching lines with file paths and line numbers.',
		parameters: GrepParams,
		async execute(_toolCallId: string, params: Static<typeof GrepParams>, signal?: AbortSignal) {
			throwIfAborted(signal);

			const searchPath = params.path || '.';
			let cmd = `grep -rn ${shellQuote(params.pattern)} ${shellQuote(searchPath)}`;
			if (params.include) {
				cmd = `grep -rn --include=${shellQuote(params.include)} ${shellQuote(params.pattern)} ${shellQuote(searchPath)}`;
			}

			const result = await env.exec(cmd);

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
					line.length > MAX_GREP_LINE_LENGTH ? line.slice(0, MAX_GREP_LINE_LENGTH) + '...' : line,
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

function createGlobTool(env: SessionEnv): AgentTool<typeof GlobParams> {
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
			const result = await env.exec(cmd);

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

function countOccurrences(str: string, substr: string): number {
	let count = 0;
	let pos = str.indexOf(substr, 0);
	while (pos !== -1) {
		count++;
		pos = str.indexOf(substr, pos + substr.length);
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
): { text: string; wasTruncated: boolean } {
	let result = '';
	let lineCount = 0;
	let wasTruncated = false;

	for (const line of lines) {
		if (lineCount >= maxLines) {
			wasTruncated = true;
			break;
		}
		const next = lineCount === 0 ? line : '\n' + line;
		if (result.length + next.length > maxBytes) {
			wasTruncated = true;
			break;
		}
		result += next;
		lineCount++;
	}

	return { text: result, wasTruncated };
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
