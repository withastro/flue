import { type FlueContext } from '@flue/sdk/client';
import { defineCommand } from '@flue/sdk/node';

export const triggers = { webhook: true };

// Form A: bare pass-through. Default env exposes only PATH + HOME.
const node = defineCommand('node');

// Form B: pass-through with custom execFile options. The default safe env
// (PATH, HOME, LANG, TZ, etc.) is merged underneath — callers only need to
// specify the extras they care about.
const nodeWithEnv = defineCommand('node', {
	env: { TEST_VAR: 'injected-value' },
});

// Form C: full user-supplied executor. Partial returns + throws are normalized
// automatically — no `try/catch` and no `{ stdout, stderr, exitCode: 0 }` boilerplate.
const nodeCustom = defineCommand('node', async (args) => {
	const { execFile } = await import('node:child_process');
	const { promisify } = await import('node:util');
	const { stdout, stderr } = await promisify(execFile)('node', args, {
		env: { PATH: process.env.PATH },
	});
	return { stdout, stderr };
});

// Verifies throw-handling: executor that throws should produce a non-zero
// exitCode, not crash the agent.
const bogus = defineCommand('bogus', async () => {
	throw new Error('intentional failure');
});

export default async function ({ init }: FlueContext) {
	const session = await init({ sandbox: 'local' });

	// Test 1: Read a workspace file (ReadWriteFs reads from real filesystem)
	const cat = await session.shell('cat AGENTS.md');
	const readOk = cat.stdout.trim().length > 0;
	console.log('[commands] read workspace file:', readOk ? 'PASS' : 'FAIL');

	// Test 2: Form A — bare pass-through
	const result = await session.shell('node --version', { commands: [node] });
	const nodeOk = result.stdout.trim().startsWith('v');
	console.log('[commands] form A (pass-through):', result.stdout.trim(), nodeOk ? 'PASS' : 'FAIL');

	// Test 3: External command is NOT available without commands option
	const noNode = await session.shell('node --version');
	const blockedOk = noNode.exitCode !== 0;
	console.log('[commands] node blocked without commands:', blockedOk ? 'PASS' : 'FAIL');

	// Test 4: Form B — pass-through with env
	const envResult = await session.shell('node -e "process.stdout.write(process.env.TEST_VAR)"', {
		commands: [nodeWithEnv],
	});
	const envOk = envResult.stdout.trim() === 'injected-value';
	console.log('[commands] form B (env injection):', envOk ? 'PASS' : 'FAIL');

	// Test 5: Server env vars do NOT leak to pass-through commands (form A only
	// exposes PATH + HOME, no ANTHROPIC_API_KEY).
	const leakResult = await session.shell(
		'node -e "process.stdout.write(process.env.ANTHROPIC_API_KEY || \'\')"',
		{ commands: [node] },
	);
	const noLeakOk = leakResult.stdout.trim() === '';
	console.log('[commands] env isolation (no API key leak):', noLeakOk ? 'PASS' : 'FAIL');

	// Test 6: Form C — user-supplied executor
	const customResult = await session.shell('node --version', { commands: [nodeCustom] });
	const customOk = customResult.stdout.trim().startsWith('v');
	console.log('[commands] form C (custom executor):', customOk ? 'PASS' : 'FAIL');

	// Test 7: Throw handling. A throwing executor must resolve with non-zero
	// exitCode rather than reject and crash the agent.
	const throwResult = await session.shell('bogus', { commands: [bogus] });
	const throwOk = throwResult.exitCode !== 0 && throwResult.stderr.includes('intentional failure');
	console.log(
		'[commands] form C (throws normalized):',
		`exitCode=${throwResult.exitCode}`,
		throwOk ? 'PASS' : 'FAIL',
	);

	// Test 8: Non-zero exitCode from execFile throw should propagate.
	const nonZero = defineCommand('node', async (args) => {
		const { execFile } = await import('node:child_process');
		const { promisify } = await import('node:util');
		await promisify(execFile)('node', args, { env: { PATH: process.env.PATH } });
	});
	const exitResult = await session.shell('node -e "process.exit(3)"', { commands: [nonZero] });
	const exitOk = exitResult.exitCode === 3;
	console.log(
		'[commands] form C (exitCode from throw):',
		`exitCode=${exitResult.exitCode}`,
		exitOk ? 'PASS' : 'FAIL',
	);

	const allPassed =
		readOk && nodeOk && blockedOk && envOk && noLeakOk && customOk && throwOk && exitOk;
	console.log(`[commands] ${allPassed ? 'ALL PASSED' : 'SOME FAILED'}`);
	return {
		readOk,
		nodeOk,
		blockedOk,
		envOk,
		noLeakOk,
		customOk,
		throwOk,
		exitOk,
		allPassed,
	};
}
