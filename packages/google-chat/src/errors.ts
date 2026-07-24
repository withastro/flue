export class InvalidGoogleChatInputError extends TypeError {
	readonly field: string;

	constructor(field: string) {
		super(`Invalid Google Chat channel input: ${field}.`);
		this.name = 'InvalidGoogleChatInputError';
		this.field = field;
	}
}

export class InvalidGoogleChatInstanceIdError extends TypeError {
	constructor() {
		super('Invalid Google Chat instance id.');
		this.name = 'InvalidGoogleChatInstanceIdError';
	}
}
