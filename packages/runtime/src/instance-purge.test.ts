import { describe, expect, it } from 'vitest';
import { sqlite } from './node/agent-execution-store.ts';
import type { DispatchInput } from './runtime/dispatch-queue.ts';

const identity = { agentName: 'assistant', instanceId: 'agent-1' } as const;
const input: DispatchInput = {
	submissionId: 'submission-1',
	agent: identity.agentName,
	id: identity.instanceId,
	message: { kind: 'user', body: 'hello' },
	acceptedAt: '2026-08-01T00:00:00.000Z',
};

describe('instance physical purge', () => {
	it('refuses unsettled work, purges settled rows, and is idempotent', async () => {
		const adapter = sqlite();
		await adapter.migrate?.();
		const stores = await adapter.connect();
		const maintenance = stores.instanceMaintenance;
		if (!maintenance) throw new Error('built-in SQLite must support instance maintenance');

		await stores.submissionStore.admitDispatch(input);
		expect(await maintenance.isQuiescent(identity)).toBe(false);
		expect(await maintenance.purgeInstance(identity)).toMatchObject({
			outcome: 'busy',
			affected: 0,
			noOp: true,
		});

		await stores.submissionStore.markSubmissionCanonicalReady(input.submissionId);
		const claimed = await stores.submissionStore.claimSubmission({
			submissionId: input.submissionId,
			attemptId: 'attempt-1',
			ownerId: 'test',
			leaseExpiresAt: Date.now() + 30_000,
		});
		if (!claimed) throw new Error('expected claim');
		await stores.submissionStore.completeSubmission({
			submissionId: input.submissionId,
			attemptId: 'attempt-1',
		});

		const purged = await maintenance.purgeInstance(identity);
		expect(purged).toMatchObject({ outcome: 'purged', noOp: false });
		expect(purged.affected).toBeGreaterThan(0);
		expect(await stores.submissionStore.getSubmission(input.submissionId)).toBeNull();
		expect(await maintenance.purgeInstance(identity)).toEqual({
			outcome: 'not_found',
			affected: 0,
			noOp: true,
			deleted: {
				submissions: 0,
				submissionChunks: 0,
				conversationStreams: 0,
				conversationBatches: 0,
				conversationBatchChunks: 0,
				conversationCheckpoints: 0,
				conversationCheckpointChunks: 0,
				attachments: 0,
				attachmentChunks: 0,
			},
		});
		await adapter.close?.();
	});
});
