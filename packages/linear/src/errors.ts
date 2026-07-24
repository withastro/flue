export class InvalidLinearInputError extends TypeError {
	readonly field: string;

	constructor(field: string) {
		super(`Invalid Linear channel input: ${field}.`);
		this.name = 'InvalidLinearInputError';
		this.field = field;
	}
}

export class InvalidLinearInstanceIdError extends TypeError {
	constructor() {
		super('Invalid Linear instance id.');
		this.name = 'InvalidLinearInstanceIdError';
	}
}
