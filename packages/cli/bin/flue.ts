#!/usr/bin/env node
import { type ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import path from 'node:path';
import { determineAgent } from '@vercel/detect-agent';
import { build } from '../src/lib/build.ts';
import {
	type FlueConfig,
	resolveConfig,
	resolveConfigPath,
	type UserFlueConfig,
} from '../src/lib/config.ts';
import { DEFAULT_DEV_PORT, dev, parseEnvFiles, resolveEnvFiles } from '../src/lib/dev.ts';
import { CATEGORY_ROOTS, CONNECTORS } from './_connectors.generated.ts';

/** Resolve CLI flags, config file values, and defaults into one config. */
async function resolveCliConfig(args: {
	target?: 'node' | 'cloudflare';
	explicitRoot: string | undefined;
	explicitOutput: string | undefined;
	configFile: string | undefined;
}): Promise<FlueConfig> {
	const inline: UserFlueConfig = {};
	if (args.target) inline.target = args.target;
	if (args.explicitRoot) inline.root = args.explicitRoot;
	if (args.explicitOutput) inline.output = args.explicitOutput;

	try {
		const { flueConfig, configPath } = await resolveConfig({
			cwd: process.cwd(),
			searchFrom: args.explicitRoot ?? process.cwd(),
			configFile: args.configFile,
			inline,
		});
		if (configPath) {
			console.error(`[flue] Loaded config: ${path.relative(process.cwd(), configPath) || configPath}`);
		}
		return flueConfig;
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	}
}

// ─── Arg Parsing ────────────────────────────────────────────────────────────

function printUsage() {
	console.error(
		'Usage:\n' +
			'  flue dev   [--target <node|cloudflare>] [--root <path>] [--output <path>] [--config <path>] [--port <number>] [--env <path>]...\n' +
			'  flue run   <agent> [--target node] --id <id> [--payload <json>] [--root <path>] [--output <path>] [--config <path>] [--port <number>] [--env <path>]...\n' +
			'  flue build [--target <node|cloudflare>] [--root <path>] [--output <path>] [--config <path>]\n' +
			'  flue init  --target <node|cloudflare> [--root <path>] [--force]\n' +
			'  flue add   [<name>|<url>] [--category <category>] [--print]\n' +
			'  flue logs  <runId> [--server <url>] [--follow|-f|--no-follow] [--since <eventIndex>] [--types a,b,c] [--limit <n>] [--format pretty|json|ndjson]\n' +
			'\n' +
			'Commands:\n' +
			'  dev    Long-running watch-mode dev server. Rebuilds and reloads on file changes.\n' +
			'  run    One-shot build + invoke an agent (production-style; use for CI / scripted runs).\n' +
			'  build  Build a deployable artifact to ./dist (production deploys).\n' +
			'  init   Scaffold a starter flue.config.ts in the target directory.\n' +
			'  add    Install a connector. Pipes installation instructions for an AI coding agent to follow.\n' +
			'  logs   Tail or replay structured run events from a running Flue server. Read-only — does not invoke the agent.\n' +
			'\n' +
			'Flags:\n' +
			'  --root <path>        Project root. Default: current working directory.\n' +
			'                       Source files (agents/, roles/) live at <root>/.flue/ if that\n' +
			'                       directory exists, else at <root>/ directly.\n' +
			'  --output <path>      Where the build artifacts are written. Default: <root>/dist.\n' +
			'  --config <path>      Path to a flue.config.{ts,mts,mjs,js,cjs,cts} file (relative to cwd).\n' +
			'                       Default: search the root dir (or cwd) for `flue.config.*`.\n' +
			'                       CLI flags always override values set in the config file.\n' +
			`  --port <number>      Port for the dev server. Default: ${DEFAULT_DEV_PORT}\n` +
			'  --env <path>         Load env vars from a .env-format file. Repeatable; later files override earlier on key collision.\n' +
			'                       Works for both Node and Cloudflare targets. Shell-set env vars win over file values.\n' +
			'  --category <name>    (flue add) Fetch the generic instructions for a connector category. Pair with a positional URL/path that\n' +
			'                       points the agent at the provider\'s docs (e.g. `flue add https://e2b.dev --category sandbox`).\n' +
			'  --print              (flue add) Print the raw connector markdown to stdout regardless of whether the caller is an agent.\n' +
			'  --force              (flue init) Overwrite an existing flue.config.* in the target directory.\n' +
			'\n' +
			'Examples:\n' +
			'  flue dev --target node\n' +
			'  flue dev --target cloudflare --port 8787\n' +
			'  flue dev --target node --env .env\n' +
			'  flue run hello --target node --id test-1\n' +
			'  flue run hello --target node --id test-1 --payload \'{"name": "World"}\' --env .env\n' +
			'  flue build --target node\n' +
			'  flue build --target cloudflare --root ./my-app\n' +
			'  flue build --target node --output ./build\n' +
			'  flue init --target node\n' +
			'  flue add\n' +
			'  flue add daytona | claude\n' +
			'  flue add https://e2b.dev --category sandbox | claude\n' +
			'  flue logs run_01H...                              # tail a specific run\n' +
			'  flue logs run_01H... --no-follow                  # one-shot replay\n' +
			'  flue logs run_01H... --types tool_call,log,run_end --format json\n' +
			'\n' +
			'Note: set the model inside your agent via `init({ model: "provider/model-id" })` ' +
			'or per-call `{ model: ... }` on prompt/skill/task.',
	);
}

interface RunArgs {
	command: 'run';
	agent: string;
	/** May be undefined if the user is relying on `flue.config.ts` for `target`. */
	target: 'node' | undefined;
	id: string;
	payload: string;
	/** Explicit --root value, or undefined to default to cwd. */
	explicitRoot: string | undefined;
	/** Explicit --output value, or undefined to default to <root>/dist. */
	explicitOutput: string | undefined;
	/** Explicit --config value, or undefined to auto-discover. */
	configFile: string | undefined;
	port: number;
	/** Resolved absolute paths from --env flags (repeatable). */
	envFiles: string[];
}

interface BuildArgs {
	command: 'build';
	/** May be undefined if the user is relying on `flue.config.ts` for `target`. */
	target: 'node' | 'cloudflare' | undefined;
	/** Explicit --root value, or undefined to default to cwd. */
	explicitRoot: string | undefined;
	/** Explicit --output value, or undefined to default to <root>/dist. */
	explicitOutput: string | undefined;
	/** Explicit --config value, or undefined to auto-discover. */
	configFile: string | undefined;
}

interface DevArgs {
	command: 'dev';
	/** May be undefined if the user is relying on `flue.config.ts` for `target`. */
	target: 'node' | 'cloudflare' | undefined;
	/** Explicit --root value, or undefined to default to cwd. */
	explicitRoot: string | undefined;
	/** Explicit --output value, or undefined to default to <root>/dist. */
	explicitOutput: string | undefined;
	/** Explicit --config value, or undefined to auto-discover. */
	configFile: string | undefined;
	/** 0 = use the library default (DEFAULT_DEV_PORT). */
	port: number;
	/** Raw --env values, in order; resolved/validated by the dev library. */
	envFiles: string[];
}

interface AddArgs {
	command: 'add';
	/** Connector slug, or (with --category) the {{URL}} value to substitute into the category root markdown. */
	name: string;
	category: string;
	print: boolean;
}

interface InitArgs {
	command: 'init';
	target: 'node' | 'cloudflare';
	/** Explicit --root value, or undefined to default to cwd. Absolute when set. */
	explicitRoot: string | undefined;
	force: boolean;
}

interface LogsArgs {
	command: 'logs';
	runId: string;
	/** Base URL of the running Flue server. */
	server: string;
	/**
	 * Whether to keep streaming live events (`true`) or exit after the
	 * initial replay (`false`). `undefined` means "auto" — follow if the
	 * selected run is still active, replay-and-exit if it's already
	 * terminal. CLI flags `--follow` / `--no-follow` set it explicitly.
	 */
	follow: boolean | undefined;
	/** When set, treated as `Last-Event-ID` on the stream request. */
	since: number | undefined;
	/** Filter to a specific set of event types (comma-separated on the CLI). */
	types: ReadonlySet<string> | undefined;
	/** Cap event count for one-shot mode. Server applies it via `?limit=`. */
	limit: number | undefined;
	format: 'pretty' | 'json' | 'ndjson';
}

type ParsedArgs = RunArgs | BuildArgs | DevArgs | AddArgs | InitArgs | LogsArgs;

function parseFlags(flags: string[]): {
	target?: 'node' | 'cloudflare';
	id?: string;
	explicitRoot: string | undefined;
	explicitOutput: string | undefined;
	configFile: string | undefined;
	payload: string;
	port: number;
	envFiles: string[];
} {
	let target: 'node' | 'cloudflare' | undefined;
	let id: string | undefined;
	let explicitRoot: string | undefined;
	let explicitOutput: string | undefined;
	let configFile: string | undefined;
	let payload = '{}';
	let port = 0;
	const envFiles: string[] = [];

	for (let i = 0; i < flags.length; i++) {
		const arg = flags[i];
		if (arg === '--payload') {
			payload = flags[++i] ?? '';
			if (!payload) {
				console.error('Missing value for --payload');
				process.exit(1);
			}
		} else if (arg === '--target') {
			const targetFlag = flags[++i];
			if (!targetFlag) {
				console.error('Missing value for --target');
				process.exit(1);
			}
			if (targetFlag !== 'node' && targetFlag !== 'cloudflare') {
				console.error(`Invalid target: "${targetFlag}". Supported targets: node, cloudflare`);
				process.exit(1);
			}
			target = targetFlag;
		} else if (arg === '--id') {
			id = flags[++i];
			if (!id) {
				console.error('Missing value for --id');
				process.exit(1);
			}
		} else if (arg === '--root') {
			explicitRoot = flags[++i] ?? '';
			if (!explicitRoot) {
				console.error('Missing value for --root');
				process.exit(1);
			}
		} else if (arg === '--output') {
			explicitOutput = flags[++i] ?? '';
			if (!explicitOutput) {
				console.error('Missing value for --output');
				process.exit(1);
			}
		} else if (arg === '--config') {
			configFile = flags[++i] ?? '';
			if (!configFile) {
				console.error('Missing value for --config');
				process.exit(1);
			}
		} else if (arg === '--port') {
			const portStr = flags[++i];
			port = parseInt(portStr ?? '', 10);
			if (isNaN(port)) {
				console.error('Invalid value for --port');
				process.exit(1);
			}
		} else if (arg === '--env') {
			const value = flags[++i];
			if (!value) {
				console.error('Missing value for --env');
				process.exit(1);
			}
			envFiles.push(value);
		} else {
			console.error(`Unknown argument: ${arg}`);
			printUsage();
			process.exit(1);
		}
	}

	return {
		target,
		id,
		explicitRoot: explicitRoot ? path.resolve(explicitRoot) : undefined,
		explicitOutput: explicitOutput ? path.resolve(explicitOutput) : undefined,
		// `--config` is intentionally NOT pre-resolved: the config loader
		// resolves it vs. cwd at load time, mirroring how Vite handles `--config`.
		configFile,
		payload,
		port,
		envFiles,
	};
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function printCloudflareRunUnsupported(agent: string, id: string, payload: string): never {
	console.error(
		'[flue] `flue run --target cloudflare` is not supported.\n\n' +
			'`flue run` is a one-shot Node.js invoker; Cloudflare builds need a Workers runtime.\n\n' +
			'For local development of a Cloudflare target, use `flue dev`:\n\n' +
			`  flue dev --target cloudflare\n\n` +
			`Then in another terminal:\n\n` +
			`  curl http://localhost:${DEFAULT_DEV_PORT}/agents/${agent}/${id} \\\n` +
			'    -H "Content-Type: application/json" \\\n' +
			`    -d ${shellQuote(payload)}`,
	);
	process.exit(1);
}

function parseAddArgs(rest: string[]): AddArgs {
	let name = '';
	let category = '';
	let print = false;

	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i]!;
		if (arg === '--category') {
			const value = rest[++i];
			if (!value) {
				console.error('Missing value for --category');
				process.exit(1);
			}
			category = value;
		} else if (arg === '--print') {
			print = true;
		} else if (arg.startsWith('--')) {
			console.error(`Unknown flag for \`flue add\`: ${arg}`);
			printUsage();
			process.exit(1);
		} else {
			if (name) {
				console.error(`Unexpected extra argument for \`flue add\`: ${arg}`);
				printUsage();
				process.exit(1);
			}
			name = arg;
		}
	}

	if (category && !name) {
		console.error(
			`\`flue add --category ${category}\` requires a URL or path argument — the user-provided ` +
				`starting point for the agent's research.\n\n` +
				`Example:\n` +
				`  flue add https://e2b.dev --category ${category} | claude`,
		);
		process.exit(1);
	}

	return { command: 'add', name, category, print };
}

