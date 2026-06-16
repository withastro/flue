import type {
	CommentCreatedWebhookPayload,
	CommentDeletedWebhookPayload,
	CommentUpdatedWebhookPayload,
	DatabaseContentUpdatedWebhookPayload,
	DatabaseCreatedWebhookPayload,
	DatabaseDeletedWebhookPayload,
	DatabaseMovedWebhookPayload,
	DatabaseSchemaUpdatedWebhookPayload,
	DatabaseUndeletedWebhookPayload,
	DataSourceContentUpdatedWebhookPayload,
	DataSourceCreatedWebhookPayload,
	DataSourceDeletedWebhookPayload,
	DataSourceMovedWebhookPayload,
	DataSourceSchemaUpdatedWebhookPayload,
	DataSourceUndeletedWebhookPayload,
	FileUploadCompletedWebhookPayload,
	FileUploadCreatedWebhookPayload,
	FileUploadExpiredWebhookPayload,
	FileUploadUploadFailedWebhookPayload,
	PageContentUpdatedWebhookPayload,
	PageCreatedWebhookPayload,
	PageDeletedWebhookPayload,
	PageLockedWebhookPayload,
	PageMovedWebhookPayload,
	PagePropertiesUpdatedWebhookPayload,
	PageTranscriptionBlockTranscriptDeletedWebhookPayload,
	PageUndeletedWebhookPayload,
	PageUnlockedWebhookPayload,
	ViewCreatedWebhookPayload,
	ViewDeletedWebhookPayload,
	ViewUpdatedWebhookPayload,
} from '@notionhq/client';
import type { Context, Env, Handler } from 'hono';
import { createNotionWebhookHandler } from './webhook.ts';

export type JsonValue =
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue };

export interface ChannelRoute<E extends Env = Env> {
	readonly method: string;
	readonly path: string;
	readonly handler: Handler<E>;
}

export interface NotionChannelOptions<E extends Env = Env> {
	/**
	 * Verification token supplied during Notion endpoint setup and later used
	 * as the HMAC signing secret. Ordinary events receive `503` while absent.
	 */
	verificationToken?: string;
	/** Maximum request-body size in bytes. Defaults to 1 MiB. */
	bodyLimit?: number;
	/**
	 * Handles Notion's initial unsigned verification-token delivery.
	 *
	 * This callback is setup code, not authenticated application ingress.
	 */
	verification?(input: NotionVerificationHandlerInput<E>): NotionHandlerResult;
	/** Receives every verified Notion event. */
	webhook(input: NotionWebhookHandlerInput<E>): NotionHandlerResult;
}

/**
 * Notion's documented webhook author/principal type.
 *
 * The current official SDK's `BaseWebhookPayload` declares only `person` and
 * `bot`, but Notion's webhook documentation also lists `agent` for authors.
 */
export type NotionWebhookAuthorType = 'person' | 'bot' | 'agent';

export type NotionWebhookAccessibleByType = 'person' | 'bot';

type WithDocumentedAuthors<T> = T extends unknown
	? Omit<T, 'authors' | 'accessible_by'> & {
			authors: Array<{ id: string; type: NotionWebhookAuthorType }>;
			accessible_by?: Array<{ id: string; type: NotionWebhookAccessibleByType }>;
		}
	: never;

/**
 * Provider-native webhook payload union, sourced from the official Notion SDK's
 * exported `*WebhookPayload` types.
 *
 * The only adjustment is widening `authors` to Notion's documented `agent`
 * principal type while retaining `person | bot` for `accessible_by`. Field names,
 * nesting, and discriminants are otherwise the provider's own.
 */
export type NotionKnownWebhookEvent = WithDocumentedAuthors<
	| CommentCreatedWebhookPayload
	| CommentDeletedWebhookPayload
	| CommentUpdatedWebhookPayload
	| DataSourceContentUpdatedWebhookPayload
	| DataSourceCreatedWebhookPayload
	| DataSourceDeletedWebhookPayload
	| DataSourceMovedWebhookPayload
	| DataSourceSchemaUpdatedWebhookPayload
	| DataSourceUndeletedWebhookPayload
	| DatabaseContentUpdatedWebhookPayload
	| DatabaseCreatedWebhookPayload
	| DatabaseDeletedWebhookPayload
	| DatabaseMovedWebhookPayload
	| DatabaseSchemaUpdatedWebhookPayload
	| DatabaseUndeletedWebhookPayload
	| FileUploadCompletedWebhookPayload
	| FileUploadCreatedWebhookPayload
	| FileUploadExpiredWebhookPayload
	| FileUploadUploadFailedWebhookPayload
	| PageContentUpdatedWebhookPayload
	| PageCreatedWebhookPayload
	| PageDeletedWebhookPayload
	| PageLockedWebhookPayload
	| PageMovedWebhookPayload
	| PagePropertiesUpdatedWebhookPayload
	| PageTranscriptionBlockTranscriptDeletedWebhookPayload
	| PageUndeletedWebhookPayload
	| PageUnlockedWebhookPayload
	| ViewCreatedWebhookPayload
	| ViewDeletedWebhookPayload
	| ViewUpdatedWebhookPayload
>;

/**
 * Provider-native payload delivered to the `webhook` callback: the official
 * Notion `*WebhookPayload` union (with `agent` added to the `authors` principal
 * types). `switch (event.type)` narrows each modeled
 * variant.
 *
 * Notion can add event families and API versions; an authenticated event
 * outside the installed SDK's union is still forwarded at runtime — typed as
 * the current union — and reached through a `default` arm. Inspect `event.type`
 * to handle an event family newer than your installed `@notionhq/client`.
 */
export type NotionWebhookEvent = NotionKnownWebhookEvent;

export interface NotionVerificationHandlerInput<E extends Env = Env> {
	c: Context<E>;
	verificationToken: string;
}

export interface NotionWebhookHandlerInput<E extends Env = Env> {
	c: Context<E>;
	event: NotionWebhookEvent;
}

type NotionHandlerValue = undefined | JsonValue | Response;

export type NotionHandlerResult = NotionHandlerValue | Promise<NotionHandlerValue>;

/** Verified Notion ingress. */
export interface NotionChannel<E extends Env = Env> {
	readonly routes: readonly ChannelRoute<E>[];
}

/**
 * Creates one Notion webhook route.
 *
 * The channel is stateless and does not deduplicate or reorder Notion events.
 */
export function createNotionChannel<E extends Env = Env>(
	options: NotionChannelOptions<E>,
): NotionChannel<E> {
	validateOptions(options);
	return {
		routes: [
			{
				method: 'POST',
				path: '/webhook',
				handler: createNotionWebhookHandler(options),
			},
		],
	};
}

function validateOptions<E extends Env>(options: NotionChannelOptions<E>): void {
	if (!options || typeof options !== 'object') {
		throw new TypeError('createNotionChannel() requires an options object.');
	}
	if (
		options.verificationToken !== undefined &&
		(typeof options.verificationToken !== 'string' || options.verificationToken.length === 0)
	) {
		throw new TypeError('Notion verificationToken must be a non-empty string.');
	}
	if (options.verification !== undefined && typeof options.verification !== 'function') {
		throw new TypeError('Notion verification must be a function.');
	}
	if (options.verificationToken === undefined && options.verification === undefined) {
		throw new TypeError(
			'createNotionChannel() requires verificationToken or a verification handler.',
		);
	}
	if (typeof options.webhook !== 'function') {
		throw new TypeError('createNotionChannel() requires a webhook handler.');
	}
}
