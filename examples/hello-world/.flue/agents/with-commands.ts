import { defineCommand, type FlueContext } from '@flue/sdk/client';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const triggers = { webhook: true };

const node = defineCommand('node', async (args) => {
	const { stdout, stderr } = await promisify(execFile)('node', args, { 
		env: { PATH: process.env.PATH } 
	});
	return { stdout: stdout || '', stderr: stderr || '', exitCode: 0 };
});

const nodeWithEnv = defineCommand('node', async (args) => {
	const { stdout, stderr } = await promisify(execFile)('node', args, {
		env: { PATH: process.env.PATH, TEST_VAR: 'injected-value' },
	});
	return { stdout: stdout || '', stderr: stderr || '', exitCode: 0 };
});

export default async function ({ init }: FlueContext) {
	const session = await init({ sandbox: 'local' });

	// Test 1: Read a workspace file (ReadWriteFs reads from real filesystem)
	const cat = await session.shell('cat AGENTS.md');
	const readOk = cat.stdout.trim().length > 0;
	console.log('[commands] read workspace file:', readOk ? 'PASS' : 'FAIL');

	// Test 2: Run an external command via commands option
	const result = await session.shell('node --version', { commands: [node] });
	const nodeOk = result.stdout.trim().startsWith('v');
	console.log('[commands] node --version:', result.stdout.trim(), nodeOk ? 'PASS' : 'FAIL');

	// Test 3: External command is NOT available without commands option
	const noNode = await session.shell('node --version');
	const blockedOk = noNode.exitCode !== 0;
	console.log('[commands] node blocked without commands:', blockedOk ? 'PASS' : 'FAIL');

	// Test 4: Commands with env injection
	const envResult = await session.shell('node -e "process.stdout.write(process.env.TEST_VAR)"', {
		commands: [nodeWithEnv],
	});
	const envOk = envResult.stdout.trim() === 'injected-value';
	console.log('[commands] env injection:', envOk ? 'PASS' : 'FAIL');

	// Test 5: Server env vars do NOT leak to spawned commands
	const leakResult = await session.shell(
		'node -e "process.stdout.write(process.env.ANTHROPIC_API_KEY || \'\')"',
		{ commands: [node] },
	);
	const noLeakOk = leakResult.stdout.trim() === '';
	console.log('[commands] env isolation (no API key leak):', noLeakOk ? 'PASS' : 'FAIL');

	const allPassed = readOk && nodeOk && blockedOk && envOk && noLeakOk;
	console.log(`[commands] ${allPassed ? 'ALL PASSED' : 'SOME FAILED'}`);
	return { readOk, nodeOk, blockedOk, envOk, noLeakOk, allPassed };
}