function parseLogsArgs(rest: string[]): LogsArgs {
	const positional: string[] = [];
	let server = `http://127.0.0.1:${DEFAULT_DEV_PORT}`;
	let follow: boolean | undefined;
	let since: number | undefined;
	let types: ReadonlySet<string> | undefined;
	let limit: number | undefined;
	let format: LogsArgs['format'] = 'pretty';

	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i]!;
		if (arg === '--server') {
			const value = rest[++i];
			if (!value) {
				console.error('Missing value for --server');
				process.exit(1);
			}
			server = value;
		} else if (arg === '--follow' || arg === '-f') {
			follow = true;
		} else if (arg === '--no-follow') {
			follow = false;
		} else if (arg === '--since') {
			const value = rest[++i];
			const parsed = Number.parseInt(value ?? '', 10);
			if (!Number.isFinite(parsed) || parsed < 0) {
				console.error('Invalid value for --since (expected a non-negative integer eventIndex)');
				process.exit(1);
			}
			since = parsed;
		} else if (arg === '--types') {
			const value = rest[++i];
			if (!value) {
				console.error('Missing value for --types');
				process.exit(1);
			}
			const parts = value
				.split(',')
				.map((t) => t.trim())
				.filter(Boolean);
			if (parts.length > 0) types = new Set(parts);
		} else if (arg === '--limit') {
			const value = rest[++i];
			const parsed = Number.parseInt(value ?? '', 10);
			if (!Number.isFinite(parsed) || parsed <= 0) {
				console.error('Invalid value for --limit (expected a positive integer)');
				process.exit(1);
			}
			limit = parsed;
		} else if (arg === '--format') {
			const value = rest[++i];
			if (value !== 'pretty' && value !== 'json' && value !== 'ndjson') {
				console.error(`Invalid value for --format: "${value}". Allowed: pretty, json, ndjson`);
				process.exit(1);
			}
			format = value;
		} else if (arg.startsWith('--')) {
			console.error(`Unknown flag for \`flue logs\`: ${arg}`);
			printUsage();
			process.exit(1);
		} else {
			positional.push(arg);
		}
	}

	if (positional.length < 1) {
		console.error('Missing required argument for `flue logs`: <runId>');
		printUsage();
		process.exit(1);
	}
	if (positional.length > 1) {
		console.error(`Unexpected extra arguments for \`flue logs\`: ${positional.slice(1).join(' ')}`);
		printUsage();
		process.exit(1);
	}

	return {
		command: 'logs',
		runId: positional[0]!,
		server,
		follow,
		since,
		types,
		limit,
		format,
	};
}

