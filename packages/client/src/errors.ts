/**
 * Error thrown when skill result extraction or validation fails.
 */
export class SkillOutputError extends Error {
	sessionId: string;
	rawOutput: string;
	validationErrors?: unknown;

	constructor(
		message: string,
		opts: { sessionId: string; rawOutput: string; validationErrors?: unknown },
	) {
		super(message);
		this.name = 'SkillOutputError';
		this.sessionId = opts.sessionId;
		this.rawOutput = opts.rawOutput;
		this.validationErrors = opts.validationErrors;
	}
}

/**
 * Error thrown when a shell command exits with a non-zero code and
 * `throwOnError` is enabled.
 */
export class ShellCommandError extends Error {
	command: string;
	stdout: string;
	stderr: string;
	exitCode: number;

	constructor(
		command: string,
		opts: { stdout: string; stderr: string; exitCode: number },
	) {
		const details = opts.stderr.trim() || opts.stdout.trim();
		super(
			details
				? `[flue] Shell command failed with exit code ${opts.exitCode}: ${command}\n${details}`
				: `[flue] Shell command failed with exit code ${opts.exitCode}: ${command}`,
		);
		this.name = 'ShellCommandError';
		this.command = command;
		this.stdout = opts.stdout;
		this.stderr = opts.stderr;
		this.exitCode = opts.exitCode;
	}
}
