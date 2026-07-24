import { defineTool, dispatch, type JsonValue } from '@flue/runtime';
import {
	createSalesforceMarketingCloudChannel,
	type SalesforceMarketingCloudEvent,
} from '@flue/salesforce';
import { Assistant } from '../agents/assistant.ts';
import {
	createSalesforceMarketingCloudClient,
	type SalesforceMarketingCloudClient,
} from '../salesforce-marketing-cloud-client.ts';
import {
	emailEventInstanceId,
	emailRefFromEvent,
	type SalesforceMarketingCloudEmailRef,
} from '../salesforce-marketing-cloud-email.ts';

const callbackId = requiredEnv('SALESFORCE_MARKETING_CLOUD_CALLBACK_ID');

export const client: SalesforceMarketingCloudClient = createSalesforceMarketingCloudClient({
	restBaseUrl: requiredEnv('SALESFORCE_MARKETING_CLOUD_REST_BASE_URL'),
	accessToken: requiredEnv('SALESFORCE_MARKETING_CLOUD_ACCESS_TOKEN'),
});

export const channel = createSalesforceMarketingCloudChannel({
	callbackId,
	signatureKey: requiredEnv('SALESFORCE_MARKETING_CLOUD_SIGNATURE_KEY'),

	// Path: /channels/salesforce-marketing-cloud/events
	async events({ c, batch }) {
		const usefulEvents: Array<{
			event: SalesforceMarketingCloudEvent;
			ref: SalesforceMarketingCloudEmailRef;
		}> = [];

		for (const event of batch.events) {
			switch (event.eventCategoryType) {
				case 'TransactionalSendEvents.EmailSent':
				case 'TransactionalSendEvents.EmailNotSent':
				case 'TransactionalSendEvents.EmailBounced':
				case 'EngagementEvents.EmailOpen':
				case 'EngagementEvents.EmailClick':
				case 'EngagementEvents.EmailUnsubscribe': {
					const ref = emailRefFromEvent(callbackId, event);
					if (!ref) {
						return c.json({ error: 'Expected a supported Marketing Cloud email event.' }, 400);
					}
					usefulEvents.push({ event, ref });
					break;
				}
				default:
					break;
			}
		}

		for (const { event, ref } of usefulEvents) {
			await dispatch(Assistant, {
				id: emailEventInstanceId(ref),
				// Recorded once when this event creates the instance; ignored after.
				initialData: {
					callbackId: ref.callbackId,
					mid: ref.mid,
					eid: ref.eid,
					jobId: ref.jobId,
					batchId: ref.batchId,
					listId: ref.listId,
					subscriberId: ref.subscriberId,
				},
				message: {
					kind: 'signal',
					type: `salesforce-marketing-cloud.${event.eventCategoryType}`,
					// `info` carries the family-specific event fields; there is no
					// natural message text for an engagement event.
					body: JSON.stringify(event.info ?? {}),
					attributes: {
						...(typeof event.timestampUTC === 'string' ? { occurredAt: event.timestampUTC } : {}),
						callbackId: ref.callbackId,
						mid: ref.mid,
						eid: ref.eid,
						jobId: ref.jobId,
						batchId: ref.batchId,
						listId: ref.listId,
						subscriberId: ref.subscriberId,
					},
				},
			});
		}

		return c.body(null, 204);
	},
});

export function retrieveCallback(ref: SalesforceMarketingCloudEmailRef) {
	if (ref.callbackId !== callbackId) {
		throw new TypeError('Expected the configured Salesforce Marketing Cloud callback.');
	}
	return defineTool({
		name: 'retrieve_salesforce_marketing_cloud_callback',
		description: 'Retrieve the Marketing Cloud ENS callback bound to this agent.',
		async run() {
			return (await client.getCallback(callbackId)) as unknown as JsonValue;
		},
	});
}

function requiredEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required.`);
	return value;
}
