/**
 * Divergence repair for the settlement cache: re-derive terminal submission
 * rows from their conversation streams' `submission_settled` records.
 *
 * The canonical stream is the single durable truth for a submission's
 * outcome; the row's terminal status is a projection of it (see the cache
 * contract on {@link AgentSubmissionStore}). Under normal operation the two
 * cannot disagree — the settle record is only appendable under an exact
 * reserved obligation, and a crash mid-settlement leaves a `terminalizing`
 * row that both coordinators already finish on wake. What CAN diverge is the
 * ledger itself: an execution store restored from an older backup (or
 * otherwise rebuilt) may hold `running` rows for submissions whose streams
 * already carry the settle record. This routine converges those rows by
 * driving them through the normal reservation machinery — no bespoke writes,
 * so first-terminal-wins and joined-delivery fan-out apply exactly as in
 * live settlement.
 *
 * Read-only toward the streams; idempotent; safe to run at any time an
 * operator suspects divergence.
 */

import type { AgentSubmissionStore } from '../agent-execution-store.ts';
import type { ConversationRecord, SubmissionSettledRecord } from '../conversation-records.ts';
import type { ConversationStreamStore } from './conversation-stream-store.ts';
import { agentStreamPath } from './stream-offsets.ts';

export async function rebuildSettledSubmissionRows(options: {
	submissions: AgentSubmissionStore;
	conversationStreamStore: ConversationStreamStore;
}): Promise<{ repaired: string[] }> {
	const { submissions, conversationStreamStore } = options;
	const repaired: string[] = [];
	for (const submission of await submissions.listRunningSubmissions()) {
		if (!submission.attemptId) continue;
		const path = agentStreamPath(submission.input.agent, submission.input.id);
		let records: ConversationRecord[];
		try {
			records = (await conversationStreamStore.read(path)).batches.flatMap(
				(batch) => batch.records,
			);
		} catch {
			// No stream (or unreadable) — nothing durable to derive from.
			continue;
		}
		const settled = records.find(
			(record): record is SubmissionSettledRecord =>
				record.type === 'submission_settled' && record.submissionId === submission.submissionId,
		);
		if (!settled) continue;
		const attempt = {
			submissionId: submission.submissionId,
			attemptId: submission.attemptId,
		};
		// The stream's record IS the reserved obligation: exact-retry idempotency
		// makes this safe against concurrent live settlement, and the record
		// already being durable means finalize needs no append.
		const obligation = await submissions.reserveSubmissionSettlement(attempt, {
			recordId: settled.id,
			record: settled,
		});
		if (!obligation) continue;
		if (await submissions.finalizeSubmissionSettlement(attempt, settled.id)) {
			repaired.push(submission.submissionId);
		}
	}
	return { repaired };
}
