import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { type Static, Type } from '@earendil-works/pi-ai';
import type { AgentProfile, PackagedSkillDirectory, SessionEnv } from './types.ts';

const MAX_READ_LINES = 2000;
const MAX_READ_BYTES = 50 * 1024;
const MAX_GREP_MATCHES = 100;
const MAX_GREP_LINE_LENGTH = 500;
const MAX_GLOB_RESULTS = 1000;
const BASE64_READ_LINE_LENGTH = 76;
const PACKAGED_SKILLS_ROOT = '/.flue/packaged-skills/';

export interface TaskToolParams {
	prompt: string;
	description?: string;
	agent?: string;
	cwd?: string;
}

export interface TaskToolResultDetails {
	taskId: string;
	session: string;
	messageId?: string;
	agent?: string;
	cwd?: string;
}

export interface CreateToolsOptions {
	task?: (
		params: TaskToolParams,
		signal?: AbortSignal,
	) => Promise<AgentToolResult<TaskToolResultDetails>>;
	subagents?: Record<string, AgentProfile>;
	packagedSkills?: Record<string, PackagedSkillDirectory>;
}

export function createTools(env: SessionEnv, options?: CreateToolsOptions): AgentTool<any>[] {
	const tools: AgentTool<any>[] = [
		createReadTool(env, options?.packagedSkills ?? {}),
		createWriteTool(env),
		createEditTool(env),
		createBashTool(env),
		createGrepTool(env),
		createGlobTool(env),
	];
	if (options?.task) tools.push(createTaskTool(options.task, options.subagents ?? {}));
	return tools;
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
		name: 'read',
		label: 'Read Packaged Skill File',
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

function createReadTool(
	env: SessionEnv,
	packagedSkills: Record<string, PackagedSkillDirectory>,
): AgentTool<typeof ReadParams> {
	return {
		name: 'read',
		label: 'Read File',
		description:
			'Read a file or list a directory. For files, output is truncated to 2000 lines or 50KB — use offset/limit for large files. For directories, returns the list of entries.',
		parameters: ReadParams,
		async execute(_toolCallId: string, params: Static<typeof ReadParams>, signal?: AbortSignal) {
			throwIfAborted(signal);

			const packagedFile = readPackagedSkillFile(packagedSkills, params.path);
			if (packagedFile !== undefined) {
				return formatReadContent(params.path, packagedFile, params.offset, params.limit);
			}
			if (params.path.startsWith(PACKAGED_SKILLS_ROOT)) {
				throw new Error(`[flue] Packaged skill file not found: ${params.path}`);
			}

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
			return formatReadContent(params.path, content, params.offset, params.limit);
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

			// Two layers cooperate to enforce `params.timeout`:
			//
			//   1. Pass `timeout` to env.exec as a hint. Sandbox connectors
			//      forward it to their provider's native timeout option
			//      (E2B `timeoutMs`, Daytona `timeout`, etc.) so signal-
			//      blind providers still observe the deadline with full
			//      fidelity. Bash factories translate it into a signal
			//      internally.
			//   2. Compose a local AbortSignal.timeout into `signal` as a
			//      backstop. Connectors that ignore both fields will at
			//      least see the merged signal aborted on the way out.
			//
			// On timeout we return a 124-shaped ShellResult so the model
			// can recover. On host abort we rethrow so the outer call
			// cancels. This timeout-as-recoverable-result behavior lives
			// here in the LLM-facing tool, not in SessionEnv/SandboxApi:
			// Programmatic callers express timeouts via AbortSignal.timeout(...) and
			// accept abort semantics; the model can only emit JSON, so it
			// needs `params.timeout` and a recoverable shape on timeout.
			const timeoutSignal =
				typeof params.timeout === 'number' ? AbortSignal.timeout(params.timeout * 1000) : undefined;
			const execSignal =
				signal && timeoutSignal
					? AbortSignal.any([signal, timeoutSignal])
					: (signal ?? timeoutSignal);

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
					timeout: params.timeout,
					signal: execSignal,
				});
				// Some connectors don't observe the signal mid-flight and
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
	agent: Type.Optional(
		Type.String({ description: 'Declared subagent to use for the child agent' }),
	),
	cwd: Type.Optional(
		Type.String({
			description:
				'Working directory for the child agent. AGENTS.md and skills are discovered from here.',
		}),
	),
});

