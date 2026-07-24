'use agent';
/**
 * Demonstrates hydrating a cf-shell `Workspace` from a git repository via
 * `createGit`, then letting the model explore it with the sandbox's `code`
 * tool. The clone hydration is one-time setup for the environment, not
 * per-render work, so it lives inside a self-authored `SandboxFactory`
 * passed to `useSandbox` — lazy, per the `SandboxFactory` contract:
 * constructing the factory object is cheap; the expensive clone happens
 * once, inside `createSessionEnv()`, at initialization.
 *
 *   curl -X POST /agents/skills-from-git/<id> \
 *     -H 'Content-Type: application/json' \
 *     -d '{"kind": "user", "body": "List every top-level file and directory in the repo, then describe the project."}'
 *
 * then read the reply from the conversation stream: GET /agents/skills-from-git/<id>
 */
import { env } from 'cloudflare:workers';
import { WorkspaceFileSystem } from '@cloudflare/shell';
import { createGit } from '@cloudflare/shell/git';
import { useModel, useSandbox } from '@flue/runtime';
import { getDefaultWorkspace, getShellSandbox } from '../sandboxes/cloudflare-shell';

interface Env {
	LOADER: WorkerLoader;
}

const HYDRATION_SENTINEL = '/.hydrated';
const TARGET_REPO = 'https://github.com/FredKSchott/vinext-starter';
const CLONE_DIR = '/repo';

export function SkillsFromGit() {
	useModel('cloudflare/@cf/moonshotai/kimi-k2.6');
	// Lazy, per the SandboxFactory contract: constructing this object (and the
	// inner `getShellSandbox()` factory it wraps) is cheap; the expensive git
	// clone happens once, inside createSessionEnv(), at initialization — never
	// on a re-render. `tools` is forwarded from the inner factory so the
	// model still gets the shell's `code` tool instead of the framework
	// default (the cf-shell env's `exec()` always throws).
	const { LOADER } = env as unknown as Env;
	const workspace = getDefaultWorkspace();
	const shell = getShellSandbox({ workspace, loader: LOADER });
	useSandbox(
		{
			tools: shell.tools,
			async createSessionEnv(options) {
				if (!(await workspace.exists(HYDRATION_SENTINEL))) {
					const git = createGit(new WorkspaceFileSystem(workspace));
					await git.clone({ url: TARGET_REPO, dir: CLONE_DIR, singleBranch: true, depth: 1 });
					await workspace.writeFile(HYDRATION_SENTINEL, new Date().toISOString());
				}
				return shell.createSessionEnv(options);
			},
		},
		{ cwd: CLONE_DIR },
	);
	return (
		`You operate inside a clone of ${TARGET_REPO} at ${CLONE_DIR}. ` +
		'When asked about the repository, use the code tool to actually inspect the files ' +
		'before answering — never answer from assumption.'
	);
}
