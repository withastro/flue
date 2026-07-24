import { defineTool, dispatch } from '@flue/runtime';
import { createShopifyChannel, type JsonValue } from '@flue/shopify';
import { Assistant } from '../agents/assistant.ts';
import { createShopifyClient, retrieveShopifyOrder } from '../shopify-client.ts';

const ORDER_INSTANCE_PREFIX = 'shopify-order:';
const shopDomain = requiredEnv('SHOPIFY_SHOP_DOMAIN');

export interface ShopifyOrderRef {
	shopDomain: string;
	orderId: string;
}

export const client = createShopifyClient({
	shopDomain,
	accessToken: requiredEnv('SHOPIFY_ADMIN_ACCESS_TOKEN'),
});

export const channel = createShopifyChannel({
	clientSecret: requiredEnv('SHOPIFY_CLIENT_SECRET'),
	previousClientSecret: optionalEnv('SHOPIFY_PREVIOUS_CLIENT_SECRET'),

	// Path: /channels/shopify/webhook
	async webhook({ c, payload }) {
		// Shopify's HMAC authenticates the body, not these headers, which are
		// read from the verified request through `c`. This comparison is a
		// tenancy consistency check, not authorization by itself.
		const deliveredShopDomain = c.req.header('x-shopify-shop-domain');
		if (deliveredShopDomain !== shopDomain) {
			return c.json({ error: 'Unexpected Shopify shop domain.' }, 403);
		}

		switch (c.req.header('x-shopify-topic')) {
			case 'orders/create': {
				const order = parseOrderCreatedPayload(payload);
				if (!order) {
					return c.json({ error: 'Unsupported orders/create payload.' }, 400);
				}

				const ref: ShopifyOrderRef = {
					shopDomain: deliveredShopDomain,
					orderId: order.id,
				};
				const eventId = c.req.header('x-shopify-event-id');
				const webhookId = c.req.header('x-shopify-webhook-id');
				await dispatch(Assistant, {
					id: shopifyOrderInstanceId(ref),
					// Recorded once when this event creates the instance; ignored after.
					initialData: {
						shopDomain: deliveredShopDomain,
						orderId: order.id,
						orderName: order.name,
					},
					message: {
						kind: 'signal',
						type: 'shopify.orders/create',
						body: `Shopify order ${order.name} created.`,
						attributes: {
							shopDomain: deliveredShopDomain,
							orderId: order.id,
							...(webhookId === undefined ? {} : { webhookId }),
							...(eventId === undefined ? {} : { eventId }),
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

export function retrieveOrder(ref: ShopifyOrderRef) {
	if (ref.shopDomain !== shopDomain) {
		throw new TypeError('Shopify order does not belong to the configured shop.');
	}
	return defineTool({
		name: 'retrieve_shopify_order',
		description: 'Retrieve the Shopify order already bound to this agent.',
		async run() {
			const order = await retrieveShopifyOrder(client, ref.orderId);
			return { order } as unknown as JsonValue;
		},
	});
}

export function shopifyOrderInstanceId(ref: ShopifyOrderRef): string {
	if (!isShopDomain(ref.shopDomain) || !isOrderId(ref.orderId)) {
		throw new TypeError('Shopify order reference is invalid.');
	}
	return `${ORDER_INSTANCE_PREFIX}${encodeURIComponent(ref.shopDomain)}:${encodeURIComponent(ref.orderId)}`;
}

function parseOrderCreatedPayload(payload: JsonValue): { id: string; name: string } | undefined {
	if (!isRecord(payload)) return undefined;
	if (!isOrderId(payload.id)) return undefined;
	if (typeof payload.name !== 'string' || payload.name.length === 0) return undefined;
	return {
		id: String(payload.id),
		name: payload.name,
	};
}

function isShopDomain(value: unknown): value is string {
	return typeof value === 'string' && /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(value);
}

function isOrderId(value: unknown): value is string | number {
	if (typeof value === 'string') return /^[1-9]\d*$/.test(value);
	return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required.`);
	return value;
}

function optionalEnv(name: string): string | undefined {
	return process.env[name] || undefined;
}
