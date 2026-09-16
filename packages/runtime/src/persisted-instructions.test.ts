import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxProvider, fauxText } from '@earendil-works/pi-ai';
import { expect, it, onTestFinished, vi } from 'vitest';
import { fnv1a64 } from './fnv.ts';
import { init, useModel } from './index.ts';
import { sqlite, start } from './node/index.ts';
import * as resources from './resources.ts';
import { digestInstructions } from './resources.ts';
import { agentStreamPath } from './runtime/stream-offsets.ts';

it('preserves instruction snapshots and change signals across a persisted runtime restart', async () => {
	let instructions: string | undefined = 'first';
	function InstructionAgent() {
		useModel('faux/model', { compaction: false });
		return instructions;
	}
	const directory = await mkdtemp(join(tmpdir(), 'flue-instructions-'));
	const database = sqlite(join(directory, 'conversation.db'));
	const faux = fauxProvider({ models: [{ id: 'model' }] });
	faux.setResponses(
		Array.from({ length: 6 }, () => fauxAssistantMessage([fauxText('OK')], { stopReason: 'stop' })),
	);
	const config = { agents: [InstructionAgent], db: database, providers: [faux.provider], env: {} };
	let runtime = await start(config);
	onTestFinished(async () => {
		await runtime.stop();
		await rm(directory, { recursive: true, force: true });
	});
	const id = 'instruction-restart';
	let agent = init(InstructionAgent, { id });
	for (const next of ['first', 'first', 'changed']) {
		instructions = next;
		await expect(agent.read(await agent.dispatch('Reply.'))).resolves.toMatchObject({ text: 'OK' });
	}

	await runtime.stop();
	runtime = await start(config);
	agent = init(InstructionAgent, { id });
	for (const next of ['', undefined, 'last']) {
		instructions = next;
		await expect(agent.read(await agent.dispatch('Reply.'))).resolves.toMatchObject({ text: 'OK' });
	}

	const { conversationStreamStore } = await database.connect();
	const { batches } = await conversationStreamStore.read(agentStreamPath('InstructionAgent', id), {
		limit: 1000,
	});
	const records = batches.flatMap((batch) => batch.records);
	const snapshots = records.filter((record) => record.type === 'resource_snapshot');
	expect(snapshots.map((record) => record.snapshot.instructionsDigest)).toEqual(
		['first', 'changed', '', 'last'].map(digestInstructions),
	);
	expect(snapshots.map((record) => record.baseline)).toEqual([true, false, false, false]);
	expect(
		records.filter((record) => record.type === 'signal' && record.signalType === 'instructions'),
	).toHaveLength(3);
	for (const record of snapshots) {
		expect(Object.getOwnPropertyDescriptor(record.snapshot, 'instructionsDigest')).toMatchObject({
			value: expect.any(String),
			enumerable: true,
			writable: true,
		});
	}
});

it('announces the persisted FNV-to-SHA transition once without adding model calls', async () => {
	let instructions = 'first';
	function UpgradeAgent() {
		useModel('faux/model', { compaction: false });
		return instructions;
	}
	const directory = await mkdtemp(join(tmpdir(), 'flue-hash-upgrade-'));
	const database = sqlite(join(directory, 'conversation.db'));
	const faux = fauxProvider({ models: [{ id: 'model' }] });
	const modelContexts: string[] = [];
	faux.setResponses(
		Array.from({ length: 5 }, () => (context) => {
			modelContexts.push(JSON.stringify(context.messages));
			return fauxAssistantMessage([fauxText('OK')], { stopReason: 'stop' });
		}),
	);
	const config = { agents: [UpgradeAgent], db: database, providers: [faux.provider], env: {} };
	// Persist the old algorithm's real snapshots, then restore the production
	// digest implementation before reopening the same SQLite-backed instance.
	const oldDigest = vi
		.spyOn(resources, 'digestInstructions')
		.mockImplementation((text) => fnv1a64(text ?? ''));
	let runtime = await start(config);
	onTestFinished(async () => {
		await runtime.stop();
		oldDigest.mockRestore();
		await rm(directory, { recursive: true, force: true });
	});
	const id = 'hash-upgrade';
	let agent = init(UpgradeAgent, { id });
	const callsAfterDispatch = [];
	for (let i = 0; i < 2; i++) {
		await expect(agent.read(await agent.dispatch('Reply.'))).resolves.toMatchObject({ text: 'OK' });
		callsAfterDispatch.push(faux.state.callCount);
	}
	await runtime.stop();
	oldDigest.mockRestore();
	runtime = await start(config);
	agent = init(UpgradeAgent, { id });
	for (const next of ['first', 'first', 'changed']) {
		instructions = next;
		await expect(agent.read(await agent.dispatch('Reply.'))).resolves.toMatchObject({ text: 'OK' });
		callsAfterDispatch.push(faux.state.callCount);
	}
	const { conversationStreamStore } = await database.connect();
	const { batches } = await conversationStreamStore.read(agentStreamPath('UpgradeAgent', id), {
		limit: 1000,
	});
	const records = batches.flatMap((batch) => batch.records);
	const snapshots = records.filter((record) => record.type === 'resource_snapshot');
	const signals = records
		.filter((record) => record.type === 'signal')
		.filter((record) => record.signalType === 'instructions');
	expect(snapshots.map((record) => record.snapshot.instructionsDigest)).toEqual([
		fnv1a64('first'),
		digestInstructions('first'),
		digestInstructions('changed'),
	]);
	expect(signals.map((record) => record.content)).toEqual([
		'System instructions updated.',
		'System instructions updated.',
	]);
	expect(modelContexts.map((context) => context.includes('System instructions updated.'))).toEqual([
		false,
		false,
		true,
		true,
		true,
	]);
	expect(callsAfterDispatch).toEqual([1, 2, 3, 4, 5]);
});
