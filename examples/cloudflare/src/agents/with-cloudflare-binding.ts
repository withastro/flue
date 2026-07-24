'use agent';
import { useModel } from '@flue/runtime';

export function WithCloudflareBinding() {
	useModel('cloudflare/@cf/moonshotai/kimi-k2.6');
	return 'You process direct requests using a Cloudflare Workers AI binding.';
}
