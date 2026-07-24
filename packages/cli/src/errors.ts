import type { CAC } from 'cac';

/**
 * A user-facing usage mistake (bad flag combination, missing argument, …).
 * Thrown by command actions and flag normalizers; the entry point prints the
 * message once and exits 1. `hint` overrides the default "run --help" hint;
 * `null` suppresses the hint entirely (for messages that already say what
 * to do instead).
 */
export class UsageError extends Error {
	readonly hint: string | null | undefined;

	constructor(message: string, options?: { hint?: string | null }) {
		super(message);
		this.name = 'UsageError';
		this.hint = options?.hint;
	}
}

export interface FormattedCliError {
	message: string;
	/** A dim follow-up line (help pointer, did-you-mean), when one applies. */
	hint?: string;
}

/**
 * Format any error thrown while parsing or running a command. cac's own
 * parser errors (name `CACError`) are rephrased into the CLI's voice; other
 * errors pass through with their message.
 */
export function formatCliError(error: unknown, cli: CAC): FormattedCliError {
	const command = cli.matchedCommandName;
	const helpHint = command
		? `Run \`flue ${command} --help\` for usage.`
		: 'Run `flue --help` for usage.';

	if (error instanceof UsageError) {
		if (error.hint === null) return { message: error.message };
		return { message: error.message, hint: error.hint ?? helpHint };
	}

	if (error instanceof Error && error.name === 'CACError') {
		const unknownFlag = /^Unknown option `(.+)`$/.exec(error.message);
		if (unknownFlag) {
			return { message: `Unknown flag for \`flue ${command}\`: ${unknownFlag[1]}`, hint: helpHint };
		}
		const missingValue = /^option `(.+)` value is missing$/.exec(error.message);
		if (missingValue) {
			const flag = /--[A-Za-z][\w-]*/.exec(missingValue[1] ?? '')?.[0] ?? missingValue[1];
			return { message: `Missing value for ${flag}`, hint: helpHint };
		}
		const unusedArgs = /^Unused args: (.+)$/.exec(error.message);
		if (unusedArgs) {
			const extras = (unusedArgs[1] ?? '').replaceAll('`', '').split(', ').join(' ');
			return {
				message: `Unexpected extra arguments for \`flue ${command}\`: ${extras}`,
				hint: helpHint,
			};
		}
		if (/^missing required args for command/.test(error.message)) {
			return { message: describeMissingArgs(cli, command), hint: helpHint };
		}
		return { message: error.message, hint: helpHint };
	}

	return { message: describeError(error) };
}

/**
 * cac reports too-few positionals generically; rephrase per command. Only
 * commands declaring required positionals (`<...>`) can land here.
 */
function describeMissingArgs(cli: CAC, command: string | undefined): string {
	if (command === 'run') return 'Missing agent module path for `flue run`.';
	if (command === 'update') {
		return cli.args.length === 0
			? 'Missing blueprint kind and name or URL for `flue update`.'
			: 'Missing blueprint name or URL for `flue update`.';
	}
	return `Missing required arguments for \`flue ${command}\`.`;
}

/**
 * Best-effort message extraction for non-CLI errors. Flue errors carry the
 * caller-safe specifics in `details` (the message itself is deliberately
 * generic) — surface them.
 */
export function describeError(error: unknown): string {
	if (error instanceof Error) {
		const details = (error as { details?: unknown }).details;
		return typeof details === 'string' && details.trim() !== ''
			? `${error.message} ${details}`
			: error.message;
	}
	if (typeof error === 'string') return error;
	if (error && typeof error === 'object' && 'message' in error) {
		const message = (error as { message: unknown }).message;
		if (typeof message === 'string') return message;
	}
	return JSON.stringify(error);
}

/**
 * The `--json` envelope's error payload. Uniform across settlement failures
 * (`result.error`, possibly a serialized FlueError) and setup failures (a
 * thrown error): `message` always; `type`/`details`/`dev` when the underlying
 * error is a FlueError. `dev` carries developer-only guidance (may include
 * local paths) — surfaced because the CLI's audience is the local developer.
 */
export function errorPayload(error: unknown): {
	message: string;
	type?: string;
	details?: string;
	dev?: string;
} {
	const str = (value: unknown): string | undefined =>
		typeof value === 'string' && value.trim() !== '' ? value : undefined;
	if (error && typeof error === 'object') {
		const fields = error as Record<string, unknown>;
		return {
			message: str(fields.message) ?? describeError(error),
			...(str(fields.type) ? { type: fields.type as string } : {}),
			...(str(fields.details) ? { details: fields.details as string } : {}),
			...(str(fields.dev) ? { dev: fields.dev as string } : {}),
		};
	}
	return { message: describeError(error) };
}

/** Levenshtein distance, for `Did you mean …?` command suggestions. */
function editDistance(a: string, b: string): number {
	let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
	for (let i = 1; i <= a.length; i++) {
		const current = [i];
		for (let j = 1; j <= b.length; j++) {
			const substitution = a[i - 1] === b[j - 1] ? 0 : 1;
			current.push(
				Math.min(
					(previous[j] ?? 0) + 1,
					(current[j - 1] ?? 0) + 1,
					(previous[j - 1] ?? 0) + substitution,
				),
			);
		}
		previous = current;
	}
	return previous[b.length] ?? 0;
}

export function suggestCommand(input: string, commands: readonly string[]): string | undefined {
	let best: { name: string; distance: number } | undefined;
	for (const name of commands) {
		const distance = editDistance(input.toLowerCase(), name.toLowerCase());
		if (distance <= 2 && (best === undefined || distance < best.distance)) {
			best = { name, distance };
		}
	}
	return best?.name;
}
