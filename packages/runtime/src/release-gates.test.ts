import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fauxAssistantMessage, fauxProvider, fauxText } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import {
	init,
	observeDurableMutations,
	purgeAgentInstance,
	useDeliveryContext,
	useModel,
} from './index.ts';
import { sqlite, start } from './node/index.ts';

const final = (text: string) => fauxAssistantMessage([fauxText(text)], { stopReason: 'stop' });

describe('Agent v2 public release gates', () => {
	it('keeps changing delivery context durable across restart and outside provider input', async () => {
		const directory = await mkdtemp(path.join(tmpdir(), 'flue-delivery-context-'));
		const dbPath = path.join(directory, 'runtime.db');
		const seen: unknown[] = [];
		const providerInputs: unknown[] = [];
		const faux = fauxProvider({ models: [{ id: 'model' }] });
		faux.setResponses([
			(context) => {
				providerInputs.push(context);
				return final('first');
			},
			(context) => {
				providerInputs.push(context);
				return final('second');
			},
		]);

		function PrivateAgent() {
			useModel('faux/model');
			seen.push(useDeliveryContext());
			return 'Reply without private context.';
		}

		let runtime = await start({ agents: [PrivateAgent], db: sqlite(dbPath), providers: [faux.provider] });
		try {
			const handle = init(PrivateAgent, { id: 'durable-private' });
			await handle.read(
				await handle.dispatch({
					message: 'first',
					deliveryContext: { authority: 'secret-a' },
					idempotencyKey: 'delivery-a',
				}),
			);
		} finally {
			await runtime.stop();
		}

		runtime = await start({ agents: [PrivateAgent], db: sqlite(dbPath), providers: [faux.provider] });
		try {
			const handle = init(PrivateAgent, { id: 'durable-private' });
			await handle.read(
				await handle.dispatch({
					message: 'second',
					deliveryContext: { authority: 'secret-b' },
					idempotencyKey: 'delivery-b',
					deliveryMode: 'fifo',
				}),
			);
		} finally {
			await runtime.stop();
			await rm(directory, { recursive: true, force: true });
		}

		expect(seen).toEqual([
			{ authority: 'secret-a' },
			{ authority: 'secret-a' },
			{ authority: 'secret-b' },
			{ authority: 'secret-b' },
		]);
		const providerJson = JSON.stringify(providerInputs);
		expect(providerJson).not.toContain('secret-a');
		expect(providerJson).not.toContain('secret-b');
	});

	it('keeps fifo deliveries distinct while the instance is busy', async () => {
		let startedResolve: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			startedResolve = resolve;
		});
		let releaseResolve: (() => void) | undefined;
		const release = new Promise<void>((resolve) => {
			releaseResolve = resolve;
		});
		const faux = fauxProvider({ models: [{ id: 'model' }] });
		faux.setResponses([
			async () => {
				startedResolve?.();
				await release;
				return final('first-only');
			},
			final('second-only'),
		]);
		function FifoAgent() {
			useModel('faux/model');
			return 'Reply to this delivery only.';
		}
		const runtime = await start({ agents: [FifoAgent], providers: [faux.provider] });
		try {
			const handle = init(FifoAgent, { id: 'fifo-instance' });
			const first = await handle.dispatch('first');
			await started;
			const second = await handle.dispatch({ message: 'second', deliveryMode: 'fifo' });
			releaseResolve?.();
			const [firstReply, secondReply] = await Promise.all([handle.read(first), handle.read(second)]);
			expect(firstReply.text).toBe('first-only');
			expect(secondReply.text).toBe('second-only');
			expect(first.submissionId).not.toBe(second.submissionId);
		} finally {
			await runtime.stop();
		}
	});

	it('purges through the public API, clears caches, recreates with a new uid, and observes bounded outcomes', async () => {
		const faux = fauxProvider({ models: [{ id: 'model' }] });
		faux.setResponses([final('first'), final('second')]);
		function PurgeAgent() {
			useModel('faux/model');
			return 'Reply.';
		}
		const mutations: unknown[] = [];
		const stopObserving = observeDurableMutations((mutation) => {
			mutations.push(mutation);
		});
		const runtime = await start({ agents: [PurgeAgent], db: sqlite(), providers: [faux.provider] });
		try {
			const first = init(PurgeAgent, { id: 'raw-instance-id' });
			const firstReceipt = await first.dispatch({
				message: 'first',
				idempotencyKey: 'raw-submission-key',
			});
			await first.read(firstReceipt);
			const replay = await first.dispatch({
				message: 'first',
				idempotencyKey: 'raw-submission-key',
			});
			expect(replay).toMatchObject({ submissionId: firstReceipt.submissionId, deduplicated: true });

			const purged = await purgeAgentInstance(PurgeAgent, 'raw-instance-id');
			expect(purged).toMatchObject({ outcome: 'purged', noOp: false });
			const second = init(PurgeAgent, { id: 'raw-instance-id' });
			const secondReceipt = await second.dispatch('second');
			expect(secondReceipt.uid).not.toBe(firstReceipt.uid);
			await second.read(secondReceipt);
			expect(await purgeAgentInstance(PurgeAgent, 'absent-instance')).toMatchObject({
				outcome: 'not_found',
				affected: 0,
				noOp: true,
			});
		} finally {
			stopObserving();
			await runtime.stop();
		}

		const serialized = JSON.stringify(mutations);
		expect(serialized).not.toContain('raw-instance-id');
		expect(serialized).not.toContain('raw-submission-key');
		expect(mutations).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ operation: 'admit', affected: 1, noOp: false }),
				expect.objectContaining({ operation: 'admit', affected: 0, noOp: true }),
				expect.objectContaining({ operation: 'purge', noOp: false }),
				expect.objectContaining({ operation: 'purge', affected: 0, noOp: true }),
			]),
		);
		for (const mutation of mutations as Array<Record<string, unknown>>) {
			expect(mutation.identityHash).toMatch(/^[a-f0-9]{64}$/);
			expect(Object.keys(mutation).sort()).toEqual(
				['affected', 'identityHash', 'noOp', 'operation', 'scope'].sort(),
			);
		}
	});
});
