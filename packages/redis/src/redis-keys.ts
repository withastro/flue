export function encodeSegment(value: string): string {
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
	submissionIds = () => this.key('submissions');
	submissionOrder = () => this.key('submissions', 'order');
	submissionStatus = (status: string) => this.key('submissions', 'status', status);
	sessionSubmissions = (sessionKey: string) => this.encoded('session-submissions', sessionKey);
	sessionUnsettled = (sessionKey: string) => this.encoded('session-unsettled', sessionKey);
	journal = (submissionId: string) => this.encoded('journal', submissionId);
	journals = () => this.key('journals');
	receipt = (id: string) => this.encoded('receipt', id);
	marker = (submissionId: string, attemptId: string) =>
		this.encoded('marker', submissionId, attemptId);
	markers = () => this.key('markers');
	run = (id: string) => this.encoded('run', id);
	runs = () => this.key('runs');
	runsStatus = (status: string) => this.key('runs', 'status', status);
	runStatuses = () => this.key('runs', 'statuses');
	runsWorkflow = (workflow: string) => this.encoded('runs-workflow', workflow);
	event = (path: string) => this.encoded('event', path);
	eventEntries = (path: string) => this.encoded('event-entries', path);
	eventOrder = (path: string) => this.encoded('event-order', path);
	eventKeys = (path: string) => this.encoded('event-keys', path);
	events = () => this.key('events');
	conversation = (path: string) => this.encoded('conversation', path);
	conversationBatches = (path: string) => this.encoded('conversation-batches', path);
	conversationOrder = (path: string) => this.encoded('conversation-order', path);
	conversationRetries = (path: string) => this.encoded('conversation-retries', path);
	conversations = () => this.key('conversations');
	attachment = (path: string, attachmentId: string) => this.encoded('attachment', path, attachmentId);
	attachments = (path: string) => this.encoded('attachments', path);
	conversationAttachmentIndexes = (path: string) => this.encoded('conversation-attachment-indexes', path);
	conversationAttachments = (path: string, conversationId: string) => this.encoded('conversation-attachments', path, conversationId);
}