function parseInitArgs(rest: string[]): InitArgs {
	let target: 'node' | 'cloudflare' | undefined;
	let explicitRoot: string | undefined;
	let force = false;

	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i]!;
		if (arg === '--target') {
			const value = rest[++i];
			if (!value) {
				console.error('Missing value for --target');
				process.exit(1);
			}
			if (value !== 'node' && value !== 'cloudflare') {
				console.error(`Invalid target: "${value}". Supported targets: node, cloudflare`);
				process.exit(1);
			}
			target = value;
		} else if (arg === '--root') {
			const value = rest[++i];
			if (!value) {
				console.error('Missing value for --root');
				process.exit(1);
			}
			explicitRoot = path.resolve(value);
		} else if (arg === '--force') {
			force = true;
		} else if (arg.startsWith('--')) {
			console.error(`Unknown flag for \`flue init\`: ${arg}`);
			printUsage();
			process.exit(1);
		} else {
			console.error(`Unexpected argument for \`flue init\`: ${arg}`);
			printUsage();
			process.exit(1);
		}
	}

	if (!target) {
		console.error('Missing required --target flag for init command.');
		printUsage();
		process.exit(1);
	}

	return { command: 'init', target, explicitRoot, force };
}

function parseArgs(argv: string[]): ParsedArgs {
	const [command, ...rest] = argv;

	if (command === 'add') {
		return parseAddArgs(rest);
	}

	if (command === 'init') {
		return parseInitArgs(rest);
	}

	if (command === 'logs') {
		return parseLogsArgs(rest);
	}

	// `--target` is optional at parse time — the config file may supply it.
	// `resolveCliConfig` enforces it being set somewhere by the time we need it.

	if (command === 'build') {
		const flags = parseFlags(rest);
		return {
			command: 'build',
			target: flags.target,
			explicitRoot: flags.explicitRoot,
			explicitOutput: flags.explicitOutput,
			configFile: flags.configFile,
		};
	}

	if (command === 'dev') {
		const flags = parseFlags(rest);
		return {
			command: 'dev',
			target: flags.target,
			explicitRoot: flags.explicitRoot,
			explicitOutput: flags.explicitOutput,
			configFile: flags.configFile,
			port: flags.port,
			envFiles: flags.envFiles,
		};
	}

	if (command === 'run' && rest.length > 0) {
		const agent = rest[0]!;
		const flags = parseFlags(rest.slice(1));

		// `flue run` only supports node. If the user explicitly asked for
		// cloudflare on the CLI, bail with the usual usage hint. The case
		// where `flue.config.ts` sets `target: cloudflare` is handled later
		// in `run()` after config resolution.
		if (flags.target === 'cloudflare') {
			printCloudflareRunUnsupported(agent, flags.id ?? '<id>', flags.payload);
		}

		if (!flags.id) {
			console.error('Missing required --id flag for run command.');
			printUsage();
			process.exit(1);
		}

		try {
			JSON.parse(flags.payload);
		} catch {
			console.error(`Invalid JSON for --payload: ${flags.payload}`);
			process.exit(1);
		}

		return {
			command: 'run',
			agent,
			target: flags.target as 'node' | undefined,
			id: flags.id,
			payload: flags.payload,
			explicitRoot: flags.explicitRoot,
			explicitOutput: flags.explicitOutput,
			configFile: flags.configFile,
			port: flags.port,
			envFiles: flags.envFiles,
		};
	}

	printUsage();
	process.exit(1);
}

// ─── SSE Consumer ───────────────────────────────────────────────────────────

let textBuffer = '';
let thinkingBuffer = '';

function flushTextBuffer() {
	if (textBuffer) {
		for (const line of textBuffer.split('\n')) {
			if (line) console.error(`  ${line}`);
		}
		textBuffer = '';
	}
}

