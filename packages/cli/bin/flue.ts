#!/usr/bin/env node
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { determineAgent } from '@vercel/detect-agent';
import {
	build,
	dev,
	DEFAULT_DEV_PORT,
	parseEnvFiles,
	resolveEnvFiles,
	resolveWorkspaceFromCwd,
} from '@flue/sdk';
import { CONNECTORS, CATEGORY_ROOTS } from './_connectors.generated.ts';

/**
 * Resolve the workspace directory for a CLI command.
 *
 * - If `--workspace` was passed, trust it as-is (explicit = deliberate). No
 *   waterfall is applied — if the user picks a path, that's the path.
 * - Otherwise, waterfall from the current working directory: `./.flue/` if it
 *   exists, else `./`. If neither has an `agents/` subdirectory, print a clear
 *   error and exit — the SDK's own "no agents found" error would also catch
 *   this, but stopping here gives the user a friendlier message up front.
 */
function resolveWorkspaceDir(explicitWorkspace: string | undefined): string {
	if (explicitWorkspace) return explicitWorkspace;

	const cwd = process.cwd();
	const resolved = resolveWorkspaceFromCwd(cwd);
	if (resolved) return resolved;

	console.error(
		`[flue] No Flue workspace found in ${cwd}.\n\n` +
			`Flue looks in two places:\n` +
			`  1. ${path.join(cwd, '.flue')}/\n` +
			`  2. ${cwd}/\n\n` +
			`Create one of these with an agents/ subdirectory, or pass --workspace <path>.`,
	);
	process.exit(1);
}

/**
 * Resolve the output directory (where dist/ goes). Independent of the workspace
 * so the built artifact and platform config (e.g. wrangler.jsonc) land where
 * the deploy tool expects. Defaults to the current working directory — usually
 * the project root, regardless of where the workspace itself ended up.
 */
function resolveOutputDir(explicitOutput: string | undefined): string {
	return explicitOutput ?? process.cwd();
}

// ─── Arg Parsing ────────────────────────────────────────────────────────────

