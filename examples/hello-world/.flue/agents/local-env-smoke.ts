import type { FlueContext } from '@flue/runtime';
import { local } from '@flue/runtime/node';

export const triggers = { webhook: true };

/**
 * Smoke test for the `local()` sandbox factory on Node.
 *
 * Exercises every SessionEnv method without invoking a model, plus the
 * env-allowlist semantics: only declared env vars reach the spawned shell.
 */
export default async function ({ init }: FlueContext) {
	// Sentinel host var that the env-allowlist check below confirms does
	// NOT cross the sandbox boundary. Restored in `finally` for re-runs.
	const sentinelKey = '__FLUE_LOCAL_SMOKE_SENTINEL__';
	const prevSentinel = process.env[sentinelKey];
	process.env[sentinelKey] = 'leaked';

	try {
		const harness = await init({
			sandbox: local({
				// `CUSTOM_VAR` is the only thing past the allowlist; the
				// sentinel above is intentionally NOT listed.
				env: { CUSTOM_VAR: 'visible-to-sandbox' },
			}),
			model: false,
		});
		const session = await harness.session();

		const results: Record<string, boolean> = {};
		const tmpDir = `/tmp/flue-local-env-smoke-${Date.now()}`;
		const tmpFile = `${tmpDir}/hello.txt`;
		const nestedFile = `${tmpDir}/nested/dir/inside.txt`;

		// 1. cwd defaults to process.cwd()
		results['cwd is process.cwd()'] = session.shell !== undefined;
		const cwdShell = await session.shell('pwd');
		results['shell pwd matches process.cwd()'] = cwdShell.stdout.trim() === process.cwd();
		console.log('[local-env-smoke] pwd:', cwdShell.stdout.trim());

		// 2. mkdir + write + read + readdir, all under /tmp so the repo
		// working tree is never touched. Cleanup at the end leaves a no-op.
		await session.shell(`mkdir -p ${tmpDir}`);
		await session.shell(`echo "hello world" > ${tmpFile}`);

		const catResult = await session.shell(`cat ${tmpFile}`);
		results['shell read file'] = catResult.stdout.trim() === 'hello world';

		const lsResult = await session.shell(`ls ${tmpDir}`);
		results['shell readdir'] = lsResult.stdout.includes('hello.txt');

		// 3. exec error paths return non-zero exit code (not throw)
		const failed = await session.shell('exit 7');
		results['exec non-zero exit'] = failed.exitCode === 7;
		console.log('[local-env-smoke] exit-7 result:', failed.exitCode);

		// 4. Nested directory creation works.
		await session.shell(`mkdir -p $(dirname ${nestedFile}) && echo nested > ${nestedFile}`);
		const nestedRead = await session.shell(`cat ${nestedFile}`);
		results['nested write+read'] = nestedRead.stdout.trim() === 'nested';

		// 5. Env allowlist: default vars present, opt-ins present, host
		// vars outside both NOT visible to the spawned shell.
		const pathRes = await session.shell('echo "$PATH"');
		results['PATH inherited via default allowlist'] = pathRes.stdout.trim().length > 0;

		const customRes = await session.shell('echo "$CUSTOM_VAR"');
		results['explicit env var visible'] = customRes.stdout.trim() === 'visible-to-sandbox';

		const sentinelRes = await session.shell(`echo "$${sentinelKey}"`);
		results['sentinel host env var NOT leaked'] = sentinelRes.stdout.trim() === '';
		console.log(
			`[local-env-smoke] sentinel inside sandbox: "${sentinelRes.stdout.trim()}" (expected empty)`,
		);

		// 6. cleanup
		await session.shell(`rm -rf ${tmpDir}`);
		const stillThere = await session.shell(`test -d ${tmpDir} && echo yes || echo no`);
		results['rm cleanup'] = stillThere.stdout.trim() === 'no';

		const allPassed = Object.values(results).every(Boolean);
		console.log(`[local-env-smoke] ${allPassed ? 'ALL PASSED' : 'SOME FAILED'}`, results);
		return { results, allPassed };
	} finally {
		if (prevSentinel === undefined) delete process.env[sentinelKey];
		else process.env[sentinelKey] = prevSentinel;
	}
}