function flushThinkingBuffer() {
	if (thinkingBuffer) {
		for (const line of thinkingBuffer.split('\n')) {
			if (line) console.error(`\x1b[2m  ${line}\x1b[0m`);
		}
		thinkingBuffer = '';
	}
}

function flushBuffers() {
	flushTextBuffer();
	flushThinkingBuffer();
}

function logEvent(event: any) {
	switch (event.type) {
		case 'text_delta': {
			flushThinkingBuffer();
			const combined = textBuffer + (event.text ?? '');
			const lines = combined.split('\n');
			textBuffer = lines.pop() ?? '';
			for (const line of lines) {
				console.error(`  ${line}`);
			}
			break;
		}

		case 'thinking_start':
			flushTextBuffer();
			console.error('\x1b[2m[flue] thinking:start\x1b[0m');
			break;

		case 'thinking_delta': {
			flushTextBuffer();
			const combined = thinkingBuffer + (event.delta ?? '');
			const lines = combined.split('\n');
			thinkingBuffer = lines.pop() ?? '';
			for (const line of lines) {
				if (line) console.error(`\x1b[2m  ${line}\x1b[0m`);
			}
			break;
		}

		case 'thinking_end':
			flushThinkingBuffer();
			break;

		case 'tool_start': {
			flushBuffers();
			let toolDetail = event.toolName;
			if (event.args) {
				if (event.toolName === 'bash' && event.args.command) {
					toolDetail += `  $ ${event.args.command.length > 120 ? event.args.command.slice(0, 120) + '...' : event.args.command}`;
				} else if (event.toolName === 'read' && event.args.path) {
					toolDetail += `  ${event.args.path}`;
				} else if (event.toolName === 'write' && event.args.path) {
					toolDetail += `  ${event.args.path}`;
				} else if (event.toolName === 'edit' && event.args.path) {
					toolDetail += `  ${event.args.path}`;
				} else if (event.toolName === 'grep' && event.args.pattern) {
					toolDetail += `  ${event.args.pattern}`;
				} else if (event.toolName === 'glob' && event.args.pattern) {
					toolDetail += `  ${event.args.pattern}`;
				}
			}
			console.error(`[flue] tool:start  ${toolDetail}`);
			break;
		}

		case 'tool_call': {
			const status = event.isError ? 'error' : 'done';
			let resultPreview = '';
			if (event.result?.content?.[0]?.text) {
				const text = event.result.content[0].text as string;
				if (text.length > 200) {
					resultPreview = `  (${text.length} chars)`;
				} else if (event.isError) {
					resultPreview = `  ${text}`;
				}
			}
			console.error(`[flue] tool:${status}   ${event.toolName}${resultPreview}`);
			break;
		}

		case 'turn':
			flushBuffers();
			break;

		case 'compaction_start':
			flushBuffers();
			console.error(
				`[flue] compaction:start  reason=${event.reason} tokens=${event.estimatedTokens}`,
			);
			break;

		case 'compaction':
			console.error(
				`[flue] compaction:done   messages: ${event.messagesBefore} → ${event.messagesAfter}`,
			);
			break;

		case 'log':
			flushBuffers();
			console.error(`[flue] ${event.level ?? 'info'}: ${event.message ?? ''}`);
			break;

		case 'idle':
			flushBuffers();
			break;

		case 'error':
			flushBuffers();
			// Envelope: { type: 'error', error: { type, message, details, dev?, meta? } }
			// `dev` is only present when the server is in local/dev mode —
			// `flue run` always is, so we render it whenever it's present.
			console.error(`[flue] ERROR [${event.error?.type ?? 'unknown'}]: ${event.error?.message ?? ''}`);
			if (event.error?.details) {
				for (const line of String(event.error.details).split('\n')) {
					if (line) console.error(`  ${line}`);
				}
			}
			if (event.error?.dev) {
				for (const line of String(event.error.dev).split('\n')) {
					if (line) console.error(`  ${line}`);
				}
			}
			break;

		case 'run_start':
		case 'run_end':
			// `flue run` extracts the final result/error from `run_end`
			// in `consumeSSE` before reaching this renderer. `run_start`
			// is uninteresting in single-run-mode output. Skipped here.
			break;

		case 'operation_start':
		case 'operation':
			// Structural lifecycle events. `flue run` is a one-shot,
			// linear consumer that already shows tool I/O and text
			// streaming inline; operation banners would be noise.
			// `flue logs --format pretty` renders them via
			// `logsRenderPretty`.
			break;
	}
}

async function consumeSSE(
	url: string,
	payload: string,
	signal: AbortSignal,
): Promise<{ result?: any; error?: string }> {
	const res = await fetch(url, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Accept: 'text/event-stream',
		},
		body: payload,
		signal,
	});

	if (!res.ok) {
		// Flue's HTTP layer returns the canonical error envelope:
		//   { error: { type, message, details, dev?, meta? } }
		// A non-Flue upstream (CDN, load balancer, proxy) might intercept the
		// request and return text/plain or some other shape — fall back to
		// including the raw body in that case so the user still gets
		// something useful.
		const rawBody = await res.text();
		try {
			const parsed = JSON.parse(rawBody);
			if (parsed && typeof parsed === 'object' && parsed.error) {
				const e = parsed.error;
				const lines: string[] = [`HTTP ${res.status} [${e.type ?? 'unknown'}]: ${e.message ?? ''}`];
				if (e.details) {
					for (const line of String(e.details).split('\n')) {
						if (line) lines.push(`  ${line}`);
					}
				}
				if (e.dev) {
					for (const line of String(e.dev).split('\n')) {
						if (line) lines.push(`  ${line}`);
					}
				}
				return { error: lines.join('\n') };
			}
		} catch {
			// fall through to raw-body fallback
		}
		return { error: `HTTP ${res.status}: ${rawBody}` };
	}

	if (!res.body) {
		return { error: 'No response body' };
	}

	const runId = res.headers.get('x-flue-run-id');
	if (runId) console.error(`[flue] Run ID: ${runId}`);

	const decoder = new TextDecoder();
	let buffer = '';
	let result: any ;
	let error: string | undefined;

	for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
		if (signal.aborted) break;

		buffer += decoder.decode(chunk, { stream: true });
		const parts = buffer.split('\n\n');
		buffer = parts.pop() ?? '';

		for (const part of parts) {
			if (!part.trim()) continue;

			const dataLines: string[] = [];
			for (const line of part.split('\n')) {
				if (line.startsWith('data: ')) {
					dataLines.push(line.slice(6));
				} else if (line.startsWith('data:')) {
					dataLines.push(line.slice(5));
				}
			}
			if (dataLines.length === 0) continue;

			let event: any;
			try {
				event = JSON.parse(dataLines.join('\n'));
			} catch {
				continue;
			}

			if (event.type === 'run_end') {
				if (event.isError) {
					const e = event.error ?? {};
					if (typeof e === 'object' && e !== null) {
						const message = (e as { message?: unknown }).message;
						error = typeof message === 'string' ? message : 'Unknown error';
					} else {
						error = String(e || 'Unknown error');
					}
				} else {
					result = event.result;
				}
			} else if (event.type === 'error') {
				// Envelope: { type: 'error', error: { type, message, details, dev?, meta? } }
				const e = event.error ?? {};
				const messageParts: string[] = [];
				if (e.type) messageParts.push(`[${e.type}]`);
				if (e.message) messageParts.push(e.message);
				error = messageParts.length > 0 ? messageParts.join(' ') : 'Unknown error';
				if (e.details) error += '\n' + String(e.details);
				if (e.dev) error += '\n' + String(e.dev);
				logEvent(event);
			} else {
				logEvent(event);
			}
		}
	}

	flushBuffers();
	return error ? { error } : { result };
}

