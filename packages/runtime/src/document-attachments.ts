/**
 * Document attachments (PDFs) on user messages.
 *
 * pi-ai's content protocol has exactly one binary carrier — `ImageContent`
 * (`{ type: 'image', data, mimeType }`) — and no document block. Flue therefore
 * carries a document through the model context as an `ImageContent` whose
 * `mimeType` is a supported document type, and rewrites it into the
 * provider's native document block at the one seam Flue owns on every model
 * request: the agent loop's `StreamFn`, via pi's `onPayload` hook.
 *
 * Everything durable is already media-type agnostic (`AttachmentRef` carries
 * `mimeType`; the attachment store, the `file` UI part, and the hosted
 * attachment route never look at the media type), so documents need no
 * canonical-record change: a PDF is an attachment whose `mimeType` is
 * `application/pdf`.
 *
 * Provider support (native document input):
 * - `anthropic-messages` — pi emits `{ type: 'image', source: { media_type:
 *   'application/pdf' } }`; rewritten to `{ type: 'document', source }`.
 * - `openai-responses` / `azure-openai-responses` — pi emits
 *   `{ type: 'input_image', image_url: 'data:application/pdf;base64,…' }`;
 *   rewritten to `{ type: 'input_file', filename, file_data }`.
 * - `google-generative-ai` / `google-vertex` — pi already emits
 *   `{ inlineData: { mimeType: 'application/pdf', data } }`, which is the
 *   native form; no rewrite.
 *
 * Every other model API gets the document replaced with a text placeholder
 * before pi sees the context (Bedrock, for one, throws on a non-image
 * `ImageContent` before `onPayload` runs), mirroring pi's own placeholder for
 * images sent to a non-vision model.
 */
import type { Api, Context, ImageContent, Model, SimpleStreamOptions } from '@earendil-works/pi-ai';
import type { PromptDocument, PromptImage } from './types.ts';

/** Document MIME types accepted on attachments and operation `documents`. */
export const DOCUMENT_MIME_TYPES = ['application/pdf'] as const;

const documentMimeTypes: ReadonlySet<string> = new Set(DOCUMENT_MIME_TYPES);

/** Model APIs that receive documents as native document content. */
export const NATIVE_DOCUMENT_APIS: ReadonlySet<string> = new Set([
	'anthropic-messages',
	'openai-responses',
	'azure-openai-responses',
	'google-generative-ai',
	'google-vertex',
]);

const DEFAULT_DOCUMENT_FILENAME = 'document.pdf';

/**
 * A document as it rides the pi model context: pi's `ImageContent` carrier
 * with a document `mimeType`, plus the uploader's filename when known (pi
 * ignores the extra field; Flue's payload rewrite reads it).
 */
export type DocumentContextBlock = ImageContent & { filename?: string };

export function isDocumentMimeType(mimeType: string): boolean {
	return documentMimeTypes.has(mimeType);
}

/** True for a context block that carries a document rather than an image. */
export function isDocumentContextBlock(block: unknown): block is DocumentContextBlock {
	if (!block || typeof block !== 'object') return false;
	const candidate = block as { type?: unknown; mimeType?: unknown; data?: unknown };
	return (
		candidate.type === 'image' &&
		typeof candidate.data === 'string' &&
		typeof candidate.mimeType === 'string' &&
		isDocumentMimeType(candidate.mimeType)
	);
}

/** Reject unsupported document MIME types on the in-code operation surface. */
export function assertSupportedDocuments(documents: readonly PromptDocument[] | undefined): void {
	for (const document of documents ?? []) {
		if (!isDocumentMimeType(document.mimeType)) {
			throw new Error(
				`[flue] Unsupported document mimeType "${document.mimeType}". ` +
					`Supported: ${DOCUMENT_MIME_TYPES.join(', ')}.`,
			);
		}
	}
}

/**
 * Fold an operation's `images` and `documents` into the single binary list
 * the session plumbing carries (documents ride pi's `ImageContent` carrier —
 * see the module doc). Returns `images` unchanged when there are no documents.
 */
export function mergeOperationAttachments(
	images: readonly PromptImage[] | undefined,
	documents: readonly PromptDocument[] | undefined,
): PromptImage[] | undefined {
	assertSupportedDocuments(documents);
	if (!documents?.length) return images as PromptImage[] | undefined;
	return [
		...(images ?? []),
		...documents.map((document) => ({
			type: 'image' as const,
			data: document.data,
			mimeType: document.mimeType,
		})),
	];
}

/**
 * Convert a pi-carrier block back to its public shape — a document block when
 * its MIME type is a document type, else the image unchanged. Used where the
 * runtime reconstructs a `DeliveredMessage` from the model context or the
 * attachment store (task delegation, delivery-cursor restore).
 */
export function toPublicAttachment<T extends { mimeType: string; data: string }>(
	block: T,
): (T & { type: 'image' }) | (T & { type: 'document' }) {
	return isDocumentMimeType(block.mimeType)
		? { ...block, type: 'document' as const }
		: { ...block, type: 'image' as const };
}

/** Text that replaces a document for a model API without native document input. */
export function documentOmittedPlaceholder(api: string, filename?: string): string {
	const name = filename ? ` "${filename}"` : '';
	return `(document${name} omitted: model API "${api}" does not support document input)`;
}

const warnedApis = new Set<string>();

