import type {
	AgentSubmission,
	AgentSubmissionStore,
	SubmissionAttemptRef,
	SubmissionDurability,
} from '../agent-execution-store.ts';
import type { AttachedAgentEvent, CreatedAgent, DirectAgentPayload, DispatchReceipt } from '../types.ts';
import {
	agentSubmissionDispatchId,
	type AgentSubmissionInput,
	agentSubmissionProcessingPayload,
	type AttachedAgentSubmissionAdmission,
	createAgentSubmissionObserverRegistry,
	createAgentSubmissionSessionHandler,
	createDirectAgentSubmissionInput,
	createSubmissionEventCallback,
	createSubmissionJournalCallbacks,
	reconcileInterruptedSubmission,
	submissionSyntheticRequest,
} from '../runtime/agent-submissions.ts';
import { type CreateContextFn, assertAgentDispatchAdmissionInput } from '../runtime/handle-agent.ts';
import type { DispatchInput, DispatchQueue } from '../runtime/dispatch-queue.ts';

export interface NodeAgentCoordinator {
	/** Call once at startup to reconcile interrupted work from a previous process. */
	reconcileSubmissions(): Promise<void>;
	/** Admit and process a dispatch. Drains the queue after processing. */
	admitDispatch(input: DispatchInput): Promise<void>;
	/**
	 * Create a durable admission hook for a specific agent instance. The returned
	 * function accepts a direct prompt payload, persists it as a durable submission,
	 * and resolves when the submission settles. Pass the result as the
	 * `admitAttachedSubmission` option to `handleAgentRequest()` or the WebSocket
	 * transport so that direct prompts enter the same durable lifecycle as dispatches.
	 */
	createAdmission(agentName: string, instanceId: string): AttachedAgentSubmissionAdmission;
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
	const observers = createAgentSubmissionObserverRegistry();

	// Serialization guard: only one driveSubmissions() pass runs at a time.
	// When a drive is already in progress, a successor is requested so that
	// newly admitted or settled work is picked up without recursive reentry.
	let driving = false;
	let driveAgainRequested = false;

	function makeReconciliationContext(input: AgentSubmissionInput) {
		return (payload: unknown, dispatchId: string | undefined) =>
			createContext(input.id, undefined, payload, submissionSyntheticRequest(input), undefined, dispatchId);
	}

	async function processSubmission(submission: AgentSubmission): Promise<void> {
		const { input } = submission;
		if (!submission.attemptId) return;
		if (input.kind === 'dispatch') assertAgentDispatchAdmissionInput(input);
		const attempt: SubmissionAttemptRef = {
			submissionId: submission.submissionId,
			attemptId: submission.attemptId,
		};
		const persisted = await submissions.getSubmission(submission.submissionId);
		if (persisted?.status !== 'running' || persisted.attemptId !== attempt.attemptId) return;

		const agentName = input.agent;
		const agent = agents[agentName];
		if (!agent) throw new Error(`[flue] submission target agent "${agentName}" has no created agent.`);

		const ctx = createContext(
			input.id,
			undefined,
			agentSubmissionProcessingPayload(input),
			submissionSyntheticRequest(input),
			undefined,
			agentSubmissionDispatchId(input),
		);

		// Forward events to attached observers for direct submissions so that
		// SSE and WebSocket callers see streaming events while the durable
		// submission runs.
		if (submission.kind === 'direct') {
			ctx.setEventCallback(
				createSubmissionEventCallback(submission.submissionId, input.id, (sid, event) =>
					observers.publish(sid, event),
				),
			);
		}

		try {
			const result = await createAgentSubmissionSessionHandler(agent, input, (session) =>
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
			const completed = await submissions.completeSubmission(attempt);
			if (completed && submission.kind === 'direct') observers.complete(submission.submissionId, result);
		} catch (error) {
			const failed = await submissions.failSubmission(attempt, error);
			if (failed && submission.kind === 'direct') observers.fail(submission.submissionId, error);
			throw error;
		} finally {
			if (submission.kind === 'direct') ctx.setEventCallback(undefined);
		}
	}

	/**
	 * Unified submission driver. Reconciles interrupted submissions, then
	 * claims and processes runnable work. Called after every admission,
	 * after each submission settles, and on startup. Serialized so that
	 * only one pass runs at a time; concurrent callers request a successor
	 * pass instead of running in parallel.
	 */
	async function driveSubmissions(): Promise<void> {
		if (driving) {
			driveAgainRequested = true;
			return;
		}
		driving = true;
		try {
			do {
				driveAgainRequested = false;

				// Reconcile running submissions (orphaned from previous process
				// or failed in the current one).
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
						const { replacement, failedError } = await reconcileInterruptedSubmission(
							submissions,
							submission,
							agent,
							makeReconciliationContext(submission.input),
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
						} else if (failedError && submission.kind === 'direct') {
							observers.fail(submission.submissionId, failedError);
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

				// Drain runnable (queued, session-head) submissions.
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
					if (!progressed) break;
				}
			} while (driveAgainRequested);
		} finally {
			driving = false;
		}
	}

	return {
		async reconcileSubmissions() {
			if (!(await submissions.hasUnsettledSubmissions())) return;
			await driveSubmissions();
		},

		async admitDispatch(input) {
			const agent = agents[input.agent];
			if (!agent) {
				throw new Error(`[flue] dispatch target agent "${input.agent}" has no created agent.`);
			}

			const admission = await submissions.admitDispatch(input);
			if (admission.kind !== 'submission') return;

			await driveSubmissions();
		},

		createAdmission(agentName: string, instanceId: string): AttachedAgentSubmissionAdmission {
			return async (
				payload: DirectAgentPayload,
				onEvent?: (event: AttachedAgentEvent) => Promise<void> | void,
			): Promise<unknown> => {
				const agent = agents[agentName];
				if (!agent) {
					throw new Error(`[flue] direct prompt target agent "${agentName}" has no created agent.`);
				}

				const input = createDirectAgentSubmissionInput({ agent: agentName, id: instanceId, payload });

				const attachment = observers.attach(input.submissionId, { onEvent });
				try {
					await submissions.admitDirect(input);
					// Drive without awaiting — the observer's completion promise
					// resolves when processSubmission settles or fails this submission.
					void driveSubmissions().catch((error) => {
						console.error(
							'[flue:submission-processing]',
							{ submissionId: input.submissionId, operation: 'drive_after_direct_admission', outcome: 'failed' },
							error,
						);
						// Fail the observer so the caller doesn't hang forever.
						// No-op if the observer was already settled by processSubmission.
						observers.fail(input.submissionId, error);
					});
					return await attachment.completion;
				} finally {
					attachment.detach();
				}
			};
		},
	};
}
