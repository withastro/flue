export class InvalidMessengerInputError extends TypeError {
	readonly field: string;

	constructor(field: string) {
		super(`Invalid Messenger channel input: ${field}.`);
		this.name = 'InvalidMessengerInputError';
		this.field = field;
	}
}

export class InvalidMessengerInstanceIdError extends TypeError {
	constructor() {
		super('Invalid Messenger instance id.');
		this.name = 'InvalidMessengerInstanceIdError';
	}
}
