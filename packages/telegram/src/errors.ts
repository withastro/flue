export class InvalidTelegramInputError extends TypeError {
	readonly field: string;

	constructor(field: string) {
		super(`Invalid Telegram channel input: ${field}.`);
		this.name = 'InvalidTelegramInputError';
		this.field = field;
	}
}

export class InvalidTelegramInstanceIdError extends TypeError {
	constructor() {
		super('Invalid Telegram instance id.');
		this.name = 'InvalidTelegramInstanceIdError';
	}
}
