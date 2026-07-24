'use agent';
import { useModel, useSandbox, useTool } from '@flue/runtime';
import { local } from '@flue/runtime/node';

const sentinelKey = '__FLUE_LOCAL_SMOKE_SENTINEL__';

export function LocalEnvSmoke() {
	useModel('anthropic/claude-haiku-4-5');
	useSandbox(local({ env: { CUSTOM_VAR: 'visible-to-sandbox' } }));
	useTool({
		name: 'local-env-smoke',
		description: 'Verify the local() sandbox environment allowlist and shell behavior.',
		harness: true,
		async run({ harness }) {
			const previous = process.env[sentinelKey];
			process.env[sentinelKey] = 'leaked';
			try {
				const results: Record<string, boolean> = {};
				const tmpDir = `/tmp/flue-local-env-smoke-${Date.now()}`;
				results['shell pwd matches process.cwd()'] =
					(await harness.sandbox.exec('pwd')).stdout.trim() === process.cwd();
				await harness.sandbox.exec(`mkdir -p ${tmpDir}`);
				await harness.sandbox.exec(`echo "hello world" > ${tmpDir}/hello.txt`);
				results['shell read file'] =
					(await harness.sandbox.exec(`cat ${tmpDir}/hello.txt`)).stdout.trim() === 'hello world';
				results['exec non-zero exit'] = (await harness.sandbox.exec('exit 7')).exitCode === 7;
				results['PATH inherited via default allowlist'] =
					(await harness.sandbox.exec('echo "$PATH"')).stdout.trim().length > 0;
				results['explicit env var visible'] =
					(await harness.sandbox.exec('echo "$CUSTOM_VAR"')).stdout.trim() === 'visible-to-sandbox';
				results['sentinel host env var NOT leaked'] =
					(await harness.sandbox.exec(`echo "$${sentinelKey}"`)).stdout.trim() === '';
				await harness.sandbox.exec(`rm -rf ${tmpDir}`);
				return { results, allPassed: Object.values(results).every(Boolean) };
			} finally {
				if (previous === undefined) delete process.env[sentinelKey];
				else process.env[sentinelKey] = previous;
			}
		},
	});
	return 'When asked to run a demo, call the `local-env-smoke` tool and report its result.';
}