// ─── Server Management ─────────────────────────────────────────────────────

let serverProcess: ChildProcess | undefined;

function startServer(
	serverPath: string,
	port: number,
	env: Record<string, string>,
	cwd?: string,
): ChildProcess {
	return spawn('node', [serverPath], {
		stdio: ['ignore', 'pipe', 'pipe'],
		cwd,
		// FLUE_MODE=local signals the generated server to allow invocation of
		// any registered agent (including trigger-less CI-only agents). Without
		// this flag, the server enforces the `webhook: true` gate — which is
		// the correct behavior for production deployments, but would prevent
		// `flue run` from working with CI-only agents.
		//
		// Merge order: env-file values first, then `process.env` (so shell
		// vars win on key collision — matches dotenv-cli convention), then
		// our explicit Flue overrides last (PORT/FLUE_MODE always win).
		env: { ...env, ...process.env, PORT: String(port), FLUE_MODE: 'local' },
	});
}

/** True when fetch failed before the child server accepted connections. */
function isConnectionRefusedError(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	const cause = (err as { cause?: { code?: string; message?: string } }).cause;
	if (cause?.code === 'ECONNREFUSED') return true;
	if (typeof cause?.message === 'string' && cause.message.includes('ECONNREFUSED')) return true;
	return err.message.includes('ECONNREFUSED');
}

function stopServer() {
	if (serverProcess && !serverProcess.killed) {
		serverProcess.kill('SIGTERM');
	}
	serverProcess = undefined;
}

// ─── Find Available Port ────────────────────────────────────────────────────

async function findPort(): Promise<number> {
	const { createServer } = await import('node:net');
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.listen(0, () => {
			const addr = server.address();
			if (addr && typeof addr === 'object') {
				const port = addr.port;
				server.close(() => resolve(port));
			} else {
				server.close(() => reject(new Error('Could not determine port')));
			}
		});
		server.on('error', reject);
	});
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function buildCommand(args: BuildArgs) {
	const cfg = await resolveCliConfig({
		target: args.target,
		explicitRoot: args.explicitRoot,
		explicitOutput: args.explicitOutput,
		configFile: args.configFile,
	});
	try {
		await build({
			root: cfg.root,
			output: cfg.output,
			target: cfg.target,
		});
	} catch (err) {
		console.error(`[flue] Build failed:`, err instanceof Error ? err.message : String(err));
		process.exit(1);
	}
}

async function devCommand(args: DevArgs) {
	const cfg = await resolveCliConfig({
		target: args.target,
		explicitRoot: args.explicitRoot,
		explicitOutput: args.explicitOutput,
		configFile: args.configFile,
	});
	try {
		// dev() blocks until SIGINT/SIGTERM exits the process. We don't expect
		// it to return; if it ever does, just exit cleanly.
		await dev({
			root: cfg.root,
			output: cfg.output,
			target: cfg.target,
			port: args.port || undefined,
			envFiles: args.envFiles,
		});
	} catch (err) {
		console.error(`[flue] Dev server failed:`, err instanceof Error ? err.message : String(err));
		process.exit(1);
	}
}

async function run(args: RunArgs) {
	const cfg = await resolveCliConfig({
		target: args.target,
		explicitRoot: args.explicitRoot,
		explicitOutput: args.explicitOutput,
		configFile: args.configFile,
	});

	// `flue run` is Node-only. If the resolved target is cloudflare (which
	// can only happen via `flue.config.ts`, since the CLI flag was already
	// caught in parseArgs), bail with the same hint.
	if (cfg.target === 'cloudflare') {
		printCloudflareRunUnsupported(args.agent, args.id, args.payload);
	}

	const root = cfg.root;
	const output = cfg.output;
	const serverPath = path.join(output, 'server.mjs');

	// Resolve --env paths relative to the project root before building.
	let resolvedEnvFiles: string[];
	try {
		resolvedEnvFiles = resolveEnvFiles(args.envFiles, root);
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	}
	for (const f of resolvedEnvFiles) {
		console.error(`[flue] Loading env from: ${f}`);
	}
	const fileEnv = parseEnvFiles(resolvedEnvFiles);

	try {
		await build({ root, output, target: cfg.target });
	} catch (err) {
		console.error(`[flue] Build failed:`, err instanceof Error ? err.message : String(err));
		process.exit(1);
	}

	const port = args.port || (await findPort());

	// Run the child from the project root so it resolves user files there.
	console.error(`[flue] Starting server on port ${port}...`);
	serverProcess = startServer(serverPath, port, fileEnv, root);

	// Pipe server stdout/stderr for visibility
	const pipeServerOutput = (data: Buffer) => {
		const text = data.toString().trimEnd();
		for (const line of text.split('\n')) {
			// Filter out the server startup logs we already know about
			if (line.includes('[flue] Server listening') || line.includes('[flue] Available agents'))
				continue;
			if (line.includes('[flue] Agent-OS VM ready') || line.includes('[flue] Sandbox ready'))
				continue;
			if (line.includes('WARNING: Using local sandbox')) continue;
			if (line.trim()) console.error(line);
		}
	};
	serverProcess.stdout?.on('data', pipeServerOutput);
	serverProcess.stderr?.on('data', pipeServerOutput);

	// Retry the real request briefly while the child binds its port.
	console.error(`[flue] Running agent: ${args.agent}`);
	const sseAbort = new AbortController();
	let outcome: { result?: any; error?: string };

	const startupBudgetMs = 5000;
	const startupRetryMs = 100;
	const startedAt = Date.now();
	while (true) {
		try {
			outcome = await consumeSSE(
				`http://localhost:${port}/agents/${args.agent}/${args.id}`,
				args.payload,
				sseAbort.signal,
			);
			break;
		} catch (err) {
			if (
				isConnectionRefusedError(err) &&
				Date.now() - startedAt < startupBudgetMs &&
				serverProcess?.exitCode === null
			) {
				await new Promise((resolve) => setTimeout(resolve, startupRetryMs));
				continue;
			}
			outcome = { error: err instanceof Error ? err.message : String(err) };
			break;
		}
	}

	if (outcome.error) {
		console.error(`[flue] Agent error: ${outcome.error}`);
		stopServer();
		process.exit(1);
	}

	if (outcome.result !== undefined && outcome.result !== null) {
		// Final result to stdout (everything else went to stderr)
		console.log(JSON.stringify(outcome.result, null, 2));
	}

	console.error('[flue] Done.');
	stopServer();
}