/** Build Flue's framework-owned `task` tool. */
export function createTaskTool(
	runTask: (
		params: TaskToolParams,
		signal?: AbortSignal,
	) => Promise<AgentToolResult<TaskToolResultDetails>>,
	subagents: Record<string, AgentProfile>,
): AgentTool<typeof TaskParams> {
	const agentNames = Object.keys(subagents);
	const agentDescription =
		agentNames.length > 0
			? ` Available agents: ${agentNames.join(', ')}.`
			: ' No subagents are currently defined.';

	return {
		name: 'task',
		label: 'Run Task',
		description:
			'Delegate a focused task to a detached child agent with its own context. ' +
			'Use this for independent research, file exploration, or parallel work. ' +
			'The task returns only its final answer to this conversation.' +
			agentDescription,
		parameters: TaskParams,
		async execute(_toolCallId: string, params: Static<typeof TaskParams>, signal?: AbortSignal) {
			throwIfAborted(signal);
			return runTask(params, signal);
		},
	};
}

export function createActivateSkillTool(
	skillNames: string[],
	activate: (name: string, signal?: AbortSignal) => Promise<string>,
): AgentTool<any> {
	const sortedNames = [...skillNames].sort();
	const [firstName] = sortedNames;
	if (!firstName) {
		throw new Error('[flue] Cannot create activate_skill tool without available skills.');
	}
	const NameSchema =
		sortedNames.length === 1
			? Type.Literal(firstName)
			: Type.Union(sortedNames.map((name) => Type.Literal(name)));
	const ActivateSkillParams = Type.Object({
		name: NameSchema,
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
    pattern: Type.String({
        description:
            'Search pattern. Uses extended grep regex by default; set literal to true for exact string matching.',
    }),
    path: Type.Optional(Type.String({ description: 'Directory or file to search (default: .)' })),
    include: Type.Optional(Type.String({ description: 'Glob filter, e.g. "*.ts"' })),
    literal: Type.Optional(
        Type.Boolean({
            description:
                'Match pattern as a literal string instead of a regex. Use for code containing characters like ( ) | + ? { }.',
        }),
    ),
});

function createGrepTool(env: SessionEnv): AgentTool<typeof GrepParams> {
    return {
        name: 'grep',
        label: 'Search Files',
        description:
            'Search file contents. Patterns use extended grep regex by default; set literal for exact string matching. Returns matching lines with file paths and line numbers.',
        parameters: GrepParams,
        async execute(_toolCallId: string, params: Static<typeof GrepParams>, signal?: AbortSignal) {
            throwIfAborted(signal);
 
            const searchPath = params.path || '.';
            // Extended regex matches the flavor models naturally emit; literal uses fixed strings.
            const flags = params.literal ? '-rnF' : '-rnE';
            let cmd = `grep ${flags} ${shellQuote(params.pattern)} ${shellQuote(searchPath)}`;
            if (params.include) {
                cmd = `grep ${flags} --include=${shellQuote(params.include)} ${shellQuote(params.pattern)} ${shellQuote(searchPath)}`;
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

function readPackagedSkillFile(
	skills: Record<string, PackagedSkillDirectory>,
	path: string,
): string | undefined {
	for (const skill of Object.values(skills)) {
		for (const [filePath, file] of Object.entries(skill.files)) {
			if (path !== packagedSkillReadPath(skill.id, filePath)) continue;
			return file.kind === 'binary'
				? wrapBase64ForReading(file.content)
				: new TextDecoder().decode(
						Uint8Array.from(atob(file.content), (character) => character.charCodeAt(0)),
					);
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
	const { text: truncatedText, wasTruncated } = truncateHead(lines, MAX_READ_LINES, MAX_READ_BYTES);

	let output = truncatedText;
	if (wasTruncated) {
		const shownEnd = startLine + truncatedText.split('\n').length;
		output += `\n\n[Showing lines ${startLine + 1}-${shownEnd} of ${allLines.length}. Use offset=${shownEnd + 1} to continue.]`;
	}

	return {
		content: [{ type: 'text' as const, text: output }],
		details: { path, lines: allLines.length },
	};
}

export function formatPackagedSkillFilePath(skillId: string, filePath: string): string {
	return packagedSkillReadPath(skillId, filePath);
}

function packagedSkillReadPath(skillId: string, filePath: string): string {
	return `/.flue/packaged-skills/${encodeURIComponent(skillId)}/${filePath}`;
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
		const next = lineCount === 0 ? line : `\n${line}`;
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
