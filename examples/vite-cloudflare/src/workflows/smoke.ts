import type { FlueContext, WorkflowRouteHandler } from '@flue/runtime';

export const route: WorkflowRouteHandler = async (_c, next) => next();

export async function run({ payload }: FlueContext) {
	return { ok: true, payload, target: 'cloudflare' };
}
