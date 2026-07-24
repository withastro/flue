import { defineTool, dispatch, type JsonValue } from '@flue/runtime';
import { createStripeChannel } from '@flue/stripe';
import type Stripe from 'stripe';
import { Assistant } from '../agents/assistant.ts';
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
				await dispatch(Assistant, {
					id: stripeCustomerInstanceId(customer),
					// Recorded once when this event creates the instance; ignored after.
					initialData: customer,
					message: {
						kind: 'signal',
						type: `stripe.${event.type}`,
						body: `Checkout session ${session.id} reported payment status ${session.payment_status}.`,
						attributes: {
							eventId: event.id,
							customerId,
							sessionId: session.id,
							paymentStatus: session.payment_status,
							...(session.amount_total === null
								? {}
								: { amountTotal: String(session.amount_total) }),
							...(session.currency === null ? {} : { currency: session.currency }),
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

export function getCustomerSummary(ref: StripeCustomerRef) {
	return defineTool({
		name: 'get_stripe_customer_summary',
		description: 'Retrieve the Stripe customer already bound to this billing agent.',
		async run() {
			const customer = await client.customers.retrieve(
				ref.customerId,
				{},
				stripeRequestOptions(ref.accountId, ref.context),
			);
			const summary: JsonValue = customer.deleted
				? { customerId: customer.id, deleted: true }
				: {
						customerId: customer.id,
						...(customer.name === undefined ? {} : { name: customer.name }),
						email: customer.email,
						...(customer.delinquent === undefined ? {} : { delinquent: customer.delinquent }),
					};
			return summary;
		},
	});
}

export function stripeCustomerInstanceId(ref: StripeCustomerRef): string {
	return `stripe-customer:${encodeURIComponent(JSON.stringify(ref))}`;
}

function stripeCustomerId(
	customer: string | Stripe.Customer | Stripe.DeletedCustomer | null,
): string | undefined {
	if (typeof customer === 'string') return customer;
	return customer?.id;
}

function requiredEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required.`);
	return value;
}
