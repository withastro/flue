import type { ActionContext } from '@flue/runtime';

export const triggers = {};

export default async function (_ctx: ActionContext) {
	throw new Error('[flue] This example returns in Phase 3 with init({ loadFromSandbox: true }).');
}



/**
 * Demonstrates the `getShellSandbox` + `hydrateFromBucket` flow that
 * replaces the old (buggy) `getVirtualSandbox(env.BUCKET)` pattern.
 *
 * What this shows:
 *   1. Construct a default Workspace for the agent instance.
 *   2. On first run, copy the bucket's contents into the Workspace (so
 *      `/.agents/skills/spam-filter/SKILL.md` lives at that path on the
 *      workspace filesystem). Subsequent runs short-circuit on the
 *      `/.hydrated` sentinel.
 *   3. Wire the Workspace into a cf-shell sandbox; pass it to `init()`.
 *   4. Call a skill the agent discovered from the hydrated filesystem.
 *
 * Bucket layout: any object whose key under the bucket starts with
 * `.agents/skills/<name>/SKILL.md` becomes a registered skill. We pass
 * `prefix: ''` (the default) so the bucket's full key tree is mirrored
 * verbatim into the workspace.
 *
 * Local development: Worker Loader is in beta and `wrangler dev`'s
 * local mode doesn't yet simulate the `worker_loaders` binding. To run
 * this example, use either:
 *   - `wrangler dev --remote` (runs against Cloudflare's edge; requires
 *     Worker Loader access on your account), or
 *   - `wrangler deploy` to a preview environment.
 * See the example's README.md for the full setup, the seed-r2.sh helper,
 * and the migration / fallback options if you don't have Loader access.
import type { FlueContext } from '@flue/runtime';
import {
	getDefaultWorkspace,
	getShellSandbox,
	hydrateFromBucket,
} from '../connectors/cloudflare-shell.ts';
import * as v from 'valibot';

export const triggers = { webhook: true };

interface Env {
	KNOWLEDGE_BASE: R2Bucket;
	LOADER: WorkerLoader;
}

const HYDRATION_SENTINEL = '/.hydrated';

export default async function ({ init, env }: FlueContext<unknown, Env>) {
	const workspace = getDefaultWorkspace();

	// Hydrate once per agent instance. Bump the sentinel key (e.g.
	// `/.hydrated-v2`) to force re-hydration after you change the bucket
	// contents — Workspace owns mutations after hydration, so R2 changes
	// won't propagate back on their own.
	if (!(await workspace.exists(HYDRATION_SENTINEL))) {
		await hydrateFromBucket(workspace, env.KNOWLEDGE_BASE);
		await workspace.writeFile(HYDRATION_SENTINEL, new Date().toISOString());
	}
	const harness = await init({
		sandbox: getShellSandbox({ workspace, loader: env.LOADER }),
		model: 'cloudflare/@cf/moonshotai/kimi-k2.6',
	});
	const session = await harness.session();

	// The skill body lives at `.agents/skills/spam-filter/SKILL.md` in
	// the workspace (hydrated from the same path in the bucket). Flue
	// discovers it via the standard skills lookup during `init()`.
	const result = await session.skill('spam-filter', {
		args: { message: 'CONGRATS! You have won a free iPhone. Click here: http://bit.ly/xyz' },
		result: v.object({
			spam: v.boolean(),
			confidence: v.picklist(['low', 'medium', 'high']),
			reasoning: v.string(),
		}),
	});

	return result.data;
}
*/
