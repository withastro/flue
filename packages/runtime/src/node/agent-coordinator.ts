import type {
	AgentSubmission,
	AgentSubmissionStore,
	SubmissionAttemptRef,
	SubmissionDurability,
} from '../agent-execution-store.ts';
import type { CreatedAgent, DispatchReceipt } from '../types.ts';
import {
	agentSubmissionDispatchId,
	agentSubmissionProcessingPayload,
	createAgentSubmissionSessionHandler,
	createSubmissionJournalCallbacks,
	reconcileInterruptedSubmission,
	submissionDispatchRequest,
} from '../runtime/agent-submissions.ts';
import type { CreateContextFn } from '../runtime/handle-agent.ts';
import type { DispatchInput, DispatchQueue } from '../runtime/dispatch-queue.ts';

export interface NodeAgentCoordinator {
	/** Call once at startup to reconcile interrupted work from a previous process. */
	reconcileSubmissions(): Promise<void>;
	/** Admit and process a dispatch. Drains the queue after processing. */
	admitDispatch(input: DispatchInput): Promise<void>;
}

/**
 * Create a `DispatchQueue` backed by a `NodeAgentCoordinator`.
 *
 * Dispatches go through proper SQL admission, claim, journal callbacks,
 * and settlement instead of fire-and-forget inline processing. The
 * coordinator also reconciles interrupted work from a previous process
 * on startup and drains queued submissions after each dispatch.
 */
export function createNodeDispatchQueue(coordinator: NodeAgentCoordinator): DispatchQueue {
	return {
		async enqueue(input: DispatchInput): Promise<DispatchReceipt> {
			const receipt: DispatchReceipt = {
				dispatchId: input.dispatchId,
				acceptedAt: input.acceptedAt,
			};
			// Admission, claim, processing, and queue drain are handled by the
			// coordinator. Errors during processing are logged and swallowed by
			// the coordinator — the dispatch is still accepted.
			await coordinator.admitDispatch(input);
			return receipt;
		},
	};
}

export function createNodeAgentCoordinator(options: {
	submissions: AgentSubmissionStore;
	agents: Record<string, CreatedAgent>;
	createContext: CreateContextFn;
}): NodeAgentCoordinator {
	const { submissions, agents, createContext } = options;

	function makeReconciliationContext(instanceId: string) {
		return (payload: unknown, dispatchId: string | undefined) =>
			createContext(instanceId, undefined, payload, submissionDispatchRequest(), undefined, dispatchId);
	}

	async function processSubmission(submission: AgentSubmission): Promise<void> {
		const { input } = submission;
		if (!submission.attemptId) return;
		const attempt: SubmissionAttemptRef = {
			submissionId: submission.submissionId,
			attemptId: submission.attemptId,
		};
		const persisted = await submissions.getSubmission(submission.submissionId);
		if (persisted?.status !== 'running' || persisted.attemptId !== attempt.attemptId) return;

		const agentName = input.agent;
		const agent = agents[agentName];
		if (!agent) throw new Error(`[flue] dispatch target agent "${agentName}" has no created agent.`);

		const ctx = createContext(
			input.id,
			undefined,
			agentSubmissionProcessingPayload(input),
			submissionDispatchRequest(),
			undefined,
			agentSubmissionDispatchId(input),
		);

		try {
			await createAgentSubmissionSessionHandler(agent, input, (session) =>
				session.processSubmissionInput(input, {
					onInputApplied: async (durability: SubmissionDurability) => {
						if (!(await submissions.markSubmissionInputApplied(attempt, durability))) {
							throw new Error('[flue] Agent submission attempt lost ownership before input application.');
						}
					},
					startedAt: submission.startedAt,
					timeoutAt:
						submission.inputAppliedAt !== undefined && submission.timeoutAt > 0
							? submission.timeoutAt
							: undefined,
					submissionAttempt: attempt,
					journal: createSubmissionJournalCallbacks(submissions, submission, attempt),
				}),
			)(ctx);
			await submissions.completeSubmission(attempt);
		} catch (error) {
			await submissions.failSubmission(attempt, error);
			throw error;
		}
	}

	async function drainRunnableSubmissions(): Promise<void> {
		// Re-query after each processed submission because settling one session
		// head may make the next same-session submission runnable.
		let runnable: AgentSubmission[];
		while ((runnable = await submissions.listRunnableSubmissions()).length > 0) {
			let progressed = false;
			for (const submission of runnable) {
				const claimed = await submissions.claimSubmission({
					submissionId: submission.submissionId,
					attemptId: crypto.randomUUID(),
				});
				if (!claimed) continue;
				progressed = true;
				try {
					await processSubmission(claimed);
				} catch (error) {
					console.error(
						'[flue:submission-reconciliation]',
						{
							submissionId: submission.submissionId,
							operation: 'drain_queued',
							outcome: 'failed',
						},
						error,
					);
				}
			}
			// If nothing was claimed in a full pass, stop to avoid infinite loops.
			if (!progressed) break;
		}
	}

	return {
		async reconcileSubmissions() {
			if (!(await submissions.hasUnsettledSubmissions())) return;

			// Reconcile running submissions (orphaned from previous process).
			for (const submission of await submissions.listRunningSubmissions()) {
				const agentName = submission.input.agent;
				const agent = agents[agentName];
				if (!agent) {
					console.error(
						'[flue:submission-reconciliation]',
						{
							submissionId: submission.submissionId,
							operation: 'reconcile_submission',
							outcome: 'agent_unavailable',
						},
					);
					continue;
				}
				try {
					const { replacement } = await reconcileInterruptedSubmission(
						submissions,
						submission,
						agent,
						makeReconciliationContext(submission.input.id),
					);
					if (replacement) {
						try {
							await processSubmission(replacement);
						} catch (error) {
							console.error(
								'[flue:submission-reconciliation]',
								{
									submissionId: replacement.submissionId,
									operation: 'restart_submission',
									outcome: 'failed',
								},
								error,
							);
						}
					}
				} catch (error) {
					console.error(
						'[flue:submission-reconciliation]',
						{
							submissionId: submission.submissionId,
							operation: 'reconcile_submission',
							outcome: 'failed',
						},
						error,
					);
				}
			}

			// Drain any queued submissions.
			await drainRunnableSubmissions();
		},

		async admitDispatch(input) {
			const agent = agents[input.agent];
			if (!agent) {
				throw new Error(`[flue] dispatch target agent "${input.agent}" has no created agent.`);
			}

			const admission = await submissions.admitDispatch(input);
			if (admission.kind !== 'submission') return;

			const submission = admission.submission;
			const claimed = await submissions.claimSubmission({
				submissionId: submission.submissionId,
				attemptId: crypto.randomUUID(),
			});
			if (!claimed) return;

			try {
				await processSubmission(claimed);
			} catch (error) {
				console.error(
					'[flue:submission-processing]',
					{
						submissionId: submission.submissionId,
						operation: 'process',
						outcome: 'failed',
					},
					error,
				);
			} finally {
				// Drain remaining queued work after each dispatch.
				await drainRunnableSubmissions().catch((error) => {
					console.error(
						'[flue:submission-reconciliation]',
						{ operation: 'drain_after_dispatch', outcome: 'failed' },
						error,
					);
				});
			}
		},
	};
}
