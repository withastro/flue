import { defineAgent, defineWorkflow, type WorkflowRouteHandler } from '@flue/runtime';
import * as v from 'valibot';
import {
	getDefaultWorkspace,
	getShellSandbox,
	hydrateFromBucket,
} from '../sandboxes/cloudflare-shell';

export const route: WorkflowRouteHandler = async (_c, next) => next();
interface Env {
	KNOWLEDGE_BASE: R2Bucket;
	LOADER: WorkerLoader;
}
const HYDRATION_SENTINEL = '/.hydrated';
const agent = defineAgent<Env>(async ({ env }) => {
	const workspace = getDefaultWorkspace();
	if (!(await workspace.exists(HYDRATION_SENTINEL))) {
		await hydrateFromBucket(workspace, env.KNOWLEDGE_BASE);
		await workspace.writeFile(HYDRATION_SENTINEL, new Date().toISOString());
	}
	return {
		sandbox: getShellSandbox({ workspace, loader: env.LOADER }),
		model: 'cloudflare/@cf/moonshotai/kimi-k2.6',
	};
});

export default defineWorkflow({
	agent,
	async run({ harness }) {
		const session = await harness.session();
		const result = await session.skill('spam-filter', {
			args: { message: 'CONGRATS! You have won a free iPhone. Click here: http://bit.ly/xyz' },
			result: v.object({
				spam: v.boolean(),
				confidence: v.picklist(['low', 'medium', 'high']),
				reasoning: v.string(),
			}),
		});
		return result.data;
	},
});
