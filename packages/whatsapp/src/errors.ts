export class InvalidWhatsAppInputError extends TypeError {
	readonly field: string;

	constructor(field: string) {
		super(`Invalid WhatsApp channel input: ${field}.`);
		this.name = 'InvalidWhatsAppInputError';
		this.field = field;
	}
}

export class InvalidWhatsAppInstanceIdError extends TypeError {
	constructor() {
		super('Invalid WhatsApp instance id.');
		this.name = 'InvalidWhatsAppInstanceIdError';
	}
}
