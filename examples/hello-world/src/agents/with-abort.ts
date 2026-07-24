'use agent';
import { bash, useModel, useSandbox, useTool } from '@flue/runtime';
import { Bash, InMemoryFs } from 'just-bash';

function isAbortError(error: unknown): boolean {
	return (
		!!error && typeof error === 'object' && (error as { name?: unknown }).name === 'AbortError'
	);
}

export function WithAbort() {
	useModel('anthropic/claude-haiku-4-5');
	useSandbox(bash(() => new Bash({ fs: new InMemoryFs() })));
	useTool({
		name: 'abort-test',
		description: 'Verify timeout, manual, and pre-aborted cancellation for prompts and shells.',
		harness: true,
		async run({ harness }) {
			let timeoutAborted = false;
			try {
				await harness.prompt('Run `sleep 30` via the bash tool, then describe what happened.', {
					signal: AbortSignal.timeout(2_000),
				});
			} catch (error) {
				timeoutAborted = isAbortError(error);
			}
			const handle = harness.prompt(
				'Run `sleep 30` via the bash tool, then describe what happened.',
			);
			setTimeout(() => handle.abort('user-cancel'), 1_000);
			let manualAborted = false;
			try {
				await handle;
			} catch (error) {
				manualAborted = isAbortError(error);
			}
			let preAborted = false;
			try {
				await harness.prompt('Say hi.', { signal: AbortSignal.abort('already done') });
			} catch (error) {
				preAborted = isAbortError(error);
			}
			let shellTimeoutAborted = false;
			try {
				await harness.sandbox.exec('sleep 30', { signal: AbortSignal.timeout(1_000) });
			} catch (error) {
				shellTimeoutAborted = isAbortError(error);
			}
			const shellAbortController = new AbortController();
			const shellPromise = harness.sandbox.exec('sleep 30', {
				signal: shellAbortController.signal,
			});
			setTimeout(() => shellAbortController.abort('shell-user-cancel'), 1_000);
			let shellManualAborted = false;
			try {
				await shellPromise;
			} catch (error) {
				shellManualAborted = isAbortError(error);
			}
			return {
				timeoutAborted,
				manualAborted,
				preAborted,
				shellTimeoutAborted,
				shellManualAborted,
				allPassed:
					timeoutAborted &&
					manualAborted &&
					preAborted &&
					shellTimeoutAborted &&
					shellManualAborted,
			};
		},
	});
	return 'When asked to run a demo, call the `abort-test` tool and report its result.';
}
