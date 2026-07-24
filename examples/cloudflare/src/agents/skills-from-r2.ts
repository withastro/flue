'use agent';
/**
 * Demonstrates hydrating a cf-shell `Workspace` from an R2 bucket and using a
 * skill discovered from the hydrated files. The bucket hydration is one-time
 * setup for the environment, not per-render work, so it lives inside a
 * self-authored `SandboxFactory` passed to `useSandbox` — lazy, per the
 * `SandboxFactory` contract: constructing the factory object is cheap; the
 * expensive R2 read happens once, inside `createSessionEnv()`, at
 * initialization. The skill invocation lives in the model-callable
 * `check_spam` tool below (`harness: true` gives its run a child harness
 * whose scratch session discovers the same hydrated skills — the prompt
 * names the skill and requires a structured verdict):
 *
 *   curl -X POST /agents/skills-from-r2/<id> \
 *     -H 'Content-Type: application/json' \
 *     -d '{"kind": "user", "body": "Check this message for spam: CONGRATS! You won a free iPhone: http://bit.ly/xyz"}'
 *
 * then read the verdict from the conversation stream: GET /agents/skills-from-r2/<id>
 */
import { env } from 'cloudflare:workers';
import { defineTool, useModel, useSandbox, useTool } from '@flue/runtime';
import * as v from 'valibot';
import {
	getDefaultWorkspace,
	getShellSandbox,
	hydrateFromBucket,
} from '../sandboxes/cloudflare-shell';

interface Env {
	KNOWLEDGE_BASE: R2Bucket;
	LOADER: WorkerLoader;
}

const HYDRATION_SENTINEL = '/.hydrated';

const checkSpam = defineTool({
	name: 'check_spam',
	description:
		'Classify a message as spam or not using the spam-filter skill from the hydrated knowledge base. Returns a structured verdict.',
	input: v.object({ message: v.string() }),
	output: v.object({
		spam: v.boolean(),
		confidence: v.picklist(['low', 'medium', 'high']),
		reasoning: v.string(),
	}),
	harness: true,
	async run({ harness, data }) {
		const result = await harness.prompt(
			`Use the spam-filter skill to classify the following message:\n\n${data.message}`,
			{
				result: v.object({
					spam: v.boolean(),
					confidence: v.picklist(['low', 'medium', 'high']),
					reasoning: v.string(),
				}),
			},
		);
		return result.data;
	},
});

export function SkillsFromR2() {
	useModel('cloudflare/@cf/moonshotai/kimi-k2.6');
	// Lazy, per the SandboxFactory contract: constructing this object (and the
	// inner `getShellSandbox()` factory it wraps) is cheap; the expensive R2
	// bucket read happens once, inside createSessionEnv(), at initialization —
	// never on a re-render. `tools` is forwarded from the inner factory so the
	// model still gets the shell's `code` tool instead of the framework
	// default (the cf-shell env's `exec()` always throws).
	const { KNOWLEDGE_BASE, LOADER } = env as unknown as Env;
	const workspace = getDefaultWorkspace();
	const shell = getShellSandbox({ workspace, loader: LOADER });
	useSandbox({
		tools: shell.tools,
		async createSessionEnv(options) {
			if (!(await workspace.exists(HYDRATION_SENTINEL))) {
				await hydrateFromBucket(workspace, KNOWLEDGE_BASE);
				await workspace.writeFile(HYDRATION_SENTINEL, new Date().toISOString());
			}
			return shell.createSessionEnv(options);
		},
	});
	useTool(checkSpam);
	return 'When asked whether a message is spam, call the check_spam tool with the message text and report its verdict.';
}
