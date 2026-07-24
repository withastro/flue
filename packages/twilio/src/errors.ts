export class InvalidTwilioInputError extends TypeError {
	readonly field: string;

	constructor(field: string) {
		super(`Invalid Twilio channel input: ${field}.`);
		this.name = 'InvalidTwilioInputError';
		this.field = field;
	}
}

export class InvalidTwilioInstanceIdError extends TypeError {
	constructor() {
		super('Invalid Twilio instance id.');
		this.name = 'InvalidTwilioInstanceIdError';
	}
}