// ─── `flue logs` ────────────────────────────────────────────────────────────

interface RunRecord {
	runId: string;
	instanceId: string;
	agentName: string;
	status: 'active' | 'completed' | 'errored';
	startedAt: string;
	isError?: boolean;
	durationMs?: number;
}

/**
 * Fetch JSON from a Flue endpoint with the canonical error envelope. On
 * non-2xx, prints the envelope (or raw body fallback) to stderr and exits
 * the process with code 1 — `flue logs` is a one-shot CLI, so propagating
 * the error directly is simpler than threading it back to the caller.
 */
async function fetchJsonOrExit<T>(url: string): Promise<T> {
	let res: Response;
	try {
		res = await fetch(url);
	} catch (err) {
		console.error(`[flue] Failed to reach Flue server at ${url}: ${err instanceof Error ? err.message : String(err)}`);
		process.exit(1);
	}
	const rawBody = await res.text();
	if (!res.ok) {
		try {
			const parsed = JSON.parse(rawBody);
			if (parsed && typeof parsed === 'object' && parsed.error) {
				const e = parsed.error;
				console.error(`HTTP ${res.status} [${e.type ?? 'unknown'}]: ${e.message ?? ''}`);
				if (e.details) {
					for (const line of String(e.details).split('\n')) {
						if (line) console.error(`  ${line}`);
					}
				}
				process.exit(1);
			}
		} catch {
			// fall through to raw-body fallback
		}
		console.error(`HTTP ${res.status}: ${rawBody}`);
		process.exit(1);
	}
	try {
		return JSON.parse(rawBody) as T;
	} catch {
		console.error(`[flue] Failed to parse JSON from ${url}: ${rawBody.slice(0, 256)}`);
		process.exit(1);
	}
}

function formatDuration(ms: number | undefined): string {
	if (ms === undefined) return '';
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
	const m = Math.floor(ms / 60_000);
	const s = ((ms % 60_000) / 1000).toFixed(1);
	return `${m}m${s}s`;
}

/** Minimal SSE parser for Flue's JSON event stream. */
async function* iterateSse(res: Response): AsyncIterableIterator<{
	type: string;
	id: string | null;
	data: unknown;
}> {
	if (!res.body) return;
	const decoder = new TextDecoder();
	let buffer = '';
	let pendingEvent: string | null = null;
	let pendingId: string | null = null;
	let pendingData = '';
	for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
		buffer += decoder.decode(chunk, { stream: true });
		const lines = buffer.split('\n');
		buffer = lines.pop() ?? '';
		for (const line of lines) {
			if (line === '') {
				if (pendingEvent && pendingData) {
					let data: unknown;
					try {
						data = JSON.parse(pendingData);
					} catch {
						data = pendingData;
					}
					yield { type: pendingEvent, id: pendingId, data };
				}
				pendingEvent = null;
				pendingId = null;
				pendingData = '';
				continue;
			}
			if (line.startsWith(':')) continue;
			if (line.startsWith('event:')) pendingEvent = line.slice(6).trim();
			else if (line.startsWith('id:')) pendingId = line.slice(3).trim();
			else if (line.startsWith('data:')) pendingData += line.slice(5).trim();
		}
	}
}

/** Render a single event for `flue logs --format pretty`. */
function logsRenderPretty(event: Record<string, unknown>): void {
	const type = event.type;
	if (type === 'run_start') {
		const runId = String(event.runId ?? '');
		const agent = String(event.agentName ?? '');
		console.error(`[flue] run:start    ${runId}  agent=${agent}`);
		return;
	}
	if (type === 'run_end') {
		const runId = String(event.runId ?? '');
		const duration = formatDuration(
			typeof event.durationMs === 'number' ? event.durationMs : undefined,
		);
		if (event.isError) {
			const err = event.error as { message?: string } | undefined;
			console.error(`[flue] run:end      ${runId}  ERROR  ${err?.message ?? ''}  (${duration})`);
		} else {
			console.error(`[flue] run:end      ${runId}  ok  (${duration})`);
		}
		return;
	}
	if (type === 'operation_start' || type === 'operation') {
		const kind = String(event.operationKind ?? event.kind ?? '');
		const duration = formatDuration(
			typeof event.durationMs === 'number' ? event.durationMs : undefined,
		);
		const tag = type === 'operation_start' ? 'op:start' : 'op:done';
		console.error(`[flue] ${tag}      ${kind}${duration ? `  (${duration})` : ''}`);
		return;
	}
	logEvent(event);
}

