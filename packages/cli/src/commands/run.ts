import * as fs from 'node:fs';
import path from 'node:path';
import { resolveFlueConfigPath } from '@flue/runtime/config';
import type { ConversationStreamChunk } from '@flue/sdk';
import type { CAC } from 'cac';
import pc from 'picocolors';
import { describeError, errorPayload, UsageError } from '../errors.ts';
import {
	booleanOption,
	type CliOptions,
	jsonOption,
	rejectDoubleDashArgs,
	stringOption,
} from '../flags.ts';
import { closeExecutionForSignal } from '../lib/console-shutdown.ts';
import { createEnvLoader, type EnvLoader, selectEnvFile } from '../lib/env.ts';
import { createLineEventPresenter } from '../lib/line-event-presenter.ts';
import { createLocalAgentRun } from '../lib/run-local.ts';
import { brandRows, error as cliError, row, success } from '../lib/terminal.ts';

/**
 * `flue run <path>` — transport-free, one-shot local agent execution. The
 * heavy lifting lives in src/lib/run-local.ts; this module owns flag
 * validation and terminal presentation.
 */

export function registerRunCommand(cli: CAC): void {
	cli
		.command('run <path>', 'Run one agent module locally, print its reply, then exit')
		.usage('run <path> --message <text> [options]')
		.option('-m, --message <text>', 'The user message submitted to the agent (required)')
		.option('--name <agent>', 'Which agent to run when the module defines several')
		.option('--id <id>', 'Conversation id to create or continue (default: a fresh id, printed)')
		.option(
			'--data <json>',
			'Creation data (JSON), read with useInitialData(); ignored on continues',
		)
		.option('--uid <uid>', 'Continue only the conversation incarnation with this uid')
		.option('--new', 'Create only: reject when the conversation id already exists')
		.option('--json', 'Print a JSON result envelope to stdout instead of the message text')
		.option('--env <path>', 'Load one alternate .env-format file before the run')
		.example('  $ flue run src/agents/hello.ts -m "Hi there"')
		.example('  $ flue run src/agents/hello.ts -m "And then?" --id support-4821 --env .env.staging')
		.action(runAction);
}

interface RunArgs {
	modulePath: string;
	/** Which agent to run, by name, when the module defines several. */
	agentName: string | undefined;
	message: string;
	id: string | undefined;
	initialData: unknown;
	/** Send condition: a string (--uid, continue-only) or null (--new, create-only). */
	uid: string | null | undefined;
	json: boolean;
	envFile: string | undefined;
}

function validateRunOptions(modulePath: string, options: CliOptions): RunArgs {
	rejectDoubleDashArgs(options, 'run');

	const message = stringOption(options, 'message', '--message', { aliases: ['-m'] });
	if (message === undefined) {
		throw new UsageError('`flue run` requires --message <text>.');
	}

	const envFile = stringOption(options, 'env', '--env');

	const initialData = jsonOption(options, 'data', '--data');
	const uid = stringOption(options, 'uid', '--uid');
	const createOnly = booleanOption(options, 'new');
	if (uid !== undefined && createOnly) {
		throw new UsageError(
			'`--uid` continues an existing instance and `--new` creates a fresh one — pass one or the other.',
		);
	}
	if (uid !== undefined && initialData !== undefined) {
		throw new UsageError(
			'`--uid` continues an existing instance, so `--data` could never apply. Pass one or the other.',
		);
	}

	return {
		modulePath,
		agentName: stringOption(options, 'name', '--name'),
		message,
		id: stringOption(options, 'id', '--id'),
		initialData,
		// The send condition: --uid <value> = continue-only, --new = create-only.
		uid: createOnly ? null : uid,
		json: booleanOption(options, 'json'),
		envFile,
	};
}

function loadRunEnvironment(envFile: string | undefined): EnvLoader {
	const cwd = process.cwd();
	const configPath = resolveFlueConfigPath({ cwd });
	const baseDir = configPath ? path.dirname(configPath) : cwd;
	const envLoader = createEnvLoader(selectEnvFile(envFile, baseDir));
	envLoader.apply();
	return envLoader;
}

function displayPath(root: string, filePath: string): string {
	const relative = path.relative(root, filePath);
	return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : filePath;
}

