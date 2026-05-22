/**
 * Demonstrates hydrating a cf-shell Workspace from a git repository
 * instead of an R2 bucket. Same pattern, different source.
 *
 * What this shows:
 *   1. Construct a default Workspace for the agent instance.
 *   2. On first run, clone a public repo into the workspace via
 *      isomorphic-git (via `createGit`). Subsequent runs short-circuit
 *      on the `/.hydrated` sentinel.
 *   3. Wire the Workspace into a cf-shell sandbox; pass it to `init()`.
 *   4. Ask the agent to list the cloned files via the `code` tool, which
 *      operates against the workspace's `state.*` API.
 *
 * Local development: see the same caveat in skills-from-r2.ts.
 * `wrangler dev --remote` is the supported local path until Worker
 * Loader is supported in local-mode wrangler dev.
 */
import { createAgent, http, type FlueContext } from '@flue/runtime';
import { WorkspaceFileSystem } from '@cloudflare/shell';
import { createGit } from '@cloudflare/shell/git';
import {
	getDefaultWorkspace,
	getShellSandbox,
} from '@flue/runtime/cloudflare';

export const channels = [http()];

interface Env {
	LOADER: WorkerLoader;
}

const HYDRATION_SENTINEL = '/.hydrated';
const TARGET_REPO = 'https://github.com/FredKSchott/vinext-starter';
const CLONE_DIR = '/repo';

export async function run({ init, env }: FlueContext<unknown, Env>) {
	const workspace = getDefaultWorkspace();

	// Clone once per agent instance. createGit() operates on any cf-shell
	// FileSystem; we adapt the Workspace via WorkspaceFileSystem.
	if (!(await workspace.exists(HYDRATION_SENTINEL))) {
		const git = createGit(new WorkspaceFileSystem(workspace));
		await git.clone({
			url: TARGET_REPO,
			dir: CLONE_DIR,
			singleBranch: true,
			depth: 1,
		});
		await workspace.writeFile(HYDRATION_SENTINEL, new Date().toISOString());
	}

	const agent = createAgent(() => ({
		sandbox: getShellSandbox({ workspace, loader: env.LOADER }),
		model: 'cloudflare/@cf/moonshotai/kimi-k2.6',
		cwd: CLONE_DIR,
	}));
	const harness = await init(agent);
	const session = await harness.session();

	// Ask the agent to introspect the cloned repo via the code tool.
	// The model will write something like:
	//   async () => state.readdir("/repo")
	// and we return whatever it discovers.
	const { text } = await session.prompt(
		`Use the code tool to list every top-level file and directory inside ${CLONE_DIR}, ` +
			'then briefly describe what this project is based on what you see. ' +
			'Do not respond until you have actually inspected the directory.',
	);

	return { repo: TARGET_REPO, summary: text };
}
