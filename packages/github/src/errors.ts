export class InvalidGitHubInstanceIdError extends Error {
	constructor() {
		super('Invalid GitHub instance id.');
		this.name = 'InvalidGitHubInstanceIdError';
	}
}

export class InvalidGitHubInputError extends TypeError {
	readonly field: string;

	constructor(field: string) {
		super(`Invalid GitHub ${field}.`);
		this.name = 'InvalidGitHubInputError';
		this.field = field;
	}
}