async function runAction(modulePath: string, options: CliOptions): Promise<void> {
	const args = validateRunOptions(modulePath, options);
	const envLoader = loadRunEnvironment(args.envFile);
	const stderrLine = (line: string) => process.stderr.write(`${line}\n`);
	// The presenter writes through process.stderr directly (not console.error)
	// so it is unaffected by the run's console redirection.
	const presenter = createLineEventPresenter({
		write: stderrLine,
		dim: pc.dim,
		textHeading: pc.bold('assistant'),
		textIndent: '  ',
	});
	const execution = createLocalAgentRun({
		modulePath: args.modulePath,
		agentName: args.agentName,
		message: args.message,
		initialData: args.initialData,
		uid: args.uid,
		conversationId: args.id,
		onEvent: (chunk) => presenter.present(chunk as ConversationStreamChunk),
		onRuntimeOutput: (line) => {
			if (line.trim()) stderrLine(pc.dim(line));
		},
		onReady: (info) => {
			brandRows('flue run', [
				['agent', info.identity],
				['id', info.conversationId],
				['config', info.configPath ? displayPath(info.root, info.configPath) : undefined],
				['db', info.dbEntry ?? info.dbPath],
				['env', fs.existsSync(envLoader.file) ? displayPath(info.root, envLoader.file) : undefined],
			]);
			stderrLine('');
			stderrLine(pc.bold('user'));
			for (const line of args.message.split('\n')) stderrLine(`  ${line}`);
			stderrLine('');
		},
	});
	// Handlers exist only while this execution is live: a signal drains it to
	// a bounded shutdown (exit 130/143, 5s cap) instead of dying mid-write.
	// Every other command keeps Node's default terminate-on-signal, so a
	// pending async operation elsewhere never makes Ctrl-C appear dead.
	const drainForSignal = (signal: NodeJS.Signals) => {
		void closeExecutionForSignal(signal, execution).catch((err) => {
			cliError(describeError(err));
		});
	};
	const onSigint = () => drainForSignal('SIGINT');
	const onSigterm = () => drainForSignal('SIGTERM');
	process.on('SIGINT', onSigint);
	process.on('SIGTERM', onSigterm);
	try {
		const result = await execution.start();
		presenter.flush();
		stderrLine('');
		if (result.outcome === 'completed') {
			if (args.json) {
				// The stable machine-readable envelope; documented in run-local.ts.
				console.log(
					JSON.stringify({
						id: result.conversationId,
						agent: result.identity,
						submissionId: result.submissionId,
						outcome: result.outcome,
						message: result.message,
						...(result.uid !== undefined ? { uid: result.uid } : {}),
					}),
				);
			} else if (result.message !== '') {
				console.log(result.message);
			}
			row('id', result.conversationId);
			if (result.uid !== undefined) row('uid', result.uid);
			success('agent completed');
		} else {
			if (args.json) {
				console.log(
					JSON.stringify({
						id: result.conversationId,
						agent: result.identity,
						submissionId: result.submissionId,
						outcome: result.outcome,
						...(result.uid !== undefined ? { uid: result.uid } : {}),
						...(result.error !== undefined ? { error: errorPayload(result.error) } : {}),
					}),
				);
			}
			row('id', result.conversationId);
			if (result.outcome === 'aborted') {
				cliError('Agent run aborted.');
				if (process.exitCode === undefined) process.exitCode = 130;
			} else {
				cliError(`Agent failed: ${describeError(result.error)}`);
				process.exitCode = 1;
			}
		}
	} catch (err) {
		presenter.flush();
		if (!execution.signal.aborted) {
			// Setup and admission failures (module resolution, config, persistence,
			// creation-data validation) surface here; agent-execution failures
			// settle and land in the branch above. Emit an envelope too, so `--json`
			// yields exactly one JSON object on stdout for every failure mode.
			if (args.json) {
				console.log(JSON.stringify({ outcome: 'error', error: errorPayload(err) }));
			}
			cliError(describeError(err));
			process.exitCode = 1;
		}
	} finally {
		process.off('SIGINT', onSigint);
		process.off('SIGTERM', onSigterm);
		try {
			await execution.close();
		} finally {
			envLoader.restore();
		}
	}
}
