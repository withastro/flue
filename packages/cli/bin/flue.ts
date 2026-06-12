#!/usr/bin/env node
import { type ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { determineAgent } from '@vercel/detect-agent';
import MiniSearch from 'minisearch';
import { build } from '../src/lib/build.ts';
import {
	type FlueConfig,
	resolveConfig,
	resolveConfigPath,
	type UserFlueConfig,
} from '../src/lib/config.ts';
import { resolveConfigCandidates } from '../src/lib/config-paths.ts';
import { DEFAULT_DEV_PORT, dev } from '../src/lib/dev.ts';
import { createEnvLoader, type EnvLoader, selectEnvFile } from '../src/lib/env.ts';
import { formatOffset } from '@flue/runtime/adapter';
import { createFlueClient, type FlueEventStream } from '@flue/sdk';
import type { FlueEvent, RunRecord } from '@flue/sdk';
import { CATEGORY_ROOTS, CONNECTORS } from './_connectors.generated.ts';

interface ApplicationConfigArgs {
	target?: 'node' | 'cloudflare';
	explicitRoot: string | undefined;
	explicitOutput: string | undefined;
	configFile: string | undefined;
	envFile: string | undefined;
}

function loadCliEnvironment(args: ApplicationConfigArgs): EnvLoader {
	try {
		const cwd = process.cwd();
		const searchFrom = args.explicitRoot ?? cwd;
		const configPath =
			args.configFile !== undefined
				? resolveConfigPath({ cwd, configFile: args.configFile })
				: resolveConfigPath({ cwd: searchFrom, configFile: undefined });
		const baseDir = configPath ? path.dirname(configPath) : searchFrom;
		const envLoader = createEnvLoader(selectEnvFile(args.envFile, baseDir));
		if (fs.existsSync(envLoader.file)) console.error(`[flue] Loading env from: ${envLoader.file}`);
		envLoader.apply();
		return envLoader;
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	}
}

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
			console.error(
				`[flue] Loaded config: ${path.relative(process.cwd(), configPath) || configPath}`,
			);
		}
		return flueConfig;
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	}
}

async function resolveApplicationCommand(
	args: ApplicationConfigArgs,
): Promise<{ cfg: FlueConfig; envLoader: EnvLoader }> {
	const envLoader = loadCliEnvironment(args);
	const cfg = await resolveCliConfig(args);
	return { cfg, envLoader };
}

// ─── Arg Parsing ────────────────────────────────────────────────────────────

function printUsage(log: (message: string) => void = console.error) {
	log(
		'Usage:\n' +
			'  flue dev   [--target <node|cloudflare>] [--root <path>] [--output <path>] [--config <path>] [--port <number>] [--env <path>]\n' +
			'  flue run     <workflow> [--target node] [--payload <json>] [--root <path>] [--output <path>] [--config <path>] [--env <path>]\n' +
			'  flue connect <agent> <instance-id> [--target node] [--root <path>] [--output <path>] [--config <path>] [--env <path>]\n' +
			'  flue build   [--target <node|cloudflare>] [--root <path>] [--output <path>] [--config <path>] [--env <path>]\n' +
			'  flue init  --target <node|cloudflare> [--root <path>] [--force]\n' +
			'  flue add   [<name>|<url>] [--category <category>] [--print]\n' +
			'  flue docs  [read <path> | search <query>]\n' +
			"  flue logs  <workflowRunId> [--server <url>] [--header 'Name: value'] [--follow|-f|--no-follow] [--since <offset>] [--types a,b,c] [--limit <n>] [--format pretty|ndjson]\n" +
			'\n' +
			'Commands:\n' +
			'  dev    Long-running watch-mode dev server. Rebuilds and reloads on file changes.\n' +
			'  run      One-shot build + invoke a workflow (production-style; use for CI / scripted runs).\n' +
			'  connect  Build + open an interactive local connection to an agent instance.\n' +
			'  build    Build a deployable artifact to ./dist (production deploys).\n' +
			'  init   Scaffold a starter flue.config.ts in the target directory.\n' +
			'  add    Install a connector. Pipes installation instructions for an AI coding agent to follow.\n' +
			'  docs   Browse the Flue docs. No args lists pages; `read` prints a page as markdown; `search` prints JSON results.\n' +
			'  logs   Tail or replay workflow run events from a running Flue server. Read-only — does not invoke work.\n' +
			'\n' +
			'Flags:\n' +
			'  --root <path>        Project root. Default: current working directory.\n' +
			'  --output <path>      Where the build artifacts are written. Default: <root>/dist.\n' +
			'  --config <path>      Path to a flue.config.{ts,mts,mjs,js,cjs,cts} file (relative to cwd).\n' +
			'                       Default: search the root dir (or cwd) for `flue.config.*`.\n' +
			'                       CLI flags always override values set in the config file.\n' +
			`  --port <number>      Port for the dev server. Default: ${DEFAULT_DEV_PORT}\n` +
			'  --env <path>         Select one alternate .env-format file for build/dev/run/connect before config loads.\n' +
			'                       Without --env, these commands load <project>/.env when present. Shell values win.\n' +
			'  --category <name>    (flue add) Fetch the generic instructions for a connector category. Pair with a positional URL/path that\n' +
			"                       points the agent at the provider's docs (e.g. `flue add https://e2b.dev --category sandbox`).\n" +
			'  --print              (flue add) Print the raw connector markdown to stdout regardless of whether the caller is an agent.\n' +
			'  --force              (flue init) Overwrite an existing flue.config.* in the target directory.\n' +
			'\n' +
			'Examples:\n' +
			'  flue dev --target node\n' +
			'  flue dev --target cloudflare --port 8787\n' +
			'  flue run hello --target node\n' +
			'  flue run hello --target node --payload \'{"name": "World"}\' --env .env.staging\n' +
			'  flue connect assistant thread-1 --target node\n' +
			'  flue build --target node\n' +
			'  flue build --target cloudflare --root ./my-app\n' +
			'  flue build --target node --output ./build\n' +
			'  flue init --target node\n' +
			'  flue add\n' +
			'  flue add daytona | claude\n' +
			'  flue add https://e2b.dev --category sandbox | claude\n' +
			'  flue docs\n' +
			'  flue docs read guide/sandboxes\n' +
			'  flue docs search "durable execution"\n' +
			'  flue logs run_01H...                              # tail a workflow run\n' +
			'  flue logs run_01H... --no-follow                  # replay a workflow run\n' +
			'  flue logs run_01H... --types tool,log,run_end --format ndjson\n' +
			'\n' +
			'Note: set the model in `createAgent(() => ({ model: "provider-id/model-id" }))` ' +
			'or per-call `{ model: ... }` on prompt/skill/task.',
	);
}

