import type { FlueContext } from '@flue/runtime';

export const triggers = { webhook: true };

/**
 * Cancellation test.
 *
 * Verifies that:
 * - `options.signal` (incl. `AbortSignal.timeout`) cancels prompt() and shell()
 * - `handle.abort(reason)` cancels mid-flight from another async branch
 * - pre-aborted signals reject before any work
 * - aborts tear down in-flight bash tool commands
 */
export default async function ({ init }: FlueContext) {
	const harness = await init({ model: 'anthropic/claude-haiku-4-5' });
	const session = await harness.session();

	// Test 1: prompt() with AbortSignal.timeout
	let timeoutAborted = false;
	try {
		await session.prompt(
			'Run `sleep 30` via the bash tool, then describe what happened.',
			{ signal: AbortSignal.timeout(2_000) },
		);
	} catch (err) {
		timeoutAborted = isAbortError(err);
		console.log('[abort] timeout case:', timeoutAborted ? 'PASS' : 'FAIL', formatError(err));
	}

	// Test 2: handle.abort() with reason
	const handle = session.prompt(
		'Run `sleep 30` via the bash tool, then describe what happened.',
	);
	setTimeout(() => handle.abort('user-cancel'), 1_000);
	let manualAborted = false;
	let manualReason: unknown;
	try {
		await handle;
	} catch (err) {
		manualAborted = isAbortError(err);
		manualReason = err instanceof Error ? (err as any).cause : undefined;
		console.log(
			'[abort] manual case:',
			manualAborted ? 'PASS' : 'FAIL',
			'reason=',
			JSON.stringify(manualReason),
		);
	}

	// Test 3: pre-aborted signal
	let preAborted = false;
	try {
		await session.prompt('Say hi.', { signal: AbortSignal.abort('already done') });
	} catch (err) {
		preAborted = isAbortError(err);
		console.log('[abort] pre-aborted case:', preAborted ? 'PASS' : 'FAIL', formatError(err));
	}

	// Test 4: shell() with AbortSignal.timeout
	let shellTimeoutAborted = false;
	try {
		await session.shell('sleep 30', { signal: AbortSignal.timeout(1_000) });
	} catch (err) {
		shellTimeoutAborted = isAbortError(err);
		console.log(
			'[abort] shell timeout case:',
			shellTimeoutAborted ? 'PASS' : 'FAIL',
			formatError(err),
		);
	}

	// Test 5: shell() handle.abort()
	const shellHandle = session.shell('sleep 30');
	setTimeout(() => shellHandle.abort('shell-user-cancel'), 1_000);
	let shellManualAborted = false;
	try {
		await shellHandle;
	} catch (err) {
		shellManualAborted = isAbortError(err);
		console.log(
			'[abort] shell manual case:',
			shellManualAborted ? 'PASS' : 'FAIL',
			formatError(err),
		);
	}

	const allPassed =
		timeoutAborted && manualAborted && preAborted && shellTimeoutAborted && shellManualAborted;
	console.log(`[abort] ${allPassed ? 'ALL PASSED' : 'SOME FAILED'}`);
	return {
		timeoutAborted,
		manualAborted,
		preAborted,
		shellTimeoutAborted,
		shellManualAborted,
		allPassed,
	};
}

function isAbortError(err: unknown): boolean {
	return !!err && typeof err === 'object' && (err as { name?: unknown }).name === 'AbortError';
}

function formatError(err: unknown): string {
	if (err instanceof Error) return `${err.name}: ${err.message}`;
	return String(err);
}
