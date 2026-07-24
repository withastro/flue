function encodeSegment(value: string): string {
	return Buffer.from(value).toString('base64url');
}

export class RedisKeys {
	readonly prefix: string;

	constructor(prefix = 'flue') {
		const normalized = prefix.replace(/:+$/g, '');
		if (!normalized) throw new TypeError('Redis key prefix must not be empty.');
		this.prefix = normalized;
	}

	key(...segments: string[]): string {
		return `${this.prefix}:${segments.join(':')}`;
	}

	encoded(kind: string, ...segments: string[]): string {
		return this.key(kind, ...segments.map(encodeSegment));
	}

	meta = () => this.key('meta');
	sequence = () => this.key('sequence', 'admission');
	submission = (id: string) => this.encoded('submission', id);
	submissionGeneration = (id: string, generation: string) =>
		this.encoded('submission-generation', id, generation);
	submissionGenerations = (id: string) => this.encoded('submission-generations', id);
	submissionReaders = (id: string) => this.encoded('submission-readers', id);
	submissionStatus = (status: string) => this.key('submissions', 'status', status);
	sessionUnsettled = (sessionKey: string) => this.encoded('session-unsettled', sessionKey);
	conversation = (path: string) => this.encoded('conversation', path);
	conversationBatches = (path: string) => this.encoded('conversation-batches', path);
	conversationOrder = (path: string) => this.encoded('conversation-order', path);
	conversationRetries = (path: string) => this.encoded('conversation-retries', path);
	attachment = (path: string, attachmentId: string) =>
		this.encoded('attachment', path, attachmentId);
	attachments = (path: string) => this.encoded('attachments', path);
}
