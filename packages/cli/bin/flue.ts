#!/usr/bin/env node
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { build } from '@flue/sdk';

// ─── Arg Parsing ────────────────────────────────────────────────────────────

function printUsage() {
	console.error(
		'Usage:\n' +
			'  flue run <agent> --target <node|cloudflare> --session-id <id> [--payload <json>] [--dir <path>] [--port <number>]\n' +
			'  flue build --target <node|cloudflare> [--dir <path>]\n' +
			'\n' +
			'Examples:\n' +
			'  flue run hello --target node --session-id test-1\n' +
			'  flue run hello --target node --session-id test-1 --payload \'{"name": "World"}\'\n' +
			'  flue build --target node --dir ./my-workspace\n' +
			'  flue build --target cloudflare --dir ./my-workspace\n' +
			'\n' +
			'Note: set the model inside your agent via `init({ model: "provider/model-id" })` ' +
			'or per-call `{ model: ... }` on prompt/skill/task.',
	);
}

interface RunArgs {
	command: 'run';
	agent: string;
	target: 'node' | 'cloudflare';
	sessionId: string;
	payload: string;
	dir: string;
	port: number;
}

interface BuildArgs {
	command: 'build';
	target: 'node' | 'cloudflare';
	dir: string;
}

type ParsedArgs = RunArgs | BuildArgs;

function parseFlags(flags: string[]): {
	target?: string;
	sessionId?: string;
	dir: string;
	payload: string;
	port: number;
} {
	let target: string | undefined;
	let sessionId: string | undefined;
	let dir = process.cwd();
	let payload = '{}';
	let port = 0;

	for (let i = 0; i < flags.length; i++) {
		const arg = flags[i];
		if (arg === '--payload') {
			payload = flags[++i] ?? '';
			if (!payload) {
				console.error('Missing value for --payload');
				process.exit(1);
			}
		} else if (arg === '--target') {
			target = flags[++i];
			if (!target) {
				console.error('Missing value for --target');
				process.exit(1);
			}
			if (target !== 'node' && target !== 'cloudflare') {
				console.error(`Invalid target: "${target}". Supported targets: node, cloudflare`);
				process.exit(1);
			}
		} else if (arg === '--session-id') {
			sessionId = flags[++i];
			if (!sessionId) {
				console.error('Missing value for --session-id');
				process.exit(1);
			}
		} else if (arg === '--dir') {
			dir = flags[++i] ?? '';
			if (!dir) {
				console.error('Missing value for --dir');
				process.exit(1);
			}
		} else if (arg === '--port') {
			const portStr = flags[++i];
			port = parseInt(portStr ?? '', 10);
			if (isNaN(port)) {
				console.error('Invalid value for --port');
				process.exit(1);
			}
		} else {
			console.error(`Unknown argument: ${arg}`);
			printUsage();
			process.exit(1);
		}
	}

	return { target, sessionId, dir: path.resolve(dir), payload, port };
}

function parseArgs(argv: string[]): ParsedArgs {
	const [command, ...rest] = argv;

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
			dir: flags.dir,
		};
	}

	if (command === 'run' && rest.length > 0) {
		const agent = rest[0]!;
		const flags = parseFlags(rest.slice(1));

		if (!flags.target) {
			console.error('Missing required --target flag. Supported targets: node, cloudflare');
			printUsage();
			process.exit(1);
		}

		if (!flags.sessionId) {
			console.error('Missing required --session-id flag for run command.');
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
			target: flags.target as 'node' | 'cloudflare',
			sessionId: flags.sessionId,
			payload: flags.payload,
			dir: flags.dir,
			port: flags.port,
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

		case 'done':
			flushTextBuffer();
			break;

		case 'error':
			flushTextBuffer();
			console.error(`[flue] ERROR: ${event.error}`);
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
		const body = await res.text();
		return { error: `HTTP ${res.status}: ${body}` };
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
				error = event.error;
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
		env: { ...process.env, ...env, PORT: String(port), FLUE_MODE: 'local' },
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
	try {
		await build({
			agentDir: args.dir,
			target: args.target,
		});
	} catch (err) {
		console.error(`[flue] Build failed:`, err instanceof Error ? err.message : String(err));
		process.exit(1);
	}
}

async function run(args: RunArgs) {
	const agentDir = args.dir;
	const serverPath = path.join(agentDir, 'dist', 'server.mjs');

	// 1. Build
	try {
		await build({ agentDir, target: args.target });
	} catch (err) {
		console.error(`[flue] Build failed:`, err instanceof Error ? err.message : String(err));
		process.exit(1);
	}

	// 2. Pick a port
	const port = args.port || (await findPort());

	// 3. Start server
	console.error(`[flue] Starting server on port ${port}...`);
	const child = startServer(serverPath, port, {}, agentDir);

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
			`http://localhost:${port}/agents/${args.agent}/${args.sessionId}`,
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
} else {
	run(args);
}
