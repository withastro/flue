import * as fs from 'node:fs';
import path from 'node:path';
import { resolveFlueConfigPath } from '@flue/runtime/config';
import type { CAC } from 'cac';
import { UsageError } from '../errors.ts';
import { booleanOption, type CliOptions, rejectDoubleDashArgs, stringOption } from '../flags.ts';
import {
	detectPackageManager,
	type InitTarget,
	initNextSteps,
	planInitFiles,
} from '../lib/init.ts';
import { readCliVersion } from '../lib/package-root.ts';
import { brand, note } from '../lib/terminal.ts';

/** `flue init` — scaffold a new Flue project, interactively when possible. */

export function registerInitCommand(cli: CAC): void {
	cli
		.command('init [directory]', 'Initialize a new Flue project (interactive)')
		.option('--target <target>', 'Build target: node or cloudflare (prompted for when omitted)')
		.option('--deploy', 'Include the HTTP server setup (vite.config.ts, src/app.ts, hono)')
		.option('--root <path>', 'Directory to scaffold into; same as the positional argument')
		.option(
			'--force',
			'Scaffold into a non-empty directory and overwrite an existing flue.config.*',
		)
		.example('  $ flue init')
		.example('  $ flue init ./my-agent-app')
		.example('  $ flue init --target node --deploy')
		.action(initAction);
}

interface InitArgs {
	/** Build target; prompted for when omitted. */
	target: InitTarget | undefined;
	/** Include the HTTP server setup. Implied by the cloudflare target. */
	deploy: boolean;
	/** Resolved target directory, or undefined to default to cwd. */
	explicitRoot: string | undefined;
	force: boolean;
}

function validateInitOptions(directory: string | undefined, options: CliOptions): InitArgs {
	rejectDoubleDashArgs(options, 'init');

	const target = stringOption(options, 'target', '--target');
	if (target !== undefined && target !== 'node' && target !== 'cloudflare') {
		throw new UsageError(`Invalid target: "${target}". Supported targets: node, cloudflare`);
	}

	const root = stringOption(options, 'root', '--root');
	if (directory !== undefined && root !== undefined) {
		throw new UsageError('Pass the directory as an argument or with --root, not both.');
	}
	const explicit = directory ?? root;

	return {
		target,
		deploy: booleanOption(options, 'deploy'),
		explicitRoot: explicit !== undefined ? path.resolve(explicit) : undefined,
		force: booleanOption(options, 'force'),
	};
}

/**
 * Resolve the build target and the deploy choice from flags where given,
 * interactively otherwise. The questions are conversational, but every
 * answer translates to the two knobs: running locally is the Node target
 * without the server setup, and the Cloudflare target always deploys.
 */
async function resolveInitChoices(
	args: InitArgs,
): Promise<{ target: InitTarget; deploy: boolean }> {
	if (args.target !== undefined) {
		return { target: args.target, deploy: args.deploy || args.target === 'cloudflare' };
	}

	if (!process.stdin.isTTY || !process.stderr.isTTY) {
		throw new UsageError(
			'flue init cannot prompt here. Pass --target <node|cloudflare> (plus --deploy for the server setup).',
		);
	}

	// Loaded lazily: only the interactive path needs it.
	const { default: prompts } = await import('prompts');
	const io = { stdin: process.stdin, stdout: process.stderr };
	const onCancel = () => process.exit(130);

	let deploy = args.deploy;
	if (!deploy) {
		const setup = await prompts(
			{
				type: 'select',
				name: 'setup',
				message: 'What are you setting up?',
				choices: [
					{
						title: 'Run locally',
						description: 'talk to agents from your terminal with flue run',
						value: 'local',
					},
					{
						title: 'Deploy',
						description: 'serve agents over HTTP with a dev server and a build',
						value: 'deploy',
					},
					{ title: 'Both', description: 'local runs plus the full server setup', value: 'both' },
				],
				...io,
			},
			{ onCancel },
		);
		if (setup.setup === 'local') return { target: 'node', deploy: false };
		deploy = true;
	}

	const answer = await prompts(
		{
			type: 'select',
			name: 'target',
			message: 'Where will you deploy?',
			choices: [
				{ title: 'Cloudflare', description: 'Workers + Durable Objects', value: 'cloudflare' },
				{
					title: 'Node.js',
					description: 'a standard Node server you can host anywhere',
					value: 'node',
				},
			],
			...io,
		},
		{ onCancel },
	);
	return { target: answer.target as InitTarget, deploy };
}

