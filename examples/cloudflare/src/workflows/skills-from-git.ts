import { WorkspaceFileSystem } from '@cloudflare/shell';
import { createGit } from '@cloudflare/shell/git';
import { defineAgent, defineWorkflow, type WorkflowRouteHandler } from '@flue/runtime';
import { getDefaultWorkspace, getShellSandbox } from '../sandboxes/cloudflare-shell';

export const route: WorkflowRouteHandler = async (_c, next) => next();
interface Env {
	LOADER: WorkerLoader;
}
const HYDRATION_SENTINEL = '/.hydrated';
const TARGET_REPO = 'https://github.com/FredKSchott/vinext-starter';
const CLONE_DIR = '/repo';
const agent = defineAgent<Env>(async ({ env }) => {
	const workspace = getDefaultWorkspace();
	if (!(await workspace.exists(HYDRATION_SENTINEL))) {
		const git = createGit(new WorkspaceFileSystem(workspace));
		await git.clone({ url: TARGET_REPO, dir: CLONE_DIR, singleBranch: true, depth: 1 });
		await workspace.writeFile(HYDRATION_SENTINEL, new Date().toISOString());
	}
	return {
		sandbox: getShellSandbox({ workspace, loader: env.LOADER }),
		model: 'cloudflare/@cf/moonshotai/kimi-k2.6',
		cwd: CLONE_DIR,
	};
});

export default defineWorkflow({
	agent,
	async run({ harness }) {
		const session = await harness.session();
		const { text } = await session.prompt(
			`Use the code tool to list every top-level file and directory inside ${CLONE_DIR}, ` +
				'then briefly describe what this project is based on what you see. ' +
				'Do not respond until you have actually inspected the directory.',
		);
		return { repo: TARGET_REPO, summary: text };
	},
});
