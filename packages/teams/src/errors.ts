export class InvalidTeamsInstanceIdError extends Error {
	constructor() {
		super('Invalid Microsoft Teams instance id.');
		this.name = 'InvalidTeamsInstanceIdError';
	}
}

export class InvalidTeamsInputError extends TypeError {
	readonly field: string;

	constructor(field: string) {
		super(`Invalid Microsoft Teams ${field}.`);
		this.name = 'InvalidTeamsInputError';
		this.field = field;
	}
}