function warnDocumentsOmitted(api: string): void {
	if (warnedApis.has(api)) return;
	warnedApis.add(api);
	console.warn(
		`[flue] Model API "${api}" does not support native document input; ` +
			'document attachments are replaced with a text placeholder in the model context. ' +
			`Native document input is supported on: ${[...NATIVE_DOCUMENT_APIS].join(', ')}.`,
	);
}

/**
 * Prepare one model request's context and options for any documents it
 * carries. A no-op (same references back) when the context has no documents.
 *
 * - Unsupported model API: documents are replaced with a text placeholder.
 * - Supported model API: `options.onPayload` is wrapped so the provider
 *   payload is rewritten into native document blocks before any caller-
 *   supplied `onPayload` runs.
 */
export function prepareDocumentRequest(
	model: Model<Api>,
	context: Context,
	options: SimpleStreamOptions | undefined,
): { context: Context; options: SimpleStreamOptions | undefined } {
	const filenames = collectDocumentFilenames(context);
	if (filenames === undefined) return { context, options };

	if (!NATIVE_DOCUMENT_APIS.has(model.api)) {
		warnDocumentsOmitted(model.api);
		return { context: replaceDocumentsWithPlaceholder(context, model.api), options };
	}

	const callerOnPayload = options?.onPayload;
	return {
		context,
		options: {
			...options,
			onPayload: async (payload, payloadModel) => {
				const rewritten = rewriteDocumentPayload(payload, payloadModel.api, filenames);
				const next = await callerOnPayload?.(rewritten ?? payload, payloadModel);
				return next === undefined ? rewritten : next;
			},
		},
	};
}

/**
 * Map each document's base64 data to its filename (or `undefined` when the
 * uploader gave none). Returns `undefined` when no user message carries a
 * document, so the common path allocates nothing.
 */
function collectDocumentFilenames(context: Context): Map<string, string | undefined> | undefined {
	let filenames: Map<string, string | undefined> | undefined;
	for (const message of context.messages) {
		if (message.role !== 'user' || !Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (!isDocumentContextBlock(block)) continue;
			filenames ??= new Map();
			if (!filenames.has(block.data) || block.filename) filenames.set(block.data, block.filename);
		}
	}
	return filenames;
}

function replaceDocumentsWithPlaceholder(context: Context, api: string): Context {
	return {
		...context,
		messages: context.messages.map((message) => {
			if (message.role !== 'user' || !Array.isArray(message.content)) return message;
			if (!message.content.some(isDocumentContextBlock)) return message;
			return {
				...message,
				content: message.content.map((block) =>
					isDocumentContextBlock(block)
						? { type: 'text' as const, text: documentOmittedPlaceholder(api, block.filename) }
						: block,
				),
			};
		}),
	};
}

/**
 * Rewrite pi's image-shaped document blocks in a provider payload into the
 * provider's native document blocks. Returns a new payload, or `undefined`
 * when nothing needed rewriting (or the payload shape is not recognized).
 * Only top-level user-message content is rewritten.
 */
export function rewriteDocumentPayload(
	payload: unknown,
	api: string,
	filenames: ReadonlyMap<string, string | undefined>,
): unknown {
	switch (api) {
		case 'anthropic-messages':
			return rewriteAnthropicPayload(payload, filenames);
		case 'openai-responses':
		case 'azure-openai-responses':
			return rewriteOpenAIResponsesPayload(payload, filenames);
		default:
			return undefined;
	}
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Rewrite user-message content blocks under `payload[key]`; copy-on-write. */
function rewriteUserContent(
	payload: unknown,
	key: 'messages' | 'input',
	rewriteBlock: (block: unknown) => unknown,
): unknown {
	if (!isRecord(payload) || !Array.isArray(payload[key])) return undefined;
	let changed = false;
	const items = (payload[key] as unknown[]).map((item) => {
		if (!isRecord(item) || item.role !== 'user' || !Array.isArray(item.content)) return item;
		let itemChanged = false;
		const content = item.content.map((block) => {
			const next = rewriteBlock(block);
			if (next === block) return block;
			itemChanged = true;
			return next;
		});
		if (!itemChanged) return item;
		changed = true;
		return { ...item, content };
	});
	return changed ? { ...payload, [key]: items } : undefined;
}

function rewriteAnthropicPayload(
	payload: unknown,
	filenames: ReadonlyMap<string, string | undefined>,
): unknown {
	return rewriteUserContent(payload, 'messages', (block) => {
		if (!isRecord(block) || block.type !== 'image' || !isRecord(block.source)) return block;
		const source = block.source;
		if (
			source.type !== 'base64' ||
			typeof source.media_type !== 'string' ||
			typeof source.data !== 'string' ||
			!isDocumentMimeType(source.media_type)
		) {
			return block;
		}
		const title = filenames.get(source.data);
		return { ...block, type: 'document', ...(title ? { title } : {}) };
	});
}

function rewriteOpenAIResponsesPayload(
	payload: unknown,
	filenames: ReadonlyMap<string, string | undefined>,
): unknown {
	return rewriteUserContent(payload, 'input', (block) => {
		if (!isRecord(block) || block.type !== 'input_image' || typeof block.image_url !== 'string') {
			return block;
		}
		const match = /^data:([^;,]+);base64,(.*)$/s.exec(block.image_url);
		if (!match?.[1] || match[2] === undefined || !isDocumentMimeType(match[1])) return block;
		return {
			type: 'input_file',
			filename: filenames.get(match[2]) ?? DEFAULT_DOCUMENT_FILENAME,
			file_data: block.image_url,
		};
	});
}
