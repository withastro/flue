import { determineAgent } from '@vercel/detect-agent';
import type { CAC } from 'cac';
import { UsageError } from '../errors.ts';
import { booleanOption, type CliOptions, rejectDoubleDashArgs } from '../flags.ts';
import { BLUEPRINTS, KIND_ROOTS } from '../generated/blueprints.ts';

/**
 * `flue add` / `flue update` — fetch a blueprint implementation guide from
 * the registry for an AI coding agent to follow. Both commands share the
 * same machinery; `update` fetches the upgrade variant of a guide and
 * requires an explicit kind + name.
 */

export function registerBlueprintCommands(cli: CAC): void {
	cli
		.command(
			'add [kind] [name|url]',
			'Fetch a blueprint implementation guide (no args: list blueprints)',
		)
		.usage('add [<kind> <name|url>] [options]')
		.option('--print', 'Print the raw blueprint Markdown to stdout even for a non-agent caller')
		.example('  $ flue add')
		.example('  $ flue add sandbox daytona | claude')
		.example('  $ flue add channel https://developers.notion.com/reference/webhooks | codex')
		.action((kind: string | undefined, name: string | undefined, options: CliOptions) =>
			blueprintAction('add', kind, name, options),
		);

	cli
		.command('update <kind> <name|url>', 'Fetch an updated blueprint implementation guide')
		.usage('update <kind> <name|url> [options]')
		.option('--print', 'Print the raw blueprint Markdown to stdout even for a non-agent caller')
		.example('  $ flue update channel slack | claude')
		.action((kind: string, name: string, options: CliOptions) =>
			blueprintAction('update', kind, name, options),
		);
}

interface BlueprintArgs {
	command: 'add' | 'update';
	kind: string;
	target: string;
	print: boolean;
}

async function blueprintAction(
	command: 'add' | 'update',
	kind: string | undefined,
	name: string | undefined,
	options: CliOptions,
): Promise<void> {
	rejectDoubleDashArgs(options, command);
	const print = booleanOption(options, 'print');

	if (command === 'add' && kind === undefined) {
		printListing(process.stderr);
		return;
	}
	if (kind === undefined || name === undefined) {
		throw new UsageError(`Missing blueprint name or URL for \`flue ${command}\`.`);
	}

	const args: BlueprintArgs = { command, kind, target: name, print };

	const root = KIND_ROOTS.find((entry) => entry.kind === args.kind);
	if (!root) {
		throw new UsageError(
			`Unknown blueprint kind "${args.kind}". Known kinds: ${KIND_ROOTS.map((entry) => entry.kind).join(', ') || '(none)'}`,
		);
	}

	// A URL in the name position selects the kind-root blueprint: a
	// build-from-scratch guide with the URL substituted in as the agent's
	// starting point.
	let url: URL | undefined;
	try {
		url = new URL(args.target);
	} catch {}

	if (url) {
		await emitBlueprintMarkdown(args, {
			slug: root.kind,
			notFoundLabel: `kind "${args.kind}"`,
			substituteUrl: args.target,
		});
		return;
	}

	const known = resolveBlueprint(args.kind, args.target);
	if (!known) {
		printUnknownBlueprint(args.kind, args.target, process.stderr);
		process.exitCode = 1;
		return;
	}

	await emitBlueprintMarkdown(args, { slug: known.slug, notFoundLabel: `"${known.slug}"` });
}

// ─── Registry ───────────────────────────────────────────────────────────────

// Default blueprint registry base. FLUE_REGISTRY_URL is an internal-only
// override used for local development against `pnpm --filter @flue/www dev`.
const DEFAULT_REGISTRY_URL = 'https://flueframework.com/cli/blueprints';

// Bound on one registry fetch — a blackholed connection must fail with a
// diagnosis, not hold the command until the OS gives up on the socket.
// FLUE_REGISTRY_TIMEOUT_MS is an internal-only override used by tests.
const REGISTRY_FETCH_TIMEOUT_MS = 30_000;

function registryUrlFor(slug: string): string {
	const base = (process.env.FLUE_REGISTRY_URL ?? DEFAULT_REGISTRY_URL).replace(/\/+$/, '');
	return `${base}/${slug}.md`;
}

function resolveBlueprint(kind: string, name: string): (typeof BLUEPRINTS)[number] | undefined {
	const blueprints = BLUEPRINTS.filter((blueprint) => blueprint.kind === kind);
	const lower = name.toLowerCase();
	return blueprints.find(
		(blueprint) =>
			blueprint.slug.toLowerCase() === lower ||
			blueprint.aliases.some((alias) => alias.toLowerCase() === lower),
	);
}

