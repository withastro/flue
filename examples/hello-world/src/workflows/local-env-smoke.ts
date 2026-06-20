import { defineAgent, defineWorkflow, type WorkflowRouteHandler } from '@flue/runtime';
import { local } from '@flue/runtime/node';

export const route: WorkflowRouteHandler = async (_c, next) => next();
const sentinelKey = '__FLUE_LOCAL_SMOKE_SENTINEL__';
const agent = defineAgent(() => ({
	sandbox: local({ env: { CUSTOM_VAR: 'visible-to-sandbox' } }),
	model: false,
}));

export default defineWorkflow({
	agent,
	async run({ harness }) {
		const previous = process.env[sentinelKey];
		process.env[sentinelKey] = 'leaked';
		try {
			const session = await harness.session();
			const results: Record<string, boolean> = {};
			const tmpDir = `/tmp/flue-local-env-smoke-${Date.now()}`;
			results['shell pwd matches process.cwd()'] =
				(await session.shell('pwd')).stdout.trim() === process.cwd();
			await session.shell(`mkdir -p ${tmpDir}`);
			await session.shell(`echo "hello world" > ${tmpDir}/hello.txt`);
			results['shell read file'] =
				(await session.shell(`cat ${tmpDir}/hello.txt`)).stdout.trim() === 'hello world';
			results['exec non-zero exit'] = (await session.shell('exit 7')).exitCode === 7;
			results['PATH inherited via default allowlist'] =
				(await session.shell('echo "$PATH"')).stdout.trim().length > 0;
			results['explicit env var visible'] =
				(await session.shell('echo "$CUSTOM_VAR"')).stdout.trim() === 'visible-to-sandbox';
			results['sentinel host env var NOT leaked'] =
				(await session.shell(`echo "$${sentinelKey}"`)).stdout.trim() === '';
			await session.shell(`rm -rf ${tmpDir}`);
			return { results, allPassed: Object.values(results).every(Boolean) };
		} finally {
			if (previous === undefined) delete process.env[sentinelKey];
			else process.env[sentinelKey] = previous;
		}
	},
});
