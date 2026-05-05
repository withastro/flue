import type { FlueContext } from '@flue/sdk/client';
import { Compute } from '@boxd-sh/sdk';
import { boxd } from '../connectors/boxd';

export const triggers = { webhook: true };

export default async function ({ init }: FlueContext) {
	// User owns the boxd SDK relationship — create and configure the box directly.
	const c = new Compute({ apiKey: process.env.BOXD_API_KEY });
	const box = await c.box.create({ name: `flue-test-${Date.now()}` });
	console.log('[boxd] created box:', box.name, '→', box.url);

	try {
		const agent = await init({
			sandbox: boxd(box, { cleanup: true }),
			model: 'anthropic/claude-sonnet-4-6',
		});
		const session = await agent.session();

		// 1. uname through the sandbox.
		const uname = await session.shell('uname -a');
		console.log('[boxd] uname:', uname.stdout.trim());
		const unameOk = uname.exitCode === 0 && uname.stdout.includes('Linux');

		// 2. file round-trip via shell.
		await session.shell('echo "hello from boxd" > /tmp/test.txt');
		const cat = await session.shell('cat /tmp/test.txt');
		const fileOk = cat.stdout.trim() === 'hello from boxd';
		console.log('[boxd] file round-trip:', fileOk ? 'PASS' : 'FAIL');

		// 3. compound command (cwd handling, bash -lc).
		const compound = await session.shell('echo step1 && echo step2');
		const compoundOk =
			compound.stdout.includes('step1') && compound.stdout.includes('step2');
		console.log('[boxd] compound:', compoundOk ? 'PASS' : 'FAIL');

		// 4. pipes (raw shell, not just-bash).
		const pipeResult = await session.shell('echo -e "a\\nb\\nc" | wc -l');
		const pipeCount = pipeResult.stdout.trim();
		const pipeOk = pipeResult.exitCode === 0 && pipeCount === '3';
		console.log('[boxd] pipe:', pipeOk ? 'PASS' : `FAIL (got "${pipeCount}")`);

		// 5. find | wc (shell glue).
		await session.shell(
			'mkdir -p /tmp/pipe-test && touch /tmp/pipe-test/a.txt /tmp/pipe-test/b.txt /tmp/pipe-test/c.txt',
		);
		const findWc = await session.shell('find /tmp/pipe-test -type f | wc -l');
		const findWcCount = findWc.stdout.trim();
		const findWcOk = findWc.exitCode === 0 && findWcCount === '3';
		console.log('[boxd] find|wc:', findWcOk ? 'PASS' : `FAIL (got "${findWcCount}")`);

		const allPassed = unameOk && fileOk && compoundOk && pipeOk && findWcOk;
		console.log(`[boxd] ${allPassed ? 'ALL PASSED' : 'SOME FAILED'}`);
		return { unameOk, fileOk, compoundOk, pipeOk, findWcOk, allPassed };
	} finally {
		// `cleanup: true` on the connector destroys the box on session end,
		// but close the gRPC client so the process can exit cleanly.
		await c.close();
	}
}
