#!/usr/bin/env node
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { determineAgent } from '@vercel/detect-agent';
import { build, dev, DEFAULT_DEV_PORT, parseEnvFiles, resolveEnvFiles } from '@flue/sdk';
import { resolveConfig, type FlueConfig, type UserFlueConfig } from '@flue/sdk/config';
import { CONNECTORS, CATEGORY_ROOTS } from './_connectors.generated.ts';

/**
 * Resolve the merged config for a CLI command. The CLI's responsibility is
 * narrow:
 *
 *   1. Build the `inline` overrides from the flags the user actually passed
 *      (an unset flag means `undefined`, so the config file or default wins).
 *   2. Tell `resolveConfig` where to start searching for `flue.config.ts`:
 *      `--workspace` if given (mirrors Vite's `--root`), otherwise cwd.
 *   3. Hand back a fully-resolved {@link FlueConfig} for the rest of the
 *      command to consume.
 */
async function resolveCliConfig(args: {
	target?: 'node' | 'cloudflare';
	explicitWorkspace: string | undefined;
	explicitOutput: string | undefined;
	configFile: string | undefined;
}): Promise<FlueConfig> {
	const inline: UserFlueConfig = {};
	if (args.target) inline.target = args.target;
	if (args.explicitWorkspace) inline.workspace = args.explicitWorkspace;
	if (args.explicitOutput) inline.output = args.explicitOutput;

	try {
		const { flueConfig, configPath } = await resolveConfig({
			cwd: process.cwd(),
			searchFrom: args.explicitWorkspace ?? process.cwd(),
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
			'  flue dev   [--target <node|cloudflare>] [--workspace <path>] [--output <path>] [--config <path>] [--port <number>] [--env <path>]...\n' +
			'  flue run   <agent> [--target node] --id <id> [--payload <json>] [--workspace <path>] [--output <path>] [--config <path>] [--port <number>] [--env <path>]...\n' +
			'  flue build [--target <node|cloudflare>] [--workspace <path>] [--output <path>] [--config <path>]\n' +
			'  flue add   [<name>|<url>] [--category <category>] [--print]\n' +
			'\n' +
			'Commands:\n' +
			'  dev    Long-running watch-mode dev server. Rebuilds and reloads on file changes.\n' +
			'  run    One-shot build + invoke an agent (production-style; use for CI / scripted runs).\n' +
			'  build  Build a deployable artifact to ./dist (production deploys).\n' +
			'  add    Install a connector. Pipes installation instructions for an AI coding agent to follow.\n' +
			'\n' +
			'Flags:\n' +
			'  --workspace <path>   Workspace root. Default: current working directory.\n' +
			'                       Source files (agents/, roles/) live at <workspace>/.flue/ if that\n' +
			'                       directory exists, else at <workspace>/ directly.\n' +
			'  --output <path>      Where the build artifacts are written. Default: <workspace>/dist.\n' +
			'  --config <path>      Path to a flue.config.{ts,mts,mjs,js,cjs,cts} file (relative to cwd).\n' +
			'                       Default: search the workspace dir (or cwd) for `flue.config.*`.\n' +
			'                       CLI flags always override values set in the config file.\n' +
			`  --port <number>      Port for the dev server. Default: ${DEFAULT_DEV_PORT}\n` +
			'  --env <path>         Load env vars from a .env-format file. Repeatable; later files override earlier on key collision.\n' +
			'                       Works for both Node and Cloudflare targets. Shell-set env vars win over file values.\n' +
			'  --category <name>    (flue add) Fetch the generic instructions for a connector category. Pair with a positional URL/path that\n' +
			'                       points the agent at the provider\'s docs (e.g. `flue add https://e2b.dev --category sandbox`).\n' +
			'  --print              (flue add) Print the raw connector markdown to stdout regardless of whether the caller is an agent.\n' +
			'\n' +
			'Examples:\n' +
			'  flue dev --target node\n' +
			'  flue dev --target cloudflare --port 8787\n' +
			'  flue dev --target node --env .env\n' +
			'  flue run hello --target node --id test-1\n' +
			'  flue run hello --target node --id test-1 --payload \'{"name": "World"}\' --env .env\n' +
			'  flue build --target node\n' +
			'  flue build --target cloudflare --workspace ./my-app\n' +
			'  flue build --target node --output ./build\n' +
			'  flue add\n' +
			'  flue add daytona | claude\n' +
			'  flue add https://e2b.dev --category sandbox | claude\n' +
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
	/** Explicit --workspace value, or undefined to default to cwd. */
	explicitWorkspace: string | undefined;
	/** Explicit --output value, or undefined to default to <workspaceDir>/dist. */
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
	/** Explicit --workspace value, or undefined to default to cwd. */
	explicitWorkspace: string | undefined;
	/** Explicit --output value, or undefined to default to <workspaceDir>/dist. */
	explicitOutput: string | undefined;
	/** Explicit --config value, or undefined to auto-discover. */
	configFile: string | undefined;
}

interface DevArgs {
	command: 'dev';
	/** May be undefined if the user is relying on `flue.config.ts` for `target`. */
	target: 'node' | 'cloudflare' | undefined;
	/** Explicit --workspace value, or undefined to default to cwd. */
	explicitWorkspace: string | undefined;
	/** Explicit --output value, or undefined to default to <workspaceDir>/dist. */
	explicitOutput: string | undefined;
	/** Explicit --config value, or undefined to auto-discover. */
	configFile: string | undefined;
	/** 0 = use the SDK default (DEFAULT_DEV_PORT). */
	port: number;
	/** Raw --env values, in order; resolved/validated by the SDK. */
	envFiles: string[];
}

interface AddArgs {
	command: 'add';
	/** Connector slug, or (with --category) the {{URL}} value to substitute into the category root markdown. */
	name: string;
	category: string;
	print: boolean;
}

type ParsedArgs = RunArgs | BuildArgs | DevArgs | AddArgs;

function parseFlags(flags: string[]): {
	target?: 'node' | 'cloudflare';
	id?: string;
	explicitWorkspace: string | undefined;
	explicitOutput: string | undefined;
	configFile: string | undefined;
	payload: string;
	port: number;
	envFiles: string[];
} {
	let target: 'node' | 'cloudflare' | undefined;
	let id: string | undefined;
	let explicitWorkspace: string | undefined;
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
		} else if (arg === '--workspace') {
			explicitWorkspace = flags[++i] ?? '';
			if (!explicitWorkspace) {
				console.error('Missing value for --workspace');
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
		explicitWorkspace: explicitWorkspace ? path.resolve(explicitWorkspace) : undefined,
		explicitOutput: explicitOutput ? path.resolve(explicitOutput) : undefined,
		// `--config` is intentionally NOT pre-resolved: the SDK resolves it
		// vs. cwd at load time, mirroring how Vite handles `--config`.
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

function parseArgs(argv: string[]): ParsedArgs {
	const [command, ...rest] = argv;

	if (command === 'add') {
		return parseAddArgs(rest);
	}

	// `--target` is optional at parse time — the config file may supply it.
	// `resolveCliConfig` enforces it being set somewhere by the time we need it.

	if (command === 'build') {
		const flags = parseFlags(rest);
		return {
			command: 'build',
			target: flags.target,
			explicitWorkspace: flags.explicitWorkspace,
			explicitOutput: flags.explicitOutput,
			configFile: flags.configFile,
		};
	}

	if (command === 'dev') {
		const flags = parseFlags(rest);
		return {
			command: 'dev',
			target: flags.target,
			explicitWorkspace: flags.explicitWorkspace,
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
			explicitWorkspace: flags.explicitWorkspace,
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
		case 'agent_start':
			console.error('[flue] Agent started');
			break;

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

		case 'tool_end': {
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

		case 'turn_end':
			flushBuffers();
			break;

		case 'compaction_start':
			flushBuffers();
			console.error(
				`[flue] compaction:start  reason=${event.reason} tokens=${event.estimatedTokens}`,
			);
			break;

		case 'compaction_end':
			console.error(
				`[flue] compaction:end    messages: ${event.messagesBefore} → ${event.messagesAfter}`,
			);
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

		case 'result':
			// Handled separately by the caller
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

	const decoder = new TextDecoder();
	let buffer = '';
	let result: any = undefined;
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

			if (event.type === 'result') {
				result = event.data;
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

async function waitForServer(port: number, timeoutMs = 30000): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		try {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 1000);
			const res = await fetch(`http://localhost:${port}/health`, { signal: controller.signal });
			clearTimeout(timeout);
			if (res.ok) return true;
		} catch {
			// Not ready yet
		}
		await new Promise((resolve) => setTimeout(resolve, 300));
	}
	return false;
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
		explicitWorkspace: args.explicitWorkspace,
		explicitOutput: args.explicitOutput,
		configFile: args.configFile,
	});
	try {
		await build({
			workspaceDir: cfg.workspace,
			outputDir: cfg.output,
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
		explicitWorkspace: args.explicitWorkspace,
		explicitOutput: args.explicitOutput,
		configFile: args.configFile,
	});
	try {
		// dev() blocks until SIGINT/SIGTERM exits the process. We don't expect
		// it to return; if it ever does, just exit cleanly.
		await dev({
			workspaceDir: cfg.workspace,
			outputDir: cfg.output,
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
		explicitWorkspace: args.explicitWorkspace,
		explicitOutput: args.explicitOutput,
		configFile: args.configFile,
	});

	// `flue run` is Node-only. If the resolved target is cloudflare (which
	// can only happen via `flue.config.ts`, since the CLI flag was already
	// caught in parseArgs), bail with the same hint.
	if (cfg.target === 'cloudflare') {
		printCloudflareRunUnsupported(args.agent, args.id, args.payload);
	}

	const workspaceDir = cfg.workspace;
	const outputDir = cfg.output;
	const serverPath = path.join(outputDir, 'server.mjs');

	// 0. Resolve --env paths up front so a typo errors before we kick
	//    off a build. Resolves relative to workspaceDir (the project root)
	//    so users author --env paths the way they think about them, not
	//    relative to wherever they happened to redirect the build via
	//    --output.
	let resolvedEnvFiles: string[];
	try {
		resolvedEnvFiles = resolveEnvFiles(args.envFiles, workspaceDir);
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	}
	for (const f of resolvedEnvFiles) {
		console.error(`[flue] Loading env from: ${f}`);
	}
	const fileEnv = parseEnvFiles(resolvedEnvFiles);

	// 1. Build
	try {
		await build({ workspaceDir, outputDir, target: cfg.target });
	} catch (err) {
		console.error(`[flue] Build failed:`, err instanceof Error ? err.message : String(err));
		process.exit(1);
	}

	// 2. Pick a port
	const port = args.port || (await findPort());

	// 3. Start server. We launch the child with cwd=workspaceDir so the
	//    server resolves user dependencies, AGENTS.md, etc. relative to
	//    the project root regardless of where the build artifacts ended up.
	console.error(`[flue] Starting server on port ${port}...`);
	serverProcess = startServer(serverPath, port, fileEnv, workspaceDir);

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

	// 4. Wait for server to be ready
	const ready = await waitForServer(port);
	if (!ready) {
		console.error('[flue] Server did not become ready within 30s');
		stopServer();
		process.exit(1);
	}
	console.error(`[flue] Server ready. Running agent: ${args.agent}`);

	// 5. Verify the agent exists
	try {
		const manifestRes = await fetch(`http://localhost:${port}/agents`);
		const manifest: any = await manifestRes.json();
		const agentNames = manifest.agents?.map((a: any) => a.name) ?? [];
		if (!agentNames.includes(args.agent)) {
			console.error(
				`[flue] Agent "${args.agent}" not found. Available agents: ${agentNames.join(', ') || '(none)'}`,
			);
			stopServer();
			process.exit(1);
		}
	} catch {
		// Non-fatal — we'll find out when we POST
	}

	// 6. POST to the agent via SSE
	const sseAbort = new AbortController();
	let outcome: { result?: any; error?: string };

	try {
		outcome = await consumeSSE(
			`http://localhost:${port}/agents/${args.agent}/${args.id}`,
			args.payload,
			sseAbort.signal,
		);
	} catch (err) {
		outcome = { error: err instanceof Error ? err.message : String(err) };
	}

	// 7. Print result and exit
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
} else {
	run(args);
}
