import { type FlueContext } from '@flue/sdk/client';
import { defineCommand } from '@flue/sdk/node';

export const triggers = { webhook: true };

// Form A: bare pass-through.
const node = defineCommand('node');

// Form B: pass-through with injected env var.
const nodeWithEnv = defineCommand('node-env', {
	// Use a distinct command name so session-wide registration doesn't collide.
	// `node-env` isn't a real binary — we'll override this name when running
	// so the test actually invokes `node`.
	env: { TEST_VAR: 'injected-value' },
});

// A custom node-env command that shells out to the real `node` binary while
// preserving the TEST_VAR env injection.
const realNodeEnv = defineCommand('node-env', async (args) => {
	const { execFile } = await import('node:child_process');
	const { promisify } = await import('node:util');
	const { stdout, stderr } = await promisify(execFile)('node', args, {
		env: { PATH: process.env.PATH, TEST_VAR: 'injected-value' },
	});
	return { stdout, stderr };
});

export default async function ({ init }: FlueContext) {
	// Session-wide commands attach to every prompt / skill / shell call.
	const session = await init({
		sandbox: 'local',
		commands: [node, realNodeEnv],
	});

	// Test 1: Session-wide form A command works without per-call `commands`.
	const inheritedA = await session.shell('node --version');
	const inheritedOk = inheritedA.stdout.trim().startsWith('v');
	console.log(
		'[session-commands] form A inherited:',
		inheritedA.stdout.trim(),
		inheritedOk ? 'PASS' : 'FAIL',
	);

	// Test 2: Session-wide form B command also works without per-call `commands`.
	const inheritedB = await session.shell(
		'node-env -e "process.stdout.write(process.env.TEST_VAR)"',
	);
	const inheritedEnvOk = inheritedB.stdout.trim() === 'injected-value';
	console.log(
		'[session-commands] form B inherited (env injection):',
		inheritedEnvOk ? 'PASS' : 'FAIL',
	);

	// Test 3: Per-call commands are merged with session commands. Both the
	// session-wide `node` and the per-call `extra` should be available.
	const extra = defineCommand('echo-sentinel', async () => ({ stdout: 'sentinel' }));
	const mergedResult = await session.shell('echo-sentinel', { commands: [extra] });
	const mergedOk = mergedResult.stdout.trim() === 'sentinel';
	console.log(
		'[session-commands] per-call merges with session:',
		mergedResult.stdout.trim(),
		mergedOk ? 'PASS' : 'FAIL',
	);
	// And the session-wide `node` is still there in the same call.
	const stillHaveNode = await session.shell('node --version');
	const stillHaveNodeOk = stillHaveNode.stdout.trim().startsWith('v');
	console.log(
		'[session-commands] session command still present after merged call:',
		stillHaveNodeOk ? 'PASS' : 'FAIL',
	);

	// Test 4: Per-call command with the same name overrides the session
	// command for that call only.
	const override = defineCommand('node', async () => ({ stdout: 'override' }));
	const overrideResult = await session.shell('node --version', { commands: [override] });
	const overrideOk = overrideResult.stdout.trim() === 'override';
	console.log(
		'[session-commands] per-call overrides session by name:',
		overrideResult.stdout.trim(),
		overrideOk ? 'PASS' : 'FAIL',
	);
	// After the overriding call returns, the session command is restored.
	const restored = await session.shell('node --version');
	const restoredOk = restored.stdout.trim().startsWith('v');
	console.log(
		'[session-commands] session command restored after override:',
		restored.stdout.trim(),
		restoredOk ? 'PASS' : 'FAIL',
	);

	const allPassed =
		inheritedOk &&
		inheritedEnvOk &&
		mergedOk &&
		stillHaveNodeOk &&
		overrideOk &&
		restoredOk;
	console.log(`[session-commands] ${allPassed ? 'ALL PASSED' : 'SOME FAILED'}`);
	return {
		inheritedOk,
		inheritedEnvOk,
		mergedOk,
		stillHaveNodeOk,
		overrideOk,
		restoredOk,
		allPassed,
	};
}
