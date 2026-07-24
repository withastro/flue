export class InvalidDiscordInstanceIdError extends Error {
	constructor() {
		super('Invalid Discord instance id.');
		this.name = 'InvalidDiscordInstanceIdError';
	}
}

export class InvalidDiscordInputError extends TypeError {
	readonly field: string;

	constructor(field: string) {
		super(`Invalid Discord ${field}.`);
		this.name = 'InvalidDiscordInputError';
		this.field = field;
	}
}
