import type { Command, SessionEnv } from './types.ts';

export async function createScopedEnv(env: SessionEnv, commands: Command[]): Promise<SessionEnv> {
	if (env.scope) return env.scope({ commands });
	if (commands.length > 0) {
		throw new Error(
			'[flue] Cannot use commands: this environment does not support scoped command execution. ' +
				'Commands are only available in BashFactory sandbox mode. ' +
				'Remote sandboxes handle command execution at the platform level.',
		);
	}
	return env;
}

export function mergeCommands(defaults: Command[], perCall: Command[] | undefined): Command[] {
	if (!perCall || perCall.length === 0) return defaults;
	if (defaults.length === 0) return perCall;
	const byName = new Map<string, Command>();
	for (const cmd of defaults) byName.set(cmd.name, cmd);
	for (const cmd of perCall) byName.set(cmd.name, cmd);
	return Array.from(byName.values());
}
