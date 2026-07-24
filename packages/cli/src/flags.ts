import { UsageError } from './errors.ts';

/**
 * Normalizers for cac's parsed option values. cac's parser (mri) has two
 * quirks the CLI must undo: numeric-looking values are coerced to numbers
 * (`--id 4821` → `4821`), and a repeated flag becomes an array instead of an
 * error. Every option value passes through one of these before use.
 */

export type CliOptions = Record<string, unknown>;

export function stringOption(
	options: CliOptions,
	key: string,
	flag: string,
	recovery?: { aliases?: readonly string[]; argv?: readonly string[] },
): string | undefined {
	const value = options[key];
	if (value === undefined) return undefined;
	if (Array.isArray(value)) throw new UsageError(`${flag} may only be passed once.`);
	if (typeof value === 'string') return value;
	if (typeof value === 'number') {
		// mri's number coercion is lossy (`--id 007` → 7, `--id 1e3` → 1000),
		// and string options carry user-chosen durable keys (ids, uids), so
		// the literal token is recovered from the command line instead of
		// re-stringifying the number. `recovery.argv` is a test seam.
		return recoverLiteralToken(
			recovery?.argv ?? process.argv,
			[flag, ...(recovery?.aliases ?? [])],
			value,
		);
	}
	// `true`/`false` (a bare or negated flag) — cac normally rejects these for
	// value-taking options before the action runs; guard anyway.
	throw new UsageError(`Missing value for ${flag}`);
}

/**
 * Find the literal command-line token mri coerced to `parsed`. Repeated flags
 * are rejected upstream (they parse to arrays), so at most one occurrence per
 * spelling exists before a bare `--`.
 */
function recoverLiteralToken(
	argv: readonly string[],
	spellings: readonly string[],
	parsed: number,
): string {
	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index];
		if (token === undefined || token === '--') break;
		for (const spelling of spellings) {
			if (token === spelling) {
				const next = argv[index + 1];
				if (next !== undefined && Number(next) === parsed) return next;
			} else if (token.startsWith(`${spelling}=`)) {
				const literal = token.slice(spelling.length + 1);
				if (Number(literal) === parsed) return literal;
			}
		}
	}
	// Defensive: recovery missed (an option spelling this module was not told
	// about) — fall back to the coerced value's canonical string.
	return String(parsed);
}

export function booleanOption(options: CliOptions, key: string): boolean {
	return options[key] === true;
}

export function jsonOption(options: CliOptions, key: string, flag: string): unknown {
	const raw = stringOption(options, key, flag);
	if (raw === undefined) return undefined;
	try {
		return JSON.parse(raw);
	} catch {
		throw new UsageError(`${flag} must be valid JSON, e.g. ${flag} '{"issue": 17307}'.`);
	}
}

/**
 * cac diverts everything after a bare `--` into `options['--']` instead of
 * treating it as positionals. No flue command forwards arguments, so reject
 * them the way extra positionals are rejected.
 */
export function rejectDoubleDashArgs(options: CliOptions, command: string): void {
	const rest = options['--'];
	if (Array.isArray(rest) && rest.length > 0) {
		throw new UsageError(`Unexpected extra arguments for \`flue ${command}\`: ${rest.join(' ')}`);
	}
}