async function logsCommand(args: LogsArgs): Promise<void> {
	const base = args.server.replace(/\/+$/, '');
	const runPath = `${base}/runs/${encodeURIComponent(args.runId)}`;

	let shouldFollow: boolean;
	if (args.follow !== undefined) {
		shouldFollow = args.follow;
	} else {
		const run = await fetchJsonOrExit<RunRecord>(runPath);
		shouldFollow = run.status === 'active';
	}

	// One-shot mode snapshots persisted events and exits immediately.
	if (!shouldFollow) {
		const url = new URL(`${runPath}/events`);
		if (args.since !== undefined) url.searchParams.set('after', String(args.since));
		if (args.types) url.searchParams.set('types', [...args.types].join(','));
		if (args.limit !== undefined) url.searchParams.set('limit', String(args.limit));
		const body = await fetchJsonOrExit<{ events: Array<Record<string, unknown>> }>(url.toString());
		let exitCode = 0;
		for (const event of body.events) {
			if (args.format === 'json' || args.format === 'ndjson') {
				process.stdout.write(`${JSON.stringify(event)}\n`);
			} else {
				logsRenderPretty(event);
			}
			if (event.type === 'run_end' && event.isError === true) exitCode = 2;
		}
		if (args.format === 'pretty') flushBuffers();
		process.exit(exitCode);
	}

	const streamUrl = new URL(`${runPath}/stream`);
	const headers: Record<string, string> = { accept: 'text/event-stream' };
	if (args.since !== undefined) headers['last-event-id'] = String(args.since);

	let res: Response;
	try {
		res = await fetch(streamUrl, { headers });
	} catch (err) {
		console.error(`[flue] Failed to reach Flue server: ${err instanceof Error ? err.message : String(err)}`);
		process.exit(1);
	}

	if (!res.ok) {
		const rawBody = await res.text();
		try {
			const parsed = JSON.parse(rawBody);
			if (parsed?.error) {
				const e = parsed.error;
				console.error(`HTTP ${res.status} [${e.type ?? 'unknown'}]: ${e.message ?? ''}`);
				process.exit(1);
			}
		} catch {
			// fall through
		}
		console.error(`HTTP ${res.status}: ${rawBody}`);
		process.exit(1);
	}

	const ac = new AbortController();
	const onSignal = () => ac.abort();
	process.on('SIGINT', onSignal);
	process.on('SIGTERM', onSignal);

	let emittedCount = 0;
	let exitCode = 0;

	try {
		for await (const frame of iterateSse(res)) {
			if (ac.signal.aborted) break;
			const event = frame.data as Record<string, unknown> | undefined;
			if (!event || typeof event !== 'object') continue;

			const passesFilter =
				!args.types ||
				(typeof event.type === 'string' && args.types.has(event.type));

			if (passesFilter) {
				if (args.format === 'json' || args.format === 'ndjson') {
					process.stdout.write(`${JSON.stringify(event)}\n`);
				} else {
					logsRenderPretty(event);
				}
				emittedCount++;
			}

			if (event.type === 'run_end' && event.isError === true) exitCode = 2;
			if (args.limit !== undefined && emittedCount >= args.limit) break;
		}
	} catch (err) {
		if (ac.signal.aborted) {
			exitCode = 130;
		} else {
			console.error(`[flue] Stream interrupted: ${err instanceof Error ? err.message : String(err)}`);
			exitCode = 1;
		}
	} finally {
		process.off('SIGINT', onSignal);
		process.off('SIGTERM', onSignal);
		if (args.format === 'pretty') flushBuffers();
	}

	process.exit(exitCode);
}

// ─── `flue init` ────────────────────────────────────────────────────────────

function renderConfigTemplate(target: 'node' | 'cloudflare'): string {
	return (
		`import { defineConfig } from '@flue/cli/config';\n` +
		`\n` +
		`export default defineConfig({\n` +
		`\ttarget: '${target}',\n` +
		`});\n`
	);
}

function initCommand(args: InitArgs) {
	const targetDir = args.explicitRoot ?? process.cwd();

	if (!fs.existsSync(targetDir)) {
		console.error(`[flue] Target directory does not exist: ${targetDir}`);
		process.exit(1);
	}

	// Detect any existing flue.config.* in the target dir, using the same
	// discovery rule the rest of the CLI uses. This catches `.mts`, `.js`,
	// etc. — not just `.ts`.
	let existing: string | undefined;
	try {
		existing = resolveConfigPath({ cwd: targetDir, configFile: undefined });
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	}

	if (existing && !args.force) {
		const rel = path.relative(process.cwd(), existing) || existing;
		console.error(
			`[flue] A Flue config already exists at ${rel}.\n` +
				`  Re-run with --force to overwrite.`,
		);
		process.exit(1);
	}

	const outPath = path.join(targetDir, 'flue.config.ts');
	const content = renderConfigTemplate(args.target);

	try {
		fs.writeFileSync(outPath, content);
	} catch (err) {
		console.error(`[flue] Failed to write ${outPath}: ${err instanceof Error ? err.message : String(err)}`);
		process.exit(1);
	}

	const relOut = path.relative(process.cwd(), outPath) || outPath;
	console.error(`[flue] Wrote ${relOut}`);

	// If --force overwrote a non-`.ts` variant, the new flue.config.ts will
	// take precedence (CONFIG_BASENAMES priority), but the old file still
	// sits on disk. Surface that so the user isn't surprised later.
	if (existing && path.basename(existing) !== 'flue.config.ts') {
		const relExisting = path.relative(process.cwd(), existing) || existing;
		console.error(
			`[flue] Note: ${relExisting} is still on disk. ` +
				`flue.config.ts now takes precedence; delete the old file if you no longer need it.`,
		);
	}

	console.error('');
	console.error('Next step:');
	console.error('');
	console.error('  fetch https://flueframework.com/start.md to create a new agent');
}

// ─── `flue add` ─────────────────────────────────────────────────────────────

// Default registry base. Can be overridden via FLUE_REGISTRY_URL for local
// development against `pnpm --filter @flue/www dev`. Internal-only env var;
// not part of any documented user-facing surface.
const DEFAULT_REGISTRY_URL = 'https://flueframework.com/cli/connectors';

function registryUrlFor(slug: string): string {
	const base = (process.env.FLUE_REGISTRY_URL ?? DEFAULT_REGISTRY_URL).replace(/\/+$/, '');
	return `${base}/${slug}.md`;
}

/**
 * Resolve a user-supplied name to a registered connector. Tries an exact
 * match (slug or alias) first, then falls back to a case-insensitive match.
 * Returns the matched connector entry, or undefined if nothing matched.
 */
function resolveConnector(name: string): (typeof CONNECTORS)[number] | undefined {
	// Exact: slug.
	const bySlug = CONNECTORS.find((c) => c.slug === name);
	if (bySlug) return bySlug;
	// Exact: alias.
	const byAlias = CONNECTORS.find((c) => c.aliases.includes(name));
	if (byAlias) return byAlias;
	// Case-insensitive fallback (slug or alias).
	const lower = name.toLowerCase();
	return CONNECTORS.find(
		(c) => c.slug.toLowerCase() === lower || c.aliases.some((a) => a.toLowerCase() === lower),
	);
}