function displayPath(root: string, filePath: string): string {
	const relative = path.relative(root, filePath);
	return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : filePath;
}

async function initAction(directory: string | undefined, options: CliOptions): Promise<void> {
	const args = validateInitOptions(directory, options);
	const targetDir = args.explicitRoot ?? process.cwd();

	// `flue init ./my-app` may name a directory that doesn't exist yet.
	try {
		fs.mkdirSync(targetDir, { recursive: true });
	} catch (err) {
		throw new Error(
			`Cannot use ${targetDir} as the target directory: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	// Detect any existing flue.config.* in the target dir, using the same
	// discovery rule the rest of the CLI uses. This catches `.mts`, `.js`,
	// etc. — not just `.ts`.
	const existing = resolveFlueConfigPath({ cwd: targetDir });

	if (existing && !args.force) {
		const rel = path.relative(process.cwd(), existing) || existing;
		throw new UsageError(
			`A Flue config already exists at ${rel}.\n  Re-run with --force to overwrite.`,
			{ hint: null },
		);
	}

	// Scaffolding into a directory that already has files is allowed, but
	// must be deliberate: confirm interactively, or require --force where
	// prompting is impossible.
	if (!args.force && fs.readdirSync(targetDir).length > 0) {
		const where =
			targetDir === process.cwd() ? 'The current directory' : displayPath(process.cwd(), targetDir);
		if (!process.stdin.isTTY || !process.stderr.isTTY) {
			throw new UsageError(
				`${where} is not empty.\n  Re-run with --force to scaffold into it anyway.`,
				{ hint: null },
			);
		}
		const { default: prompts } = await import('prompts');
		const answer = await prompts(
			{
				type: 'confirm',
				name: 'proceed',
				message: `${where} is not empty. Scaffold into it anyway?`,
				initial: false,
				stdin: process.stdin,
				stdout: process.stderr,
			},
			{ onCancel: () => process.exit(130) },
		);
		if (!answer.proceed) process.exit(1);
	}

	const { target, deploy } = await resolveInitChoices(args);
	const planOptions = {
		target,
		deploy,
		targetDir,
		cliVersion: readCliVersion(),
		packageManager: detectPackageManager(),
	};

	// The project skeleton. Every file is created only when absent, unless
	// --force is passed — then flue init overwrites the whole skeleton.
	const files = planInitFiles(planOptions);

	// Reported paths are project-relative; the summary line names the
	// directory when it isn't the cwd.
	const wrote: string[] = [];
	const skipped: string[] = [];
	for (const file of files) {
		const outPath = path.join(targetDir, file.relPath);
		if (!args.force && fs.existsSync(outPath)) {
			skipped.push(file.relPath);
			continue;
		}
		try {
			fs.mkdirSync(path.dirname(outPath), { recursive: true });
			fs.writeFileSync(outPath, file.content);
		} catch (err) {
			throw new Error(
				`Failed to write ${outPath}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		wrote.push(file.relPath);
	}

	const where = targetDir === process.cwd() ? '' : ` in ${displayPath(process.cwd(), targetDir)}`;
	const summary = `target ${target}${deploy ? '' : ', local runs only'}${where}`;
	console.error(brand(['flue init', summary, `wrote ${wrote.join(', ')}`]));
	if (skipped.length > 0) {
		note(`kept existing ${skipped.join(', ')}`);
	}

	// If --force overwrote a non-`.ts` variant, the new flue.config.ts will
	// take precedence (FLUE_CONFIG_BASENAMES priority), but the old file still
	// sits on disk. Surface that so the user isn't surprised later.
	if (existing && path.basename(existing) !== 'flue.config.ts') {
		const relExisting = path.relative(process.cwd(), existing) || existing;
		note(
			`${relExisting} is still on disk. flue.config.ts now takes precedence; delete the old file if you no longer need it.`,
		);
	}

	console.error('');
	note('next steps:');
	for (const [index, step] of initNextSteps(planOptions).entries()) {
		note(`  ${index + 1}. ${step}`);
	}
}
