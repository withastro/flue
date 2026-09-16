import { SUBMISSION_HARNESS_NAME, SUBMISSION_SESSION_NAME } from './adapter-helpers.ts';
import type {
	AgentInstanceMaintenance,
	AgentInstancePurgeResult,
	AgentInstanceStorageIdentity,
} from './agent-execution-store.ts';
import { agentStreamPath } from './runtime/stream-offsets.ts';
import { createSessionStorageKey } from './session-identity.ts';
import type { SqlStorage } from './sql-storage.ts';

/** Built-in SQLite/DO implementation of the target-neutral maintenance contract. */
export function createSqlInstanceMaintenance(
	sql: SqlStorage,
	runTransaction: <T>(closure: () => T) => T,
): AgentInstanceMaintenance {
	const keys = (identity: AgentInstanceStorageIdentity) => ({
		sessionKey: createSessionStorageKey(
			identity.agentName,
			identity.instanceId,
			SUBMISSION_HARNESS_NAME,
			SUBMISSION_SESSION_NAME,
		),
		path: agentStreamPath(identity.agentName, identity.instanceId),
	});
	const count = (query: string, value: string): number =>
		Number(sql.exec(query, value).toArray()[0]?.count ?? 0);
	const emptyDeleted = () => ({
		submissions: 0,
		submissionChunks: 0,
		conversationStreams: 0,
		conversationBatches: 0,
		conversationBatchChunks: 0,
		conversationCheckpoints: 0,
		conversationCheckpointChunks: 0,
		attachments: 0,
		attachmentChunks: 0,
	});

	return {
		async isQuiescent(identity) {
			const { sessionKey } = keys(identity);
			return (
				count(
					`SELECT COUNT(*) AS count FROM flue_agent_submissions
					 WHERE session_key = ? AND status IN ('queued', 'running', 'terminalizing', 'joining', 'joined')`,
					sessionKey,
				) === 0
			);
		},
		async purgeInstance(identity): Promise<AgentInstancePurgeResult> {
			return runTransaction(() => {
				const { sessionKey, path } = keys(identity);
				const unsettled = count(
					`SELECT COUNT(*) AS count FROM flue_agent_submissions
					 WHERE session_key = ? AND status IN ('queued', 'running', 'terminalizing', 'joining', 'joined')`,
					sessionKey,
				);
				if (unsettled > 0) {
					return { outcome: 'busy', affected: 0, noOp: true, deleted: emptyDeleted() };
				}
				const deleted = {
					submissions: count(
						'SELECT COUNT(*) AS count FROM flue_agent_submissions WHERE session_key = ?',
						sessionKey,
					),
					submissionChunks: count(
						`SELECT COUNT(*) AS count FROM flue_submission_chunks WHERE submission_id IN
						 (SELECT submission_id FROM flue_agent_submissions WHERE session_key = ?)`,
						sessionKey,
					),
					conversationStreams: count(
						'SELECT COUNT(*) AS count FROM flue_conversation_streams WHERE path = ?',
						path,
					),
					conversationBatches: count(
						'SELECT COUNT(*) AS count FROM flue_conversation_stream_batches WHERE path = ?',
						path,
					),
					conversationBatchChunks: count(
						'SELECT COUNT(*) AS count FROM flue_conversation_stream_batch_chunks WHERE path = ?',
						path,
					),
					conversationCheckpoints: count(
						'SELECT COUNT(*) AS count FROM flue_conversation_fold_checkpoints WHERE path = ?',
						path,
					),
					conversationCheckpointChunks: count(
						'SELECT COUNT(*) AS count FROM flue_conversation_fold_checkpoint_chunks WHERE path = ?',
						path,
					),
					attachments: count(
						'SELECT COUNT(*) AS count FROM flue_attachments WHERE stream_path = ?',
						path,
					),
					attachmentChunks: count(
						'SELECT COUNT(*) AS count FROM flue_attachment_chunks WHERE stream_path = ?',
						path,
					),
				};
				const affected = Object.values(deleted).reduce((sum, value) => sum + value, 0);
				if (affected === 0) {
					return { outcome: 'not_found', affected: 0, noOp: true, deleted };
				}

				// Delete children before parents so this works with foreign-key checks on or off.
				sql.exec(
					`DELETE FROM flue_submission_chunks WHERE submission_id IN
					 (SELECT submission_id FROM flue_agent_submissions WHERE session_key = ?)`,
					sessionKey,
				);
				sql.exec('DELETE FROM flue_agent_submissions WHERE session_key = ?', sessionKey);
				sql.exec('DELETE FROM flue_attachment_chunks WHERE stream_path = ?', path);
				sql.exec('DELETE FROM flue_attachments WHERE stream_path = ?', path);
				sql.exec('DELETE FROM flue_conversation_stream_batch_chunks WHERE path = ?', path);
				sql.exec('DELETE FROM flue_conversation_stream_batches WHERE path = ?', path);
				sql.exec('DELETE FROM flue_conversation_fold_checkpoint_chunks WHERE path = ?', path);
				sql.exec('DELETE FROM flue_conversation_fold_checkpoints WHERE path = ?', path);
				sql.exec('DELETE FROM flue_conversation_streams WHERE path = ?', path);
				return { outcome: 'purged', affected, noOp: false, deleted };
			});
		},
	};
}
