import {
	type AdminApiClient,
	type ClientResponse,
	createAdminApiClient,
} from '@shopify/admin-api-client';

const SHOPIFY_ADMIN_API_VERSION = '2026-04';

export interface CreateShopifyClientOptions {
	shopDomain: string;
	accessToken: string;
	fetcher?: typeof globalThis.fetch;
}

export interface ShopifyOrder {
	id: string;
	name: string;
	displayFinancialStatus: string | null;
	displayFulfillmentStatus: string;
	email: string | null;
	totalPriceSet: {
		shopMoney: {
			amount: string;
			currencyCode: string;
		};
	};
}

interface ShopifyOrderQuery {
	order: ShopifyOrder | null;
}

const ORDER_QUERY = `#graphql
	query BoundOrder($id: ID!) {
		order(id: $id) {
			id
			name
			displayFinancialStatus
			displayFulfillmentStatus
			email
			totalPriceSet {
				shopMoney {
					amount
					currencyCode
				}
			}
		}
	}`;

export function createShopifyClient({
	shopDomain,
	accessToken,
	fetcher = globalThis.fetch,
}: CreateShopifyClientOptions): AdminApiClient {
	return createAdminApiClient({
		storeDomain: shopDomain,
		apiVersion: SHOPIFY_ADMIN_API_VERSION,
		accessToken,
		customFetchApi: (url, init) => fetcher(url, init),
	});
}

export async function retrieveShopifyOrder(
	client: AdminApiClient,
	orderId: string,
): Promise<ShopifyOrder | null> {
	const response: ClientResponse<ShopifyOrderQuery> = await client.request(ORDER_QUERY, {
		variables: { id: `gid://shopify/Order/${orderId}` },
	});
	if (response.errors) {
		throw new Error(response.errors.message ?? 'Shopify Admin API request failed.');
	}
	return response.data?.order ?? null;
}
