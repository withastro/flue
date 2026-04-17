import type { FlueContext } from '@flue/sdk/client';
import { Daytona } from '@daytona/sdk';
import { daytona } from '@flue/connectors/daytona';

export const triggers = { webhook: true };

export default async function ({ init }: FlueContext) {
	// User owns the Daytona SDK relationship — create and configure the sandbox directly
	const client = new Daytona({ apiKey: process.env.DAYTONA_API_KEY });
	const sandbox = await client.create();

	const session = await init({
		sandbox: daytona(sandbox, { cleanup: true }),
	});

	// Test 1: Run a shell command in the remote sandbox
	const uname = await session.shell('uname -a');
	console.log('[sandbox] uname:', uname.stdout.trim());
	const unameOk = uname.exitCode === 0 && uname.stdout.includes('Linux');

	// Test 2: Write and read a file
	await session.shell('echo "hello from sandbox" > /tmp/test.txt');
	const cat = await session.shell('cat /tmp/test.txt');
	const fileOk = cat.stdout.trim() === 'hello from sandbox';
	console.log('[sandbox] file round-trip:', fileOk ? 'PASS' : 'FAIL');

	// Test 3: Run a compound command (tests shell decomposition)
	const compound = await session.shell('echo step1 && echo step2');
	const compoundOk = compound.stdout.includes('step1') && compound.stdout.includes('step2');
	console.log('[sandbox] compound command:', compoundOk ? 'PASS' : 'FAIL');

	// Test 4: Pipes work natively (requires raw shell, not just-bash)
	const pipeResult = await session.shell('echo -e "a\\nb\\nc" | wc -l');
	const pipeCount = pipeResult.stdout.trim();
	const pipeOk = pipeResult.exitCode === 0 && pipeCount === '3';
	console.log('[sandbox] pipe command:', pipeOk ? 'PASS' : `FAIL (got "${pipeCount}")`);

	// Test 5: Redirections work natively
	await session.shell('echo "redirected content" > /tmp/redirect-test.txt');
	const redirectRead = await session.shell('cat /tmp/redirect-test.txt');
	const redirectOk = redirectRead.stdout.trim() === 'redirected content';
	console.log('[sandbox] redirect:', redirectOk ? 'PASS' : 'FAIL');

	// Test 6: Complex pipe chain (find | wc)
	await session.shell(
		'mkdir -p /tmp/pipe-test && touch /tmp/pipe-test/a.txt /tmp/pipe-test/b.txt /tmp/pipe-test/c.txt',
	);
	const findWc = await session.shell('find /tmp/pipe-test -type f | wc -l');
	const findWcCount = findWc.stdout.trim();
	const findWcOk = findWc.exitCode === 0 && findWcCount === '3';
	console.log('[sandbox] find|wc pipe:', findWcOk ? 'PASS' : `FAIL (got "${findWcCount}")`);

	const allPassed = unameOk && fileOk && compoundOk && pipeOk && redirectOk && findWcOk;
	console.log(`[sandbox] ${allPassed ? 'ALL PASSED' : 'SOME FAILED'}`);
	return { unameOk, fileOk, compoundOk, pipeOk, redirectOk, findWcOk, allPassed };
}
