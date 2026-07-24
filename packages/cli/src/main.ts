#!/usr/bin/env node
import { buildCli } from './cli.ts';
import { describeError, formatCliError, suggestCommand } from './errors.ts';
import { printHelpToStderr } from './help.ts';
import { readCliVersion } from './lib/package-root.ts';
import { error as cliError, note } from './lib/terminal.ts';

// Signal handling stays with Node's default terminate-on-signal for every
// command; only a live `flue run` execution installs handlers (commands/run.ts)
// to drain to a bounded shutdown. Installing handlers here would suppress the
// default and leave commands with a pending async operation un-interruptible.

const version = readCliVersion();
const cli = buildCli(version);

/** No matching command: removed/unknown name or no arguments at all. */
function handleUnknownCommand(command: string | undefined): void {
	if (command !== undefined) {
		cliError(`Unknown command \`${command}\`.`);
		const suggestion = suggestCommand(command, [
			...cli.commands.map((entry) => entry.name),
			'help',
		]);
		if (suggestion) note(`Did you mean \`flue ${suggestion}\`?`);
		console.error('');
	}
	printHelpToStderr(cli);
	process.exitCode = 1;
}

async function main(): Promise<void> {
	const first = process.argv[2];

	// Bare version string; cac's own --version output appends platform info.
	if (first === '-v' || first === '--version') {
		console.log(version);
		return;
	}
	if (first === 'help') {
		cli.outputHelp();
		return;
	}

	try {
		cli.parse(process.argv, { run: false });
		if (!cli.matchedCommand) {
			// `--help` anywhere on the line is handled (and printed) by parse().
			if (!cli.options.help) handleUnknownCommand(cli.args[0]);
			return;
		}
		await cli.runMatchedCommand();
	} catch (err) {
		const { message, hint } = formatCliError(err, cli);
		cliError(message);
		if (hint) note(hint);
		if (process.exitCode === undefined) process.exitCode = 1;
	}
}

void main().then(
	() => {
		// `flue run` may leave db/Vite handles that hold the event loop open
		// after settlement; every other command exits naturally.
		if (cli.matchedCommandName === 'run') process.exit(process.exitCode ?? 0);
	},
	(err) => {
		// Defensive: main() handles expected errors itself. Landing here is a
		// CLI bug, not a usage mistake.
		cliError(describeError(err));
		process.exit(process.exitCode === undefined || process.exitCode === 0 ? 1 : process.exitCode);
	},
);
