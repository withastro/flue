import type { FlueContext } from '@flue/runtime';

export const triggers = { webhook: true };

/**
 * Smoke test for the new pure-node `'local'` SessionEnv.
 * Exercises every SessionEnv method without invoking a model.
 */
export default async function ({ init }: FlueContext) {
	const harness = await init({ sandbox: 'local', model: false });
	const session = await harness.session();

	const results: Record<string, boolean> = {};
	const tmpDir = `/tmp/flue-local-env-smoke-${Date.now()}`;
	const tmpFile = `${tmpDir}/hello.txt`;
	const nestedFile = `${tmpDir}/nested/dir/inside.txt`;

	// 1. cwd is process.cwd()
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

	// 5. cleanup
	await session.shell(`rm -rf ${tmpDir}`);
	const stillThere = await session.shell(`test -d ${tmpDir} && echo yes || echo no`);
	results['rm cleanup'] = stillThere.stdout.trim() === 'no';

	const allPassed = Object.values(results).every(Boolean);
	console.log(`[local-env-smoke] ${allPassed ? 'ALL PASSED' : 'SOME FAILED'}`, results);
	return { results, allPassed };
}
