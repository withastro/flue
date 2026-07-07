export class InvalidA2AConversationKeyError extends Error {
	constructor() {
		super('Invalid A2A conversation key.');
		this.name = 'InvalidA2AConversationKeyError';
	}
}

export class InvalidA2AInputError extends TypeError {
	readonly field: string;

	constructor(field: string) {
		super(`Invalid A2A ${field}.`);
		this.name = 'InvalidA2AInputError';
		this.field = field;
	}
}
