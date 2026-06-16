import { defineTool, dispatch } from '@flue/runtime';
import { createStripeChannel } from '@flue/stripe';
import type Stripe from 'stripe';
import assistant from '../agents/assistant.ts';
import { createStripeClient, stripeRequestOptions } from '../stripe-client.ts';

export interface StripeCustomerRef {
	customerId: string;
	accountId?: string;
	context?: string;
}

export const client = createStripeClient(requiredEnv('STRIPE_SECRET_KEY'));

export const channel = createStripeChannel({
	client,
	webhookSecret: requiredEnv('STRIPE_WEBHOOK_SECRET'),

	// Path: /channels/stripe/webhook
	async webhook({ event }) {
		switch (event.type) {
			case 'checkout.session.completed':
			case 'checkout.session.async_payment_succeeded': {
				const session = event.data.object;
				const customerId = stripeCustomerId(session.customer);
				if (!customerId) return;

				const customer = {
					customerId,
					...(event.account ? { accountId: event.account } : {}),
					...(event.context ? { context: event.context } : {}),
				};
				await dispatch(assistant, {
					id: stripeCustomerInstanceId(customer),
					input: {
						type: `stripe.${event.type}`,
						eventId: event.id,
						customerId,
						sessionId: session.id,
						paymentStatus: session.payment_status,
						amountTotal: session.amount_total,
						currency: session.currency,
					},
				});
				return;
			}
			default:
				return;
		}
	},
});

export function getCustomerSummary(ref: StripeCustomerRef) {
	return defineTool({
		name: 'get_stripe_customer_summary',
		description: 'Retrieve the Stripe customer already bound to this billing agent.',
		parameters: {
			type: 'object',
			properties: {},
			additionalProperties: false,
		},
		async execute() {
			const customer = await client.customers.retrieve(
				ref.customerId,
				{},
				stripeRequestOptions(ref.accountId, ref.context),
			);
			if (customer.deleted) {
				return JSON.stringify({ customerId: customer.id, deleted: true });
			}
			return JSON.stringify({
				customerId: customer.id,
				name: customer.name,
				email: customer.email,
				delinquent: customer.delinquent,
			});
		},
	});
}

export function stripeCustomerInstanceId(ref: StripeCustomerRef): string {
	return `stripe-customer:${encodeURIComponent(JSON.stringify(ref))}`;
}

export function parseStripeCustomerInstanceId(id: string): StripeCustomerRef {
	const prefix = 'stripe-customer:';
	if (!id.startsWith(prefix)) {
		throw new Error('Stripe agent instance id is invalid.');
	}
	let value: unknown;
	try {
		value = JSON.parse(decodeURIComponent(id.slice(prefix.length)));
	} catch {
		throw new Error('Stripe agent instance id is invalid.');
	}
	if (!isRecord(value) || !isStripeId(value.customerId, 'cus_')) {
		throw new Error('Stripe agent instance id is invalid.');
	}
	if (value.accountId !== undefined && !isStripeId(value.accountId, 'acct_')) {
		throw new Error('Stripe agent instance id is invalid.');
	}
	if (
		value.context !== undefined &&
		(typeof value.context !== 'string' || value.context.length === 0)
	) {
		throw new Error('Stripe agent instance id is invalid.');
	}
	return {
		customerId: value.customerId,
		...(value.accountId === undefined ? {} : { accountId: value.accountId }),
		...(value.context === undefined ? {} : { context: value.context }),
	};
}

function stripeCustomerId(
	customer: string | Stripe.Customer | Stripe.DeletedCustomer | null,
): string | undefined {
	if (typeof customer === 'string') return customer;
	return customer?.id;
}

function isStripeId(value: unknown, prefix: string): value is string {
	return typeof value === 'string' && value.startsWith(prefix) && value.length > prefix.length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required.`);
	return value;
}