function printUsage() {
	console.error(
		'Usage:\n' +
			'  flue dev   --target <node|cloudflare> [--workspace <path>] [--output <path>] [--port <number>] [--env <path>]...\n' +
			'  flue run   <agent> --target node --id <id> [--payload <json>] [--workspace <path>] [--output <path>] [--port <number>] [--env <path>]...\n' +
			'  flue build --target <node|cloudflare> [--workspace <path>] [--output <path>]\n' +
			'  flue add   [<name>|<url>] [--category <category>] [--print]\n' +
			'\n' +
			'Commands:\n' +
			'  dev    Long-running watch-mode dev server. Rebuilds and reloads on file changes.\n' +
			'  run    One-shot build + invoke an agent (production-style; use for CI / scripted runs).\n' +
			'  build  Build a deployable artifact to ./dist (production deploys).\n' +
			'  add    Install a connector. Pipes installation instructions for an AI coding agent to follow.\n' +
			'\n' +
			'Flags:\n' +
			'  --workspace <path>   Workspace root (containing agents/ and roles/). Default: ./.flue/ if it exists, else ./\n' +
			'  --output <path>      Where dist/ is written. Default: current working directory\n' +
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
			'  flue build --target cloudflare --workspace ./.flue --output ./build\n' +
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
	target: 'node';
	id: string;
	payload: string;
	/** Explicit --workspace value, or undefined to apply the cwd waterfall. */
	explicitWorkspace: string | undefined;
	/** Explicit --output value, or undefined to default to cwd. */
	explicitOutput: string | undefined;
	port: number;
	/** Resolved absolute paths from --env flags (repeatable). */
	envFiles: string[];
}

interface BuildArgs {
	command: 'build';
	target: 'node' | 'cloudflare';
	/** Explicit --workspace value, or undefined to apply the cwd waterfall. */
	explicitWorkspace: string | undefined;
	/** Explicit --output value, or undefined to default to cwd. */
	explicitOutput: string | undefined;
}

interface DevArgs {
	command: 'dev';
	target: 'node' | 'cloudflare';
	/** Explicit --workspace value, or undefined to apply the cwd waterfall. */
	explicitWorkspace: string | undefined;
	/** Explicit --output value, or undefined to default to cwd. */
	explicitOutput: string | undefined;
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
	payload: string;
	port: number;
	envFiles: string[];
} {
	let target: 'node' | 'cloudflare' | undefined;
	let id: string | undefined;
	let explicitWorkspace: string | undefined;
	let explicitOutput: string | undefined;
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

	if (command === 'build') {
		const flags = parseFlags(rest);
		if (!flags.target) {
			console.error('Missing required --target flag. Supported targets: node, cloudflare');
			printUsage();
			process.exit(1);
		}
		return {
			command: 'build',
			target: flags.target as 'node' | 'cloudflare',
			explicitWorkspace: flags.explicitWorkspace,
			explicitOutput: flags.explicitOutput,
		};
	}

	if (command === 'dev') {
		const flags = parseFlags(rest);
		if (!flags.target) {
			console.error('Missing required --target flag. Supported targets: node, cloudflare');
			printUsage();
			process.exit(1);
		}
		return {
			command: 'dev',
			target: flags.target as 'node' | 'cloudflare',
			explicitWorkspace: flags.explicitWorkspace,
			explicitOutput: flags.explicitOutput,
			port: flags.port,
			envFiles: flags.envFiles,
		};
	}

	if (command === 'run' && rest.length > 0) {
		const agent = rest[0]!;
		const flags = parseFlags(rest.slice(1));

		if (!flags.target) {
			console.error('Missing required --target flag. `flue run` only supports --target node');
			printUsage();
			process.exit(1);
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

		if (flags.target === 'cloudflare') {
			printCloudflareRunUnsupported(agent, flags.id, flags.payload);
		}

		return {
			command: 'run',
			agent,
			target: flags.target,
			id: flags.id,
			payload: flags.payload,
			explicitWorkspace: flags.explicitWorkspace,
			explicitOutput: flags.explicitOutput,
			port: flags.port,
			envFiles: flags.envFiles,
		};
	}

	printUsage();
	process.exit(1);
}

// ─── SSE Consumer ───────────────────────────────────────────────────────────

let textBuffer = '';

function flushTextBuffer() {
	if (textBuffer) {
		for (const line of textBuffer.split('\n')) {
			if (line) console.error(`  ${line}`);
		}
		textBuffer = '';
	}
}

function logEvent(event: any) {
	switch (event.type) {
		case 'agent_start':
			console.error('[flue] Agent started');
			break;

		case 'text_delta': {
			const combined = textBuffer + (event.text ?? '');
			const lines = combined.split('\n');
			textBuffer = lines.pop() ?? '';
			for (const line of lines) {
				console.error(`  ${line}`);
			}
			break;
		}

		case 'tool_start': {
			flushTextBuffer();
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
			flushTextBuffer();
			break;

		case 'compaction_start':
			flushTextBuffer();
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
			flushTextBuffer();
			break;

		case 'error':
			flushTextBuffer();
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

	flushTextBuffer();
	return error ? { error } : { result };
}

// ─── Server Management ─────────────────────────────────────────────────────

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

function stopServer(child: ChildProcess) {
	if (!child.killed) {
		child.kill('SIGTERM');
	}
	if (serverProcess === child) serverProcess = undefined;
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
	const workspaceDir = resolveWorkspaceDir(args.explicitWorkspace);
	const outputDir = resolveOutputDir(args.explicitOutput);
	try {
		await build({
			workspaceDir,
			outputDir,
			target: args.target,
		});
	} catch (err) {
		console.error(`[flue] Build failed:`, err instanceof Error ? err.message : String(err));
		process.exit(1);
	}
}

async function devCommand(args: DevArgs) {
	const workspaceDir = resolveWorkspaceDir(args.explicitWorkspace);
	const outputDir = resolveOutputDir(args.explicitOutput);
	try {
		// dev() blocks until SIGINT/SIGTERM exits the process. We don't expect
		// it to return; if it ever does, just exit cleanly.
		await dev({
			workspaceDir,
			outputDir,
			target: args.target,
			port: args.port || undefined,
			envFiles: args.envFiles,
		});
	} catch (err) {
		console.error(`[flue] Dev server failed:`, err instanceof Error ? err.message : String(err));
		process.exit(1);
	}
}

async function run(args: RunArgs) {
	const workspaceDir = resolveWorkspaceDir(args.explicitWorkspace);
	const outputDir = resolveOutputDir(args.explicitOutput);
	const serverPath = path.join(outputDir, 'dist', 'server.mjs');

	// 0. Resolve --env paths up front so a typo errors before we kick
	//    off a build. Resolves relative to outputDir (the project root).
	let resolvedEnvFiles: string[];
	try {
		resolvedEnvFiles = resolveEnvFiles(args.envFiles, outputDir);
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
		await build({ workspaceDir, outputDir, target: args.target });
	} catch (err) {
		console.error(`[flue] Build failed:`, err instanceof Error ? err.message : String(err));
		process.exit(1);
	}

	// 2. Pick a port
	const port = args.port || (await findPort());

	// 3. Start server
	console.error(`[flue] Starting server on port ${port}...`);
	const child = startServer(serverPath, port, fileEnv, outputDir);
	serverProcess = child;
	child.once('exit', () => {
		if (serverProcess === child) serverProcess = undefined;
	});

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
	child.stdout?.on('data', pipeServerOutput);
	child.stderr?.on('data', pipeServerOutput);

	// 4. Wait for server to be ready
	const ready = await waitForServer(port);
	if (!ready) {
		console.error('[flue] Server did not become ready within 30s');
		stopServer(child);
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
			stopServer(child);
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
		stopServer(child);
		process.exit(1);
	}

	if (outcome.result !== undefined && outcome.result !== null) {
		// Final result to stdout (everything else went to stderr)
		console.log(JSON.stringify(outcome.result, null, 2));
	}

	console.error('[flue] Done.');
	stopServer(child);
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

// Signal handling
let serverProcess: ChildProcess | undefined;

process.on('SIGINT', () => {
	if (serverProcess) stopServer(serverProcess);
	process.exit(130);
});

process.on('SIGTERM', () => {
	if (serverProcess) stopServer(serverProcess);
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
