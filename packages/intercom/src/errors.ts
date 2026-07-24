export class InvalidIntercomInputError extends TypeError {
	readonly field: string;

	constructor(field: string) {
		super(`Invalid Intercom channel input: ${field}.`);
		this.name = 'InvalidIntercomInputError';
		this.field = field;
	}
}

export class InvalidIntercomInstanceIdError extends TypeError {
	constructor() {
		super('Invalid Intercom instance id.');
		this.name = 'InvalidIntercomInstanceIdError';
	}
}