interface RunArgs {
	command: 'run';
	workflow: string;
	/** May be undefined if the user is relying on `flue.config.ts` for `target`. */
	target: 'node' | undefined;
	payload: string;
	/** Explicit --root value, or undefined to default to cwd. */
	explicitRoot: string | undefined;
	/** Explicit --output value, or undefined to default to <root>/dist. */
	explicitOutput: string | undefined;
	/** Explicit --config value, or undefined to auto-discover. */
	configFile: string | undefined;
	/** Explicit --env file, or undefined to use the default project .env. */
	envFile: string | undefined;
}

interface ConnectArgs {
	command: 'connect';
	agent: string;
	instanceId: string;
	target: 'node' | undefined;
	explicitRoot: string | undefined;
	explicitOutput: string | undefined;
	configFile: string | undefined;
	envFile: string | undefined;
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
	envFile: string | undefined;
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
	/** Explicit --env file, or undefined to use the default project .env. */
	envFile: string | undefined;
}

interface AddArgs {
	command: 'add';
	/** Connector slug, or (with --category) the {{URL}} value to substitute into the category root markdown. */
	name: string;
	category: string;
	print: boolean;
}

interface DocsArgs {
	command: 'docs';
	action: 'list' | 'read' | 'search';
	/** Page path for `read`, query for `search`, empty for `list`. */
	value: string;
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
	headers: Record<string, string>;
	/**
	 * Whether to keep streaming live events (`true`) or exit after the
	 * initial replay (`false`). `undefined` means "auto" — follow if the
	 * selected run is still active, replay-and-exit if it's already
	 * terminal. CLI flags `--follow` / `--no-follow` set it explicitly.
	 */
	follow: boolean | undefined;
	/** Opaque DS offset to resume after (e.g. the ndjson `offset` field). */
	since: string | undefined;
	/** Filter to a specific set of event types (comma-separated on the CLI). */
	types: ReadonlySet<string> | undefined;
	/** Cap emitted event count. Applied client-side. */
	limit: number | undefined;
	format: 'pretty' | 'ndjson';
}

type ParsedArgs =
	| RunArgs
	| ConnectArgs
	| BuildArgs
	| DevArgs
	| AddArgs
	| DocsArgs
	| InitArgs
	| LogsArgs;

function parseFlags(flags: string[]): {
	target?: 'node' | 'cloudflare';
	explicitRoot: string | undefined;
	explicitOutput: string | undefined;
	configFile: string | undefined;
	payload: string;
	port: number;
	envFile: string | undefined;
} {
	let target: 'node' | 'cloudflare' | undefined;
	let explicitRoot: string | undefined;
	let explicitOutput: string | undefined;
	let configFile: string | undefined;
	let payload = '{}';
	let port = 0;
	let envFile: string | undefined;

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
			if (Number.isNaN(port)) {
				console.error('Invalid value for --port');
				process.exit(1);
			}
		} else if (arg === '--env') {
			const value = flags[++i];
			if (!value) {
				console.error('Missing value for --env');
				process.exit(1);
			}
			if (envFile !== undefined) {
				console.error(
					'`--env` accepts one file. Combine values into one file or provide shell overrides.',
				);
				process.exit(1);
			}
			envFile = value;
		} else {
			console.error(`Unknown argument: ${arg}`);
			printUsage();
			process.exit(1);
		}
	}

	return {
		target,
		explicitRoot: explicitRoot ? path.resolve(explicitRoot) : undefined,
		explicitOutput: explicitOutput ? path.resolve(explicitOutput) : undefined,
		// `--config` is intentionally NOT pre-resolved: the config loader
		// resolves it vs. cwd at load time, mirroring how Vite handles `--config`.
		configFile,
		payload,
		port,
		envFile,
	};
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function printCloudflareRunUnsupported(workflow: string, payload: string): never {
	console.error(
		'[flue] `flue run --target cloudflare` is not supported.\n\n' +
			'`flue run` is a one-shot Node.js invoker; Cloudflare builds need a Workers runtime.\n\n' +
			'For local development of a Cloudflare target, use `flue dev`:\n\n' +
			`  flue dev --target cloudflare\n\n` +
			`Then in another terminal:\n\n` +
			`  curl http://localhost:${DEFAULT_DEV_PORT}/workflows/${workflow} \\\n` +
			'    -H "Content-Type: application/json" \\\n' +
			`    -d ${shellQuote(payload)}`,
	);
	process.exit(1);
}

function printCloudflareConnectUnsupported(): never {
	console.error(
		'[flue] `flue connect --target cloudflare` is not supported.\n\n' +
			'`flue connect` currently starts a local Node.js process; Cloudflare connections require a Workers runtime.',
	);
	process.exit(1);
}

function parseAddArgs(rest: string[]): AddArgs {
	let name = '';
	let category = '';
	let print = false;

	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i];
		if (arg === undefined) continue;
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

function parseDocsArgs(rest: string[]): DocsArgs {
	const [action, ...values] = rest;

	if (action === undefined) {
		return { command: 'docs', action: 'list', value: '' };
	}

	if (action === 'read') {
		const value = values[0];
		if (!value) {
			console.error('Missing docs page path.\n\nUsage:\n  flue docs read <path>');
			process.exit(1);
		}
		const extra = values[1];
		if (extra !== undefined) {
			console.error(`Unexpected extra argument for \`flue docs read\`: ${extra}`);
			process.exit(1);
		}
		return { command: 'docs', action: 'read', value };
	}

	if (action === 'search') {
		const value = values.join(' ').trim();
		if (!value) {
			console.error('Missing search query.\n\nUsage:\n  flue docs search <query>');
			process.exit(1);
		}
		return { command: 'docs', action: 'search', value };
	}

	console.error(
		`Unknown \`flue docs\` subcommand: ${action}\n\n` +
			'Usage:\n' +
			'  flue docs                  List all documentation pages\n' +
			'  flue docs read <path>      Print a documentation page as markdown\n' +
			'  flue docs search <query>   Search the documentation (JSON results)\n' +
			(action.includes('/') ? `\nDid you mean \`flue docs read ${action}\`?\n` : ''),
	);
	process.exit(1);
}

