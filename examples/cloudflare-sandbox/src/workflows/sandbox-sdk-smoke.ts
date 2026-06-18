import { getSandbox } from '@cloudflare/sandbox';
import { createAgent, type FlueContext, type WorkflowRouteHandler } from '@flue/runtime';
import { cloudflareSandbox } from '@flue/runtime/cloudflare';

export const route: WorkflowRouteHandler = async (_c, next) => next();

interface Env {
	Sandbox: DurableObjectNamespace;
}

const sandboxedAgent = createAgent(({ id, env }) => ({
	model: false,
	instructions:
		'You are a smoke-test agent. This workflow exercises your sandbox through deterministic harness calls.',
	sandbox: cloudflareSandbox(getSandbox(env.Sandbox, id)),
}));

export async function run(ctx: FlueContext<unknown, Env>) {
	const harness = await ctx.init(sandboxedAgent);
	await harness.fs.writeFile('/workspace/flue-smoke.txt', 'hello from Flue via Cloudflare Sandbox');

	const result = await harness.shell(
		'printf "file: "; cat /workspace/flue-smoke.txt; printf "\\npwd: "; pwd',
	);

	return {
		exitCode: result.exitCode,
		stdout: result.stdout,
		stderr: result.stderr,
	};
}
