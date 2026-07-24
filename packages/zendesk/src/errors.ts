/** Thrown when a ticket reference contains an invalid field. */
export class InvalidZendeskInputError extends TypeError {
	/** Invalid input field path. */
	readonly field: string;

	constructor(field: string) {
		super(`Invalid Zendesk channel input: ${field}.`);
		this.name = 'InvalidZendeskInputError';
		this.field = field;
	}
}

/** Thrown when an instance id is malformed or non-canonical. */
export class InvalidZendeskInstanceIdError extends TypeError {
	constructor() {
		super('Invalid Zendesk instance id.');
		this.name = 'InvalidZendeskInstanceIdError';
	}
}