function parseLogsHeader(value: string | undefined, headers: Headers): void {
	if (!value) {
		console.error('Missing value for --header');
		process.exit(1);
	}
	const separator = value.indexOf(':');
	if (separator === -1) {
		console.error('Invalid value for --header (expected "Name: value")');
		process.exit(1);
	}
	const name = value.slice(0, separator).trim();
	const headerValue = value.slice(separator + 1).trim();
	const normalizedName = name.toLowerCase();
	if (normalizedName === 'accept') {
		console.error(`Cannot set reserved \`flue logs\` header: ${name}`);
		process.exit(1);
	}
	try {
		if (headers.has(name)) {
			console.error(`Duplicate \`flue logs\` header: ${name}`);
			process.exit(1);
		}
		headers.set(name, headerValue);
	} catch {
		console.error('Invalid value for --header (expected "Name: value")');
		process.exit(1);
	}
}

function parseLogsArgs(rest: string[]): LogsArgs {
	const positional: string[] = [];
	let server = `http://127.0.0.1:${DEFAULT_DEV_PORT}`;
	const headers = new Headers();
	let follow: boolean | undefined;
	let since: string | undefined;
	let types: ReadonlySet<string> | undefined;
	let limit: number | undefined;
	let format: LogsArgs['format'] = 'pretty';

	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i];
		if (arg === undefined) continue;
		if (arg === '--server') {
			const value = rest[++i];
			if (!value) {
				console.error('Missing value for --server');
				process.exit(1);
			}
			server = value;
		} else if (arg === '--header') {
			parseLogsHeader(rest[++i], headers);
		} else if (arg === '--follow' || arg === '-f') {
			follow = true;
		} else if (arg === '--no-follow') {
			follow = false;
		} else if (arg === '--since') {
			const value = rest[++i];
			if (!value) {
				console.error('Missing value for --since');
				process.exit(1);
			}
			since = value;
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
			if (value !== 'pretty' && value !== 'ndjson') {
				console.error(`Invalid value for --format: "${value}". Allowed: pretty, ndjson`);
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

	const runId = positional[0];
	if (!runId) {
		console.error('Missing required argument for `flue logs`: <runId>');
		printUsage();
		process.exit(1);
	}

	return {
		command: 'logs',
		runId,
		server,
		headers: Object.fromEntries(headers),
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
		const arg = rest[i];
		if (arg === undefined) continue;
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

	if (command === '--help' || command === '-h' || command === 'help') {
		printUsage(console.log);
		process.exit(0);
	}

	if (command === '--version' || command === '-v') {
		// Resolved relative to this module: both `bin/` (source) and `dist/`
		// (compiled) sit one level under the package root.
		const pkg = JSON.parse(
			fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
		) as { version: string };
		console.log(pkg.version);
		process.exit(0);
	}

	if (command === 'add') {
		return parseAddArgs(rest);
	}

	if (command === 'docs') {
		return parseDocsArgs(rest);
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
			envFile: flags.envFile,
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
			envFile: flags.envFile,
		};
	}

	if (command === 'connect' && rest.length >= 2) {
		const agent = rest[0];
		const instanceId = rest[1];
		if (!agent || !instanceId) {
			console.error('Missing agent name or instance id for connect command.');
			printUsage();
			process.exit(1);
		}
		const flags = parseFlags(rest.slice(2));
		if (flags.target === 'cloudflare') printCloudflareConnectUnsupported();
		if (flags.payload !== '{}') {
			console.error('`flue connect` does not accept --payload; enter prompts after connecting.');
			process.exit(1);
		}
		if (flags.port !== 0) {
			console.error('`flue connect` does not accept --port.');
			process.exit(1);
		}
		return {
			command: 'connect',
			agent,
			instanceId,
			target: flags.target as 'node' | undefined,
			explicitRoot: flags.explicitRoot,
			explicitOutput: flags.explicitOutput,
			configFile: flags.configFile,
			envFile: flags.envFile,
		};
	}

	if (command === 'run' && rest.length > 0) {
		const workflow = rest[0];
		if (!workflow) {
			console.error('Missing workflow name for run command.');
			printUsage();
			process.exit(1);
		}
		const flags = parseFlags(rest.slice(1));

		// `flue run` only supports node. If the user explicitly asked for
		// cloudflare on the CLI, bail with the usual usage hint. The case
		// where `flue.config.ts` sets `target: cloudflare` is handled later
		// in `run()` after config resolution.
		if (flags.target === 'cloudflare') {
			printCloudflareRunUnsupported(workflow, flags.payload);
		}
		if (flags.port !== 0) {
			console.error('`flue run` does not accept --port.');
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
			workflow,
			target: flags.target as 'node' | undefined,
			payload: flags.payload,
			explicitRoot: flags.explicitRoot,
			explicitOutput: flags.explicitOutput,
			configFile: flags.configFile,
			envFile: flags.envFile,
		};
	}

	printUsage();
	process.exit(1);
}

// ─── Event rendering ─────────────────────────────────────────────────────────

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
					toolDetail += `  $ ${event.args.command.length > 120 ? `${event.args.command.slice(0, 120)}...` : event.args.command}`;
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

		case 'tool': {
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

		case 'turn_start':
		case 'turn_messages':
			break;

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
			console.error(
				`[flue] ERROR [${event.error?.type ?? 'unknown'}]: ${event.error?.message ?? ''}`,
			);
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
			// in the run stream consumer before reaching this renderer. `run_start`
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

type LocalCliMessage = {
	type?: string;
	target?: string;
	name?: string;
	instanceId?: string;
	requestId?: string;
	runId?: string;
	event?: any;
	result?: any;
	error?: { type?: string; message?: string; details?: string; dev?: string };
};

let localProcess: ChildProcess | undefined;

function startLocalProcess(
	serverPath: string,
	target: 'workflow' | 'agent',
	name: string,
	id: string | undefined,
	cwd: string,
): ChildProcess {
	const child = spawn(process.execPath, [serverPath], {
		stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
		cwd,
		env: {
			...process.env,
			FLUE_MODE: 'local',
			FLUE_CLI_TARGET: target,
			FLUE_CLI_NAME: name,
			...(id === undefined ? {} : { FLUE_CLI_ID: id }),
		},
	});
	const pipeOutput = (data: Buffer) => {
		for (const line of data.toString().trimEnd().split('\n')) {
			if (line.trim()) console.error(line);
		}
	};
	child.stdout?.on('data', pipeOutput);
	child.stderr?.on('data', pipeOutput);
	localProcess = child;
	return child;
}

function stopLocalProcess() {
	if (localProcess && !localProcess.killed) localProcess.kill('SIGTERM');
	localProcess = undefined;
}

function waitForLocalReady(
	child: ChildProcess,
	expected: (message: LocalCliMessage) => boolean,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			cleanup();
			child.kill('SIGTERM');
			reject(new Error('Local execution process did not become ready within 60 seconds.'));
		}, 60_000);
		const onMessage = (raw: unknown) => {
			const message = raw as LocalCliMessage;
			if (message.type === 'error') {
				cleanup();
				reject(new Error(formatLocalError(message)));
				return;
			}
			if (message.type === 'ready' && expected(message)) {
				cleanup();
				resolve();
			}
		};
		const onExit = (code: number | null) => {
			cleanup();
			reject(
				new Error(
					`Local execution process exited before becoming ready${code === null ? '' : ` (code ${code})`}.`,
				),
			);
		};
		const cleanup = () => {
			clearTimeout(timeout);
			child.off('message', onMessage);
			child.off('exit', onExit);
		};
		child.on('message', onMessage);
		child.once('exit', onExit);
	});
}

