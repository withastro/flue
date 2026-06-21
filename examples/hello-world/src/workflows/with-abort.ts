import { defineAgent, defineWorkflow, type WorkflowRouteHandler } from '@flue/runtime';

export const route: WorkflowRouteHandler = async (_c, next) => next();
const agent = defineAgent(() => ({ model: 'anthropic/claude-haiku-4-5' }));

export default defineWorkflow({
	agent,
	async run({ harness }) {
		const session = await harness.session();
		let timeoutAborted = false;
		try {
			await session.prompt('Run `sleep 30` via the bash tool, then describe what happened.', {
				signal: AbortSignal.timeout(2_000),
			});
		} catch (error) {
			timeoutAborted = isAbortError(error);
		}
		const handle = session.prompt('Run `sleep 30` via the bash tool, then describe what happened.');
		setTimeout(() => handle.abort('user-cancel'), 1_000);
		let manualAborted = false;
		try {
			await handle;
		} catch (error) {
			manualAborted = isAbortError(error);
		}
		let preAborted = false;
		try {
			await session.prompt('Say hi.', { signal: AbortSignal.abort('already done') });
		} catch (error) {
			preAborted = isAbortError(error);
		}
		let shellTimeoutAborted = false;
		try {
			await session.shell('sleep 30', { signal: AbortSignal.timeout(1_000) });
		} catch (error) {
			shellTimeoutAborted = isAbortError(error);
		}
		const shellHandle = session.shell('sleep 30');
		setTimeout(() => shellHandle.abort('shell-user-cancel'), 1_000);
		let shellManualAborted = false;
		try {
			await shellHandle;
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
				timeoutAborted && manualAborted && preAborted && shellTimeoutAborted && shellManualAborted,
		};
	},
});

function isAbortError(error: unknown): boolean {
	return (
		!!error && typeof error === 'object' && (error as { name?: unknown }).name === 'AbortError'
	);
}