/**
 * Render a 3-column table aligned by the longest entry. Simple and
 * intentionally unfussy — connector listings are always small.
 */
function renderConnectorTable(rows: { command: string; category: string; website: string }[]): string {
	if (rows.length === 0) return '  (none)';
	const cmdW = Math.max(...rows.map((r) => r.command.length));
	const catW = Math.max(...rows.map((r) => r.category.length));
	const gap = '     ';
	return rows
		.map((r) => `  ${r.command.padEnd(cmdW)}${gap}${r.category.padEnd(catW)}${gap}${r.website}`)
		.join('\n');
}

function categoryRootHint(): string {
	if (CATEGORY_ROOTS.length === 0) return '';
	const lines: string[] = [];
	lines.push('');
	lines.push(`Don't see what you need?`);
	for (const root of CATEGORY_ROOTS) {
		lines.push('');
		lines.push(`  flue add <url> --category ${root.category}`);
		lines.push(
			`    Build a ${root.category} connector from scratch. Pass a URL pointing at the`,
		);
		lines.push(
			`    provider's docs (homepage, SDK reference, GitHub repo, anything useful) as`,
		);
		lines.push(
			`    the agent's starting point. Pipe to your coding agent.`,
		);
	}
	return lines.join('\n');
}

function printListing(stream: NodeJS.WriteStream) {
	stream.write('flue add <name>\n\n');
	stream.write('Available connectors:\n');
	const rows = CONNECTORS.map((c) => ({
		command: `flue add ${c.slug}`,
		category: c.category,
		website: c.website,
	}));
	stream.write(renderConnectorTable(rows));
	stream.write('\n');
	const hint = categoryRootHint();
	if (hint) stream.write(hint + '\n');
}

function printUnknownConnector(name: string, stream: NodeJS.WriteStream) {
	stream.write(`Connector "${name}" not found.\n\n`);
	stream.write('Available connectors:\n');
	const rows = CONNECTORS.map((c) => ({
		command: `flue add ${c.slug}`,
		category: c.category,
		website: c.website,
	}));
	stream.write(renderConnectorTable(rows));
	stream.write('\n');
	if (CATEGORY_ROOTS.length > 0) {
		stream.write('\nTo build one from scratch with your coding agent:\n');
		for (const root of CATEGORY_ROOTS) {
			stream.write(`  flue add <url> --category ${root.category}\n`);
		}
	}
}

async function fetchConnectorMarkdown(slug: string): Promise<{ body: string } | { notFound: true }> {
	const url = registryUrlFor(slug);
	let res: Response;
	try {
		res = await fetch(url);
	} catch (err) {
		console.error(
			`[flue] Failed to reach the connector registry at ${url}.\n` +
				`  ${err instanceof Error ? err.message : String(err)}`,
		);
		process.exit(1);
	}
	if (res.status === 404) return { notFound: true };
	if (!res.ok) {
		console.error(`[flue] Connector registry returned HTTP ${res.status} for ${url}.`);
		process.exit(1);
	}
	return { body: await res.text() };
}

function printHumanInstructions(args: AddArgs) {
	const cmd = args.category
		? `flue add ${args.name} --category ${args.category}`
		: `flue add ${args.name}`;
	const stream = process.stderr;
	stream.write(`${cmd}\n\n`);
	stream.write('To install this connector, pipe it to your coding agent:\n\n');
	stream.write(`  ${cmd} --print | claude\n`);
	stream.write(`  ${cmd} --print | codex\n`);
	stream.write(`  ${cmd} --print | cursor-agent\n\n`);
	stream.write(`  ${cmd} --print | opencode\n`);
	stream.write(`  ${cmd} --print | pi\n`);
	stream.write('Or paste this prompt into any agent:\n\n');
	stream.write(`  Run "${cmd} --print" and follow the instructions.\n`);
}

async function addCommand(args: AddArgs) {
	if (!args.name && !args.category) {
		printListing(process.stderr);
		return;
	}

	if (args.category) {
		const root = CATEGORY_ROOTS.find((r) => r.category === args.category);
		if (!root) {
			console.error(
				`[flue] Unknown category "${args.category}". Known categories: ${
					CATEGORY_ROOTS.map((r) => r.category).join(', ') || '(none)'
				}`,
			);
			process.exit(1);
		}
		const result = await fetchConnectorMarkdown(args.category);
		if ('notFound' in result) {
			console.error(
				`[flue] The connector registry did not have markdown for category "${args.category}". ` +
					`Your installed CLI may be out of sync with the registry — try updating @flue/cli.`,
			);
			process.exit(1);
		}

		const body = result.body.replaceAll('{{URL}}', args.name);

		const isAgentMode =
			args.print || (await determineAgent().catch(() => ({ isAgent: false }))).isAgent === true;
		if (isAgentMode) {
			process.stdout.write(body);
			if (!body.endsWith('\n')) process.stdout.write('\n');
			return;
		}
		printHumanInstructions(args);
		return;
	}

	const known = resolveConnector(args.name);
	if (!known) {
		printUnknownConnector(args.name, process.stderr);
		process.exit(1);
	}

	const result = await fetchConnectorMarkdown(known.slug);
	if ('notFound' in result) {
		console.error(
			`[flue] The connector registry did not have markdown for "${known.slug}". ` +
				`Your installed CLI may be out of sync with the registry — try updating @flue/cli.`,
		);
		process.exit(1);
	}

	const isAgentMode =
		args.print || (await determineAgent().catch(() => ({ isAgent: false }))).isAgent === true;
	if (isAgentMode) {
		process.stdout.write(result.body);
		if (!result.body.endsWith('\n')) process.stdout.write('\n');
		return;
	}
	printHumanInstructions(args);
}

// ─── Entry Point ────────────────────────────────────────────────────────────

const args = parseArgs(process.argv.slice(2));

process.on('SIGINT', () => {
	stopServer();
	process.exit(130);
});

process.on('SIGTERM', () => {
	stopServer();
	process.exit(143);
});

if (args.command === 'build') {
	buildCommand(args);
} else if (args.command === 'dev') {
	devCommand(args);
} else if (args.command === 'add') {
	addCommand(args);
} else if (args.command === 'init') {
	initCommand(args);
} else if (args.command === 'logs') {
	logsCommand(args);
} else {
	run(args);
}