function formatLocalError(message: LocalCliMessage): string {
	const error = message.error;
	if (!error) return 'Unknown local execution error.';
	const lines = [`[${error.type ?? 'unknown'}] ${error.message ?? 'Unknown error'}`];
	if (error.details) lines.push(error.details);
	if (error.dev) lines.push(error.dev);
	return lines.join('\n');
}

function sendLocalRequest(
	child: ChildProcess,
	message: Record<string, unknown>,
	onStarted?: (message: LocalCliMessage) => void,
): Promise<any> {
	return new Promise((resolve, reject) => {
		const requestId = message.requestId;
		const onMessage = (raw: unknown) => {
			const incoming = raw as LocalCliMessage;
			if (incoming.requestId !== requestId) return;
			if (incoming.type === 'started') {
				onStarted?.(incoming);
				return;
			}
			if (incoming.type === 'event') {
				logEvent(incoming.event);
				return;
			}
			if (incoming.type === 'result') {
				cleanup();
				flushBuffers();
				resolve(incoming.result);
				return;
			}
			if (incoming.type === 'error') {
				cleanup();
				flushBuffers();
				reject(new Error(formatLocalError(incoming)));
			}
		};
		const onExit = (code: number | null) => {
			cleanup();
			reject(
				new Error(
					`Local execution process exited before returning a result${code === null ? '' : ` (code ${code})`}.`,
				),
			);
		};
		const cleanup = () => {
			child.off('message', onMessage);
			child.off('exit', onExit);
		};
		child.on('message', onMessage);
		child.once('exit', onExit);
		child.send?.(message);
	});
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function buildCommand(args: BuildArgs) {
	const { cfg } = await resolveApplicationCommand(args);
	try {
		await build({
			root: cfg.root,
			sourceRoot: cfg.sourceRoot,
			output: cfg.output,
			target: cfg.target,
		});
	} catch (err) {
		console.error(`[flue] Build failed:`, err instanceof Error ? err.message : String(err));
		process.exit(1);
	}
}

const INTERNAL_DEV_SESSION = 'FLUE_INTERNAL_DEV_SESSION';
const INTERNAL_DEV_READY = 'ready';

function devConfigFiles(args: DevArgs): string[] {
	const cwd = process.cwd();
	return resolveConfigCandidates({
		cwd,
		searchFrom: args.explicitRoot ?? cwd,
		configFile: args.configFile,
	});
}

async function devCommand(args: DevArgs) {
	const { cfg, envLoader } = await resolveApplicationCommand(args);
	try {
		// dev() blocks until SIGINT/SIGTERM exits the process. We don't expect
		// it to return; if it ever does, just exit cleanly.
		await dev({
			root: cfg.root,
			sourceRoot: cfg.sourceRoot,
			output: cfg.output,
			target: cfg.target,
			port: args.port || undefined,
			envFile: envLoader.file,
			envLoader,
			configFiles: devConfigFiles(args),
			onReady: () => process.send?.(INTERNAL_DEV_READY),
		});
	} catch (err) {
		console.error(`[flue] Dev server failed:`, err instanceof Error ? err.message : String(err));
		process.exit(1);
	}
}

function readConfigFileState(file: string): string | undefined {
	try {
		const stat = fs.statSync(file);
		return `${stat.mtimeMs}:${stat.size}`;
	} catch {
		return undefined;
	}
}

function superviseDevCommand(args: DevArgs) {
	const configFiles = devConfigFiles(args);
	const configFilesByDirectory = new Map<string, Set<string>>();
	const configFileStates = new Map(configFiles.map((file) => [file, readConfigFileState(file)]));
	for (const file of configFiles) {
		const directory = path.dirname(file);
		const basenames = configFilesByDirectory.get(directory) ?? new Set<string>();
		basenames.add(path.basename(file));
		configFilesByDirectory.set(directory, basenames);
	}

	const watchers: fs.FSWatcher[] = [];
	let child: ChildProcess | undefined;
	let restartTimer: NodeJS.Timeout | undefined;
	let restartRequested = false;
	let replacementSession = false;
	let sessionReady = false;
	let shuttingDown = false;

	const closeWatchers = () => {
		for (const watcher of watchers.splice(0)) watcher.close();
	};
	const exit = (code: number) => {
		closeWatchers();
		process.exit(code);
	};
	const startSession = (replacement: boolean) => {
		const cliPath = process.argv[1];
		if (!cliPath) return exit(1);
		restartRequested = false;
		replacementSession = replacement;
		sessionReady = false;
		child = spawn(process.execPath, [cliPath, ...process.argv.slice(2)], {
			stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
			env: { ...process.env, [INTERNAL_DEV_SESSION]: '1' },
		});
		const session = child;
		session.on('message', (message) => {
			if (message === INTERNAL_DEV_READY) sessionReady = true;
		});
		session.once('exit', (code, signal) => {
			if (child !== session) return;
			child = undefined;
			if (shuttingDown) exit(signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : (code ?? 1));
			if (restartRequested) {
				if (!restartTimer) startSession(true);
				return;
			}
			if (replacementSession && !sessionReady) {
				console.error('[flue] Dev server restart failed. Waiting for a configuration change...');
				return;
			}
			exit(code ?? 1);
		});
	};
	const restart = (file: string) => {
		for (const configFile of configFiles) {
			configFileStates.set(configFile, readConfigFileState(configFile));
		}
		console.error(`[flue] Configuration changed: ${file}. Restarting dev server...`);
		restartRequested = true;
		if (restartTimer) clearTimeout(restartTimer);
		restartTimer = setTimeout(() => {
			restartTimer = undefined;
			if (!child) startSession(true);
		}, 150);
		child?.kill('SIGTERM');
	};

	try {
		for (const [directory, basenames] of configFilesByDirectory) {
			const watcher = fs.watch(directory, (_event, filename) => {
				const basename = filename?.toString();
				if (basename !== undefined) {
					if (!basenames.has(basename)) return;
					restart(path.join(directory, basename));
					return;
				}
				for (const configFile of configFiles) {
					if (configFileStates.get(configFile) !== readConfigFileState(configFile)) {
						restart(configFile);
						return;
					}
				}
			});
			watcher.on('error', (err) => {
				console.error(
					`[flue] Config watcher failed: ${err instanceof Error ? err.message : String(err)}`,
				);
				exit(1);
			});
			watchers.push(watcher);
		}
	} catch (err) {
		console.error(
			`[flue] Config watcher failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		exit(1);
	}

	const shutdown = (signal: NodeJS.Signals) => {
		if (shuttingDown) return;
		shuttingDown = true;
		if (restartTimer) clearTimeout(restartTimer);
		closeWatchers();
		if (!child) return exit(signal === 'SIGINT' ? 130 : 143);
		child.kill(signal);
	};
	process.on('SIGINT', () => shutdown('SIGINT'));
	process.on('SIGTERM', () => shutdown('SIGTERM'));
	process.on('exit', () => child?.kill('SIGKILL'));
	startSession(false);
}

async function buildLocalTarget(
	args: Pick<
		RunArgs | ConnectArgs,
		'target' | 'explicitRoot' | 'explicitOutput' | 'configFile' | 'envFile'
	>,
) {
	const { cfg } = await resolveApplicationCommand(args);
	if (cfg.target === 'cloudflare') return { cfg, serverPath: undefined };
	try {
		await build({
			root: cfg.root,
			sourceRoot: cfg.sourceRoot,
			output: cfg.output,
			target: cfg.target,
		});
	} catch (err) {
		console.error(`[flue] Build failed:`, err instanceof Error ? err.message : String(err));
		process.exit(1);
	}
	return { cfg, serverPath: path.join(cfg.output, 'server.mjs') };
}

async function run(args: RunArgs) {
	const built = await buildLocalTarget(args);
	if (built.cfg.target === 'cloudflare') printCloudflareRunUnsupported(args.workflow, args.payload);
	if (!built.serverPath)
		throw new Error('[flue] Node local workflow build did not produce an executable artifact.');
	const child = startLocalProcess(
		built.serverPath,
		'workflow',
		args.workflow,
		undefined,
		built.cfg.root,
	);
	console.error(`[flue] Running workflow: ${args.workflow}`);
	try {
		await waitForLocalReady(
			child,
			(message) => message.target === 'workflow' && message.name === args.workflow,
		);
		const result = await sendLocalRequest(
			child,
			{
				type: 'invoke',
				requestId: `req_${crypto.randomUUID()}`,
				payload: JSON.parse(args.payload),
			},
			(message) => console.error(`[flue] Run ID: ${message.runId}`),
		);
		if (result !== undefined && result !== null) console.log(JSON.stringify(result, null, 2));
		console.error('[flue] Done.');
	} catch (err) {
		console.error(`[flue] Workflow error: ${err instanceof Error ? err.message : String(err)}`);
		stopLocalProcess();
		process.exit(1);
	}
	stopLocalProcess();
}

async function connectCommand(args: ConnectArgs) {
	const built = await buildLocalTarget(args);
	if (built.cfg.target === 'cloudflare') printCloudflareConnectUnsupported();
	if (!built.serverPath)
		throw new Error('[flue] Node local agent build did not produce an executable artifact.');
	const child = startLocalProcess(
		built.serverPath,
		'agent',
		args.agent,
		args.instanceId,
		built.cfg.root,
	);
	try {
		await waitForLocalReady(
			child,
			(message) =>
				message.target === 'agent' &&
				message.name === args.agent &&
				message.instanceId === args.instanceId,
		);
	} catch (err) {
		console.error(`[flue] Connection error: ${err instanceof Error ? err.message : String(err)}`);
		stopLocalProcess();
		process.exit(1);
	}
	console.error(
		`[flue] Connected to ${args.agent}/${args.instanceId}. Enter a prompt per line; Ctrl-D to exit.`,
	);
	const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
	let closing = false;
	child.once('exit', (code) => {
		if (closing) return;
		input.close();
		console.error(
			`[flue] Agent connection ended unexpectedly${code === null ? '.' : ` (code ${code}).`}`,
		);
		process.exitCode = 1;
	});
	for await (const line of input) {
		if (!line.trim()) continue;
		try {
			const result = await sendLocalRequest(child, {
				type: 'prompt',
				requestId: `req_${crypto.randomUUID()}`,
				message: line,
			});
			if (result !== undefined && result !== null) console.log(JSON.stringify(result, null, 2));
		} catch (err) {
			console.error(`[flue] Agent error: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	closing = true;
	stopLocalProcess();
}

// ─── `flue logs` ────────────────────────────────────────────────────────────

function formatDuration(ms: number | undefined): string {
	if (ms === undefined) return '';
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
	const m = Math.floor(ms / 60_000);
	const s = ((ms % 60_000) / 1000).toFixed(1);
	return `${m}m${s}s`;
}

/** Render a single event for `flue logs --format pretty`. */
function logsRenderPretty(event: FlueEvent): void {
	const { type } = event;
	if (type === 'run_start') {
		console.error(`[flue] run:start    ${event.runId}  workflow=${event.workflowName}`);
		return;
	}
	if (type === 'run_end') {
		const duration = formatDuration(event.durationMs);
		if (event.isError) {
			const err = event.error as { message?: string } | undefined;
			console.error(
				`[flue] run:end      ${event.runId}  ERROR  ${err?.message ?? ''}  (${duration})`,
			);
		} else {
			console.error(`[flue] run:end      ${event.runId}  ok  (${duration})`);
		}
		return;
	}
	if (type === 'operation_start') {
		console.error(`[flue] op:start      ${event.operationKind}`);
		return;
	}
	if (type === 'operation') {
		const duration = formatDuration(event.durationMs);
		console.error(`[flue] op:done      ${event.operationKind}${duration ? `  (${duration})` : ''}`);
		return;
	}
	logEvent(event);
}

function createLogsClient(args: LogsArgs) {
	return createFlueClient({
		baseUrl: args.server,
		headers: args.headers,
	});
}

function logsEmitEvent(event: FlueEvent, format: LogsArgs['format']): void {
	if (format === 'ndjson') {
		// ndjson lines carry a per-event resume offset derived from eventIndex
		// (on run streams, event index == stream sequence; flue logs reads
		// runs only). The stream's own offset getter is batch-granular and
		// would skip events if used as a mid-batch checkpoint.
		const offset =
			typeof event.eventIndex === 'number' ? formatOffset(event.eventIndex) : undefined;
		const output = offset ? { ...event, offset } : event;
		process.stdout.write(`${JSON.stringify(output)}\n`);
	} else {
		logsRenderPretty(event);
	}
}

async function logsCommand(args: LogsArgs): Promise<void> {
	const client = createLogsClient(args);

	let shouldFollow: boolean;
	if (args.follow === false) {
		shouldFollow = false;
	} else {
		// Probe the run before streaming, even with explicit --follow: the DS
		// stream client retries connection errors indefinitely, so an
		// unreachable server would otherwise hang forever with no output.
		let run: RunRecord;
		try {
			run = await client.runs.get(args.runId);
		} catch (err) {
			console.error(
				`[flue] Failed to fetch run ${args.runId}: ${err instanceof Error ? err.message : String(err)}`,
			);
			process.exit(1);
		}
		// Run ids are opaque; surface the owning workflow from the run record.
		if (args.format === 'pretty') {
			console.error(
				`[flue] run          ${args.runId}  workflow=${run.workflowName}  status=${run.status}`,
			);
		}
		shouldFollow = args.follow ?? run.status === 'active';
	}

	// One-shot mode: catch-up read via DS, then exit.
	if (!shouldFollow) {
		let events: FlueEvent[];
		try {
			events = await client.runs.events(args.runId, {
				offset: args.since ?? '-1',
				backoffOptions: {
					initialDelay: 100,
					maxDelay: 60_000,
					multiplier: 1.3,
					maxRetries: 3,
				},
			});
		} catch (err) {
			console.error(
				`[flue] Failed to read events for run ${args.runId}: ${err instanceof Error ? err.message : String(err)}`,
			);
			process.exit(1);
		}

		let exitCode = 0;
		let emittedCount = 0;
		for (const event of events) {
			if (event.type === 'run_end' && event.isError) exitCode = 2;
			if (args.types && !args.types.has(event.type)) continue;

			logsEmitEvent(event, args.format);
			emittedCount++;

			if (args.limit !== undefined && emittedCount >= args.limit) break;
		}
		if (args.format === 'pretty') flushBuffers();
		process.exitCode = exitCode;
		return;
	}

	// Follow mode: stream via DS protocol with live tailing.
	const stream: FlueEventStream<FlueEvent> = client.runs.stream(args.runId, {
		offset: args.since ?? '-1',
		live: true,
	});

	// Follow mode owns signal handling: drop handlers registered earlier so
	// they cannot preempt graceful cancellation. Dependencies loaded at import
	// time (e.g. wrangler) install SIGINT/SIGTERM handlers that call
	// process.exit() synchronously, which would skip stream cancellation, the
	// buffer flush in `finally`, and the 130 exit code below.
	process.removeAllListeners('SIGINT');
	process.removeAllListeners('SIGTERM');
	let signalled = false;
	const onSignal = () => {
		signalled = true;
		stream.cancel();
	};
	process.on('SIGINT', onSignal);
	process.on('SIGTERM', onSignal);

	let emittedCount = 0;
	let exitCode = 0;

	try {
		for await (const event of stream) {
			if (event.type === 'run_end' && event.isError) exitCode = 2;
			if (args.types && !args.types.has(event.type)) continue;

			logsEmitEvent(event, args.format);
			emittedCount++;

			if (event.type === 'run_end') {
				break;
			}
			if (args.limit !== undefined && emittedCount >= args.limit) break;
		}
	} catch (err) {
		if (!signalled) {
			console.error(
				`[flue] Stream interrupted: ${err instanceof Error ? err.message : String(err)}`,
			);
			exitCode = 1;
		}
	} finally {
		process.off('SIGINT', onSignal);
		process.off('SIGTERM', onSignal);
		if (args.format === 'pretty') flushBuffers();
	}

	// The SDK's FlueEventStream swallows abort errors and returns done:true,
	// so signal-driven cancellation exits the loop cleanly rather than via
	// the catch block. Check the flag to set the correct exit code.
	if (signalled) exitCode = 130;

	process.exitCode = exitCode;
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
			`[flue] A Flue config already exists at ${rel}.\n  Re-run with --force to overwrite.`,
		);
		process.exit(1);
	}

	const outPath = path.join(targetDir, 'flue.config.ts');
	const content = renderConfigTemplate(args.target);

	try {
		fs.writeFileSync(outPath, content);
	} catch (err) {
		console.error(
			`[flue] Failed to write ${outPath}: ${err instanceof Error ? err.message : String(err)}`,
		);
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
function renderConnectorTable(
	rows: { command: string; category: string; website: string }[],
): string {
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
		lines.push(`    Build a ${root.category} connector from scratch. Pass a URL pointing at the`);
		lines.push(`    provider's docs (homepage, SDK reference, GitHub repo, anything useful) as`);
		lines.push(`    the agent's starting point. Pipe to your coding agent.`);
	}
	return lines.join('\n');
}

function availableConnectorRows() {
	return CONNECTORS.map((c) => ({
		command: `flue add ${c.slug}`,
		category: c.category,
		website: c.website,
	}));
}

function printListing(stream: NodeJS.WriteStream) {
	stream.write('flue add <name>\n\n');
	stream.write('Available connectors:\n');
	stream.write(renderConnectorTable(availableConnectorRows()));
	stream.write('\n');
	const hint = categoryRootHint();
	if (hint) stream.write(`${hint}\n`);
}

function printUnknownConnector(name: string, stream: NodeJS.WriteStream) {
	stream.write(`Connector "${name}" not found.\n\n`);
	stream.write('Available connectors:\n');
	stream.write(renderConnectorTable(availableConnectorRows()));
	stream.write('\n');
	if (CATEGORY_ROOTS.length > 0) {
		stream.write('\nTo build one from scratch with your coding agent:\n');
		for (const root of CATEGORY_ROOTS) {
			stream.write(`  flue add <url> --category ${root.category}\n`);
		}
	}
}

async function fetchConnectorMarkdown(
	slug: string,
): Promise<{ body: string } | { notFound: true }> {
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

// ─── flue docs ───────────────────────────────────────────────────────────────

interface DocsPage {
	/** Page path without extension, e.g. `guide/sandboxes`. */
	path: string;
	title: string;
	description: string;
	/** Markdown body without frontmatter. */
	body: string;
}

/**
 * Locate the documentation markdown tree.
 *
 * For users of the published package this is always `<package root>/docs`,
 * placed there by `scripts/prepare-publish.mjs` at release time. Both `bin/`
 * (dev via tsx) and `dist/` (built) sit directly under the package root, so
 * the relative hop is identical in both contexts.
 *
 * The `apps/docs` candidate exists only for development inside the Flue
 * monorepo itself and can never resolve in a user's `node_modules`. It is
 * checked first because in a repo checkout the docs site content is the
 * source of truth, and a stale `<package root>/docs` snapshot left behind by
 * a local release (gitignored, only refreshed at the next release) must not
 * shadow it.
 */
function resolveDocsRoot(): string | undefined {
	const here = path.dirname(fileURLToPath(import.meta.url));
	const candidates = [
		path.join(here, '../../../apps/docs/src/content/docs'),
		path.join(here, '../docs'),
	];
	return candidates.find((candidate) => fs.existsSync(candidate));
}

function parseDocsFrontmatter(source: string): { data: Record<string, string>; body: string } {
	if (!source.startsWith('---\n')) return { data: {}, body: source };
	const end = source.indexOf('\n---\n', 4);
	if (end === -1) return { data: {}, body: source };

	const data: Record<string, string> = {};
	for (const line of source.slice(4, end).split('\n')) {
		const match = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
		const key = match?.[1];
		let value = match?.[2]?.trim();
		if (!key || value === undefined) continue;
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		data[key] = value;
	}
	return { data, body: source.slice(end + '\n---\n'.length) };
}

function loadDocsPages(root: string): DocsPage[] {
	const pages: DocsPage[] = [];
	for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
		if (!entry.isFile() || !/\.(md|mdx)$/.test(entry.name)) continue;
		const filePath = path.join(entry.parentPath, entry.name);
		const relative = path.relative(root, filePath).split(path.sep).join('/');
		const { data, body } = parseDocsFrontmatter(fs.readFileSync(filePath, 'utf8'));
		// `foo/index.md` is addressed as `foo`, matching the website's URLs.
		const pagePath = relative.replace(/\.(md|mdx)$/, '').replace(/\/index$/, '');
		pages.push({
			path: pagePath,
			title: data.title ?? relative,
			description: data.description ?? '',
			body,
		});
	}
	return pages.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Reduces markdown/MDX source to plain text for search indexing. This is
 * intentionally a lightweight approximation: minor artifacts are acceptable
 * since the output is only used for search matching and excerpts.
 */
function docsMarkdownToPlainText(source: string): string {
	return source
		.replace(/^(?:import|export)\s.*$/gm, '')
		.replace(/^```.*$/gm, '')
		.replace(/`([^`]*)`/g, '$1')
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/<\/?[A-Za-z][^>]*>/g, ' ')
		.replace(/^#{1,6}\s+/gm, '')
		.replace(/^>\s?/gm, '')
		.replace(/^\s*[-*+]\s+/gm, '')
		.replace(/^\s*\d+\.\s+/gm, '')
		.replace(/^\s*---+\s*$/gm, '')
		.replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')
		.replace(/(^|\s)_{1,3}([^_]+)_{1,3}(?=[\s.,;:!?)]|$)/g, '$1$2')
		.replace(/\|/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function extractDocsHeadings(source: string): string {
	const matches = [...source.matchAll(/^#{2,4}\s+(.+)$/gm)];
	return matches.map((match) => docsMarkdownToPlainText(match[1] ?? '')).join(' ');
}

const DOCS_EXCERPT_RADIUS = 120;

function buildDocsExcerpt(content: string, terms: string[]): string {
	const lowered = content.toLowerCase();
	let position = -1;
	for (const term of terms) {
		const index = lowered.indexOf(term.toLowerCase());
		if (index !== -1 && (position === -1 || index < position)) {
			position = index;
		}
	}
	if (position === -1) position = 0;

	const start = Math.max(0, position - DOCS_EXCERPT_RADIUS);
	const end = Math.min(content.length, position + DOCS_EXCERPT_RADIUS);
	const prefix = start > 0 ? '…' : '';
	const suffix = end < content.length ? '…' : '';
	return `${prefix}${content.slice(start, end).trim()}${suffix}`;
}

/** Accepts `guide/sandboxes`, `/docs/guide/sandboxes/`, full website URLs, and `.md`/`.mdx` paths. */
function normalizeDocsPath(input: string): string {
	let value = input.trim();
	if (/^https?:\/\//.test(value)) {
		try {
			value = new URL(value).pathname;
		} catch {
			// fall through with the raw value
		}
	}
	return value
		.replace(/^\.?\/+/, '')
		.replace(/^docs\//, '')
		.replace(/\/+$/, '')
		.replace(/\.(md|mdx)$/, '')
		.replace(/\/index$/, '');
}

function docsCommand(args: DocsArgs): void {
	const root = resolveDocsRoot();
	if (!root) {
		console.error(
			'[flue] Could not locate the bundled documentation. ' +
				'Your @flue/cli installation may be incomplete — try reinstalling it.',
		);
		process.exit(1);
	}
	const pages = loadDocsPages(root);

	if (args.action === 'list') {
		process.stderr.write(
			'Flue documentation\n\n' +
				'  flue docs read <path>      Print a documentation page as markdown\n' +
				'  flue docs search <query>   Search the documentation (JSON results)\n\n' +
				`Pages (${pages.length}):\n\n`,
		);
		const width = Math.max(...pages.map((page) => page.path.length));
		for (const page of pages) {
			process.stdout.write(`${page.path.padEnd(width)}  ${page.title}\n`);
		}
		return;
	}

	if (args.action === 'read') {
		const target = normalizeDocsPath(args.value);
		const page = pages.find((candidate) => candidate.path === target);
		if (!page) {
			console.error(
				`[flue] Unknown docs page: ${args.value}\n` +
					'Run `flue docs` to list available pages, or `flue docs search <query>` to find one.',
			);
			process.exit(1);
		}
		let output = `# ${page.title}\n`;
		if (page.description) output += `\n> ${page.description}\n`;
		output += `\n${page.body.trim()}\n`;
		process.stdout.write(output);
		return;
	}

	const index = new MiniSearch({
		idField: 'path',
		fields: ['title', 'headings', 'description', 'content'],
		storeFields: ['title', 'description', 'content'],
		searchOptions: {
			boost: { title: 4, headings: 3, description: 2 },
			prefix: true,
			fuzzy: 0.2,
		},
	});
	index.addAll(
		pages.map((page) => ({
			path: page.path,
			title: page.title,
			description: page.description,
			headings: extractDocsHeadings(page.body),
			content: docsMarkdownToPlainText(page.body),
		})),
	);

	const results = index
		.search(args.value)
		.slice(0, 8)
		.map((result) => ({
			path: result.id as string,
			title: result.title as string,
			description: (result.description as string) || undefined,
			excerpt: buildDocsExcerpt((result.content as string) ?? '', result.terms),
			score: Math.round(result.score * 100) / 100,
		}));

	process.stdout.write(`${JSON.stringify({ query: args.value, results }, null, 2)}\n`);
	process.stderr.write('\nRead a page with: flue docs read <path>\n');
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

/**
 * Shared tail of `flue add`: fetch the connector markdown for `slug`, then
 * either write it to stdout (agent mode / --print) or print human
 * instructions. `substituteUrl` replaces `{{URL}}` placeholders in
 * category-root markdown.
 */
async function emitConnectorMarkdown(
	args: AddArgs,
	opts: { slug: string; notFoundLabel: string; substituteUrl?: string },
) {
	const result = await fetchConnectorMarkdown(opts.slug);
	if ('notFound' in result) {
		console.error(
			`[flue] The connector registry did not have markdown for ${opts.notFoundLabel}. ` +
				`Your installed CLI may be out of sync with the registry — try updating @flue/cli.`,
		);
		process.exit(1);
	}

	const body =
		opts.substituteUrl === undefined
			? result.body
			: result.body.replaceAll('{{URL}}', opts.substituteUrl);

	const isAgentMode =
		args.print || (await determineAgent().catch(() => ({ isAgent: false }))).isAgent === true;
	if (isAgentMode) {
		process.stdout.write(body);
		if (!body.endsWith('\n')) process.stdout.write('\n');
		return;
	}
	printHumanInstructions(args);
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
		await emitConnectorMarkdown(args, {
			slug: args.category,
			notFoundLabel: `category "${args.category}"`,
			substituteUrl: args.name,
		});
		return;
	}

	const known = resolveConnector(args.name);
	if (!known) {
		printUnknownConnector(args.name, process.stderr);
		process.exit(1);
	}

	await emitConnectorMarkdown(args, { slug: known.slug, notFoundLabel: `"${known.slug}"` });
}

// ─── Entry Point ────────────────────────────────────────────────────────────

const args = parseArgs(process.argv.slice(2));

// `dev` manages its own supervisor shutdown; `logs` follow mode installs its
// own handlers that cancel the stream and flush buffers before exiting.
// Neither spawns a local process, so they skip the hard-exit handlers (which
// would otherwise run first in listener order and preempt graceful paths).
if (args.command !== 'dev' && args.command !== 'logs') {
	process.on('SIGINT', () => {
		stopLocalProcess();
		process.exit(130);
	});

	process.on('SIGTERM', () => {
		stopLocalProcess();
		process.exit(143);
	});
}

async function main() {
	if (args.command === 'build') {
		await buildCommand(args);
	} else if (args.command === 'dev') {
		if (process.env[INTERNAL_DEV_SESSION] === '1') {
			delete process.env[INTERNAL_DEV_SESSION];
			await devCommand(args);
		} else superviseDevCommand(args);
	} else if (args.command === 'add') {
		await addCommand(args);
	} else if (args.command === 'docs') {
		docsCommand(args);
	} else if (args.command === 'init') {
		initCommand(args);
	} else if (args.command === 'logs') {
		await logsCommand(args);
	} else if (args.command === 'connect') {
		await connectCommand(args);
	} else {
		await run(args);
	}
}

void main().catch((err) => {
	console.error(`[flue] ${err instanceof Error ? err.message : String(err)}`);
	stopLocalProcess();
	process.exit(1);
});