async function fetchBlueprintMarkdown(
	slug: string,
): Promise<{ body: string } | { notFound: true }> {
	const url = registryUrlFor(slug);
	const timeoutMs = Number(process.env.FLUE_REGISTRY_TIMEOUT_MS) || REGISTRY_FETCH_TIMEOUT_MS;
	let res: Response;
	try {
		res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
	} catch (err) {
		if (err instanceof Error && err.name === 'TimeoutError') {
			throw new Error(
				`Timed out after ${timeoutMs}ms waiting for the blueprint registry at ${url}.`,
			);
		}
		throw new Error(
			`Failed to reach the blueprint registry at ${url}.\n  ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	if (res.status === 404) return { notFound: true };
	if (!res.ok) {
		throw new Error(`Blueprint registry returned HTTP ${res.status} for ${url}.`);
	}
	return { body: await res.text() };
}

/**
 * Shared tail of blueprint commands: fetch blueprint Markdown for `slug`, then write
 * it to stdout in agent mode or print human instructions. `substituteUrl`
 * replaces `{{URL}}` placeholders in kind-root blueprints.
 */
async function emitBlueprintMarkdown(
	args: BlueprintArgs,
	opts: { slug: string; notFoundLabel: string; substituteUrl?: string },
): Promise<void> {
	const result = await fetchBlueprintMarkdown(opts.slug);
	if ('notFound' in result) {
		throw new Error(
			`The blueprint registry did not have Markdown for ${opts.notFoundLabel}. Your installed CLI may be out of sync with the registry — try updating @flue/cli.`,
		);
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

// ─── Presentation ───────────────────────────────────────────────────────────

/**
 * Render a 3-column table aligned by the longest entry. Simple and
 * intentionally unfussy — blueprint listings are always small.
 */
function renderBlueprintTable(rows: { command: string; kind: string; website: string }[]): string {
	if (rows.length === 0) return '  (none)';
	const commandWidth = Math.max(...rows.map((row) => row.command.length));
	const kindWidth = Math.max(...rows.map((row) => row.kind.length));
	const gap = '     ';
	return rows
		.map(
			(row) =>
				`  ${row.command.padEnd(commandWidth)}${gap}${row.kind.padEnd(kindWidth)}${gap}${row.website}`,
		)
		.join('\n');
}

const blueprintResultByKind: Record<string, string> = {
	sandbox: 'sandbox adapter',
	database: 'database adapter',
	channel: 'channel',
	tooling: 'tooling integration',
};

function kindRootHint(): string {
	if (KIND_ROOTS.length === 0) return '';
	const lines: string[] = [];
	lines.push('');
	lines.push(`Don't see what you need?`);
	for (const root of KIND_ROOTS) {
		lines.push('');
		lines.push(`  flue add ${root.kind} <url>`);
		lines.push(
			`    Build a ${blueprintResultByKind[root.kind] ?? root.kind} from scratch. Pass a URL pointing at the`,
		);
		lines.push(`    provider's docs (homepage, SDK reference, GitHub repo, anything useful) as`);
		lines.push(`    the agent's starting point. Pipe to your coding agent.`);
	}
	return lines.join('\n');
}

function availableBlueprintRows(kind?: string) {
	return BLUEPRINTS.filter((blueprint) => !kind || blueprint.kind === kind).map((blueprint) => ({
		command: `flue add ${blueprint.kind} ${blueprint.slug}`,
		kind: blueprint.kind,
		website: blueprint.website,
	}));
}

function printListing(stream: NodeJS.WriteStream): void {
	stream.write('flue add <kind> <name|url>\n\n');
	stream.write('Available blueprints:\n');
	stream.write(renderBlueprintTable(availableBlueprintRows()));
	stream.write('\n');
	const hint = kindRootHint();
	if (hint) stream.write(`${hint}\n`);
}

function printUnknownBlueprint(kind: string, name: string, stream: NodeJS.WriteStream): void {
	stream.write(`Blueprint "${name}" not found for kind "${kind}".\n\n`);
	stream.write(`Available ${kind} blueprints:\n`);
	stream.write(renderBlueprintTable(availableBlueprintRows(kind)));
	stream.write('\n\nTo build one from scratch with your coding agent:\n');
	stream.write(`  flue add ${kind} <url>\n`);
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function printHumanInstructions(args: BlueprintArgs): void {
	const cmd = `flue ${args.command} ${args.kind} ${shellQuote(args.target)}`;
	const stream = process.stderr;
	stream.write(`${cmd}\n\n`);
	stream.write('To apply this blueprint, pipe it to your coding agent:\n\n');
	stream.write(`  ${cmd} --print | claude\n`);
	stream.write(`  ${cmd} --print | codex\n`);
	stream.write(`  ${cmd} --print | cursor-agent\n`);
	stream.write(`  ${cmd} --print | opencode\n`);
	stream.write(`  ${cmd} --print | pi\n\n`);
	stream.write('Or paste this prompt into any agent:\n\n');
	stream.write(`  Run "${cmd} --print" and follow the instructions.\n`);
}
