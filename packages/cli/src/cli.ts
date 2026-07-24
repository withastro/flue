import { type CAC, cac } from 'cac';
import { registerBlueprintCommands } from './commands/blueprints.ts';
import { registerDocsCommand } from './commands/docs.ts';
import { registerInitCommand } from './commands/init.ts';
import { registerRunCommand } from './commands/run.ts';
import { helpCallback } from './help.ts';

export function buildCli(version: string): CAC {
	const cli = cac('flue');
	registerRunCommand(cli);
	registerInitCommand(cli);
	registerBlueprintCommands(cli);
	registerDocsCommand(cli);
	cli.help(helpCallback);
	// Feeds the help header and registers -v/--version; the flag itself is
	// intercepted in main.ts because cac's own output appends platform info
	// and the contract is the bare version string.
	cli.version(version);
	return cli;
}
