export class InvalidTeamsConversationKeyError extends Error {
	constructor() {
		super('Invalid Microsoft Teams conversation key.');
		this.name = 'InvalidTeamsConversationKeyError';
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
