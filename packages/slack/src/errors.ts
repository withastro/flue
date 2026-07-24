export class InvalidSlackInstanceIdError extends Error {
	constructor() {
		super('Invalid Slack instance id.');
		this.name = 'InvalidSlackInstanceIdError';
	}
}

export class InvalidSlackInputError extends TypeError {
	readonly field: string;

	constructor(field: string) {
		super(`Invalid Slack ${field}.`);
		this.name = 'InvalidSlackInputError';
		this.field = field;
	}
}
