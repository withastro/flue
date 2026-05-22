import { createAgent, defineAgentProfile, type ReceiveContext } from '@flue/runtime';
import { mock } from '../channels/mock';

export const channels = [mock()];

const cloudflareBinding = defineAgentProfile({
	model: 'cloudflare/@cf/moonshotai/kimi-k2.6',
	instructions: 'You process Cloudflare-target external deliveries.',
});

export async function receive({ delivery, dispatch }: ReceiveContext) {
	await dispatch({
		id: 'cloudflare:default',
		session: `delivery:${delivery.id}`,
		input: {
			type: 'mock.cloudflare.delivery',
			data: delivery.data,
		},
	});
}

export default createAgent(() => ({ profile: cloudflareBinding }));
