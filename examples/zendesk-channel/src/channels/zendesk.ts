import { defineTool, dispatch } from '@flue/runtime';
import { createZendeskChannel, type JsonValue, type ZendeskTicketRef } from '@flue/zendesk';
import { Assistant } from '../agents/assistant.ts';
import { createZendeskClient } from '../zendesk-client.ts';

const accountId = requiredEnv('ZENDESK_ACCOUNT_ID');

export const client = createZendeskClient({
	subdomain: requiredEnv('ZENDESK_SUBDOMAIN'),
	email: requiredEnv('ZENDESK_EMAIL'),
	apiToken: requiredEnv('ZENDESK_API_TOKEN'),
});

export const channel = createZendeskChannel({
	signingSecret: requiredEnv('ZENDESK_WEBHOOK_SIGNING_SECRET'),
	accountId,
	webhookId: optionalEnv('ZENDESK_WEBHOOK_ID'),

	// Path: /channels/zendesk/webhook
	async webhook({ c, payload, delivery }) {
		switch (payload.type) {
			case 'zen:event-type:ticket.created':
			case 'zen:event-type:ticket.comment_added': {
				const ticketId = ticketIdFromEvent(payload.subject, payload.detail);
				if (!ticketId) {
					return c.json({ error: 'Expected a Zendesk ticket event.' }, 400);
				}

				const ticket: ZendeskTicketRef = {
					accountId: payload.account_id,
					ticketId,
				};
				await dispatch(Assistant, {
					id: channel.instanceId(ticket),
					// Recorded once when this event creates the instance; ignored after.
					initialData: {
						accountId: ticket.accountId,
						ticketId: ticket.ticketId,
					},
					message: {
						kind: 'signal',
						type: `zendesk.${payload.type}`,
						// `event` is Zendesk's provider-native change object; its
						// properties vary by event type.
						body: JSON.stringify(payload.event),
						attributes: {
							eventId: payload.id,
							ticketId,
							occurredAt: payload.time,
							invocationId: delivery.invocationId,
						},
					},
				});
				return;
			}
			default:
				return;
		}
	},
});

export function retrieveTicket(ref: ZendeskTicketRef) {
	if (ref.accountId !== accountId) {
		throw new TypeError('Expected the configured Zendesk account.');
	}
	return defineTool({
		name: 'retrieve_zendesk_ticket',
		description: 'Retrieve the Zendesk ticket already bound to this agent.',
		async run() {
			return (await client.getTicket(ref.ticketId)) as unknown as JsonValue;
		},
	});
}

function ticketIdFromEvent(subject: string, detail: Record<string, JsonValue>): string | undefined {
	const subjectMatch = /^zen:ticket:([1-9]\d*)$/.exec(subject);
	if (!subjectMatch?.[1]) return undefined;
	const id = detail.id;
	if (!(
		(typeof id === 'string' && /^[1-9]\d*$/.test(id)) ||
		(typeof id === 'number' && Number.isSafeInteger(id) && id > 0)
	)) {
		return undefined;
	}
	return String(id) === subjectMatch[1] ? subjectMatch[1] : undefined;
}

function requiredEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required.`);
	return value;
}

function optionalEnv(name: string): string | undefined {
	return process.env[name] || undefined;
}
