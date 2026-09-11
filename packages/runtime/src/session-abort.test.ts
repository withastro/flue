import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { expect, it } from 'vitest';
import type { PersistenceAdapter } from './agent-execution-store.ts';
import type { ConversationRecord } from './conversation-records.ts';
import {
	init,
	instrument,
	useAgentStart,
	useModel,
	usePersistentState,
	useSandbox,
} from './index.ts';
import { local, sqlite, start } from './node/index.ts';
import type { ConversationStreamStore } from './runtime/conversation-stream-store.ts';
import type { FlueObservation } from './types.ts';

function recordDatabase(
	beforeAppend?: (records: readonly ConversationRecord[]) => void | Promise<void>,
) {
	const database = sqlite();
	const records: ConversationRecord[] = [];
	const joins: Array<{ submissionId: string; afterRepair: boolean }> = [];
	const adapter: PersistenceAdapter = {
		migrate: () => database.migrate?.(),
		close: () => database.close?.(),
		async connect() {
			const stores = await database.connect();
			const stream = stores.conversationStreamStore;
			const recording: ConversationStreamStore = {
				createStream: (...args) => stream.createStream(...args),
				acquireProducer: (...args) => stream.acquireProducer(...args),
				async append(input) {
					await beforeAppend?.(input.records);
					const result = await stream.append(input);
					records.push(...structuredClone(input.records));
					return result;
				},
				read: (...args) => stream.read(...args),
				getMeta: (...args) => stream.getMeta(...args),
				subscribe: (...args) => stream.subscribe(...args),
				...(stream.putFoldCheckpoint
					? { putFoldCheckpoint: stream.putFoldCheckpoint.bind(stream) }
					: {}),
				...(stream.getFoldCheckpoint
					? { getFoldCheckpoint: stream.getFoldCheckpoint.bind(stream) }
					: {}),
			};
			return {
				...stores,
				conversationStreamStore: recording,
				submissionStore: new Proxy(stores.submissionStore, {
					get(target, key) {
						if (key === 'claimJoinableSubmissions')
							return (...args: Parameters<typeof target.claimJoinableSubmissions>) => {
								joins.push({
									submissionId: args[0].submissionId,
									afterRepair: records.some((record) =>
										record.id.startsWith('record_tool_repair_commit_'),
									),
								});
								return target.claimJoinableSubmissions(...args);
							};
						const member = Reflect.get(target, key, target);
						return typeof member === 'function' ? member.bind(target) : member;
					},
				}),
			};
		},
	};
	return { adapter, records, joins };
}

function untilAbort(signal: AbortSignal | undefined): Promise<never> {
	if (!signal) throw new Error('The test requires an abort signal.');
	return new Promise((_resolve, reject) => {
		if (signal.aborted) reject(signal.reason);
		else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
	});
}

async function createBatch(
	options: {
		complete?: boolean;
		oneTool?: boolean;
		beforeStart?: boolean;
		beforeAppend?: (records: readonly ConversationRecord[]) => void | Promise<void>;
	} = {},
) {
	const firstStarted = Promise.withResolvers<void>();
	const counts = { first: 0, second: 0 };
	const hookStarted = Promise.withResolvers<void>();
	const publications: Array<{ event: FlueObservation; records: ConversationRecord[] }> = [];
	const renderedState: string[] = [];
	function AbortBatch() {
		useModel('faux/m');
		const [phase, setPhase] = usePersistentState('phase', 'initial');
		renderedState.push(phase);
		useAgentStart(async ({ signal }) => {
			hookStarted.resolve();
			if (options.beforeStart) await untilAbort(signal);
			setPhase('stored');
		});
		useSandbox({
			...local(),
			tools: () => [
				{
					name: 'first',
					label: 'First',
					description: 'Wait for an abort.',
					parameters: { type: 'object', properties: {} },
					executionMode: 'sequential',
					async execute(_id, _args, signal) {
						counts.first += 1;
						setPhase('pending');
						firstStarted.resolve();
						if (!options.complete) await untilAbort(signal);
						return { details: {}, content: [{ type: 'text', text: 'First result.' }] };
					},
				},
				{
					name: 'second',
					label: 'Second',
					description: 'Count an execution.',
					parameters: { type: 'object', properties: {} },
					async execute() {
						counts.second += 1;
						return { details: {}, content: [{ type: 'text', text: 'Second result.' }] };
					},
				},
			],
		});
		return 'Run the supplied test response.';
	}
	const faux = fauxProvider({ models: [{ id: 'm' }] });
	faux.setResponses([
		fauxAssistantMessage(
			[
				fauxToolCall('first', {}, { id: 'call_first' }),
				...(options.oneTool ? [] : [fauxToolCall('second', {}, { id: 'call_second' })]),
			],
			{ stopReason: 'toolUse' },
		),
		fauxAssistantMessage([fauxText('Next submission succeeds.')], { stopReason: 'stop' }),
	]);
	const database = recordDatabase(options.beforeAppend);
	const events: FlueObservation[] = [];
	const errors: unknown[] = [];
	const disposeInstrumentation = instrument({
		dispose() {},
		observe: (event) => {
			events.push(event);
			if (event.type === 'tool')
				publications.push({ event, records: structuredClone(database.records) });
		},
		async interceptor(_operation, _context, next) {
			try {
				return await next();
			} catch (error) {
				errors.push(error);
				throw error;
			}
		},
	});
	const runtime = await start({
		agents: [AbortBatch],
		db: database.adapter,
		providers: [faux.provider],
		env: {},
	}).catch(async (error: unknown) => {
		await disposeInstrumentation();
		throw error;
	});
	const agent = init(AbortBatch, { id: 'abort-batch' });
	return {
		agent,
		firstStarted,
		hookStarted,
		counts,
		errors,
		events,
		records: database.records,
		joins: database.joins,
		renderedState,
		publications,
		faux,
		async [Symbol.asyncDispose]() {
			await agent.abort();
			await runtime.stop();
			await disposeInstrumentation();
		},
	};
}

it('commits an aborted partial batch before the failure assistant starts', async () => {
	await using batch = await createBatch();
	const { agent, firstStarted, counts, errors, events, records, renderedState, publications } =
		batch;
	const receipt = await agent.dispatch('Run both tools.');
	await firstStarted.promise;
	await agent.abort();
	await expect(agent.read(receipt)).rejects.toMatchObject({
		name: 'AgentRunError',
		message: expect.stringContaining('aborted'),
	});
	expect(counts.second).toBe(0);
	const refusals = errors.filter(
		(error) => error instanceof Error && error.name === 'ConversationRecordInvariantError',
	);
	expect(refusals, 'An abort must not emit a conversation record refusal.').toHaveLength(0);
	const abortedMessages = events.filter(
		(event) =>
			event.type === 'message_end' &&
			event.message.role === 'assistant' &&
			event.message.stopReason === 'aborted',
	);
	expect(abortedMessages).toHaveLength(1);
	expect(abortedMessages).toMatchObject([
		{ message: { errorMessage: expect.stringMatching(/aborted/i) } },
	]);
	expect(JSON.stringify(abortedMessages)).not.toContain('ConversationRecordInvariantError');
	expect(JSON.stringify(abortedMessages)).not.toContain('conversation stream contract');
	const outcomes = records.filter((record) => record.type === 'tool_outcome');
	expect(outcomes.map((record) => record.toolCallId)).toEqual(['call_first', 'call_second']);
	expect(outcomes[1]).toMatchObject({
		isError: true,
		content: [
			{
				type: 'text',
				text: JSON.stringify({
					type: 'interrupted',
					message: 'Tool execution was interrupted before completion. The outcome is unknown.',
				}),
			},
		],
	});
	const commits = records.filter((record) => record.type === 'tool_results_committed');
	expect(commits).toHaveLength(1);
	expect(commits[0]?.outcomeIds).toEqual(outcomes.map((record) => record.id));
	const commitIndex = records.findIndex((record) => record.type === 'tool_results_committed');
	const starts = records.flatMap((record, index) =>
		record.type === 'assistant_message_started' ? [index] : [],
	);
	expect(starts).toHaveLength(2);
	expect(starts[1]).toBeDefined();
	expect(commitIndex < (starts[1] ?? -1)).toBe(true);
	expect(records.filter((record) => record.type === 'submission_settled')).toMatchObject([
		{ outcome: 'aborted' },
	]);
	expect(publications).toHaveLength(1);
	expect(publications[0]?.records).toContainEqual(commits[0]);
	expect(
		publications[0]?.records.filter(
			(record) => record.type === 'tool_outcome' && record.toolCallId === 'call_first',
		),
	).toEqual([outcomes[0]]);
	const advisory = records.find(
		(record) => record.type === 'signal' && record.signalType === 'submission_aborted',
	);
	expect(advisory).toMatchObject({
		attributes: { interruptedTools: JSON.stringify([{ name: 'second', id: 'call_second' }]) },
	});
	expect(records.filter((record) => record.type === 'state_write')).toMatchObject([
		{ name: 'phase', value: 'stored' },
	]);
	expect(renderedState).not.toContain('pending');
	await expect(agent.read(await agent.dispatch('Continue.'))).resolves.toMatchObject({
		text: 'Next submission succeeds.',
	});
	expect(renderedState).not.toContain('pending');
	expect(renderedState.at(-1)).toBe('stored');
});

it('keeps normal two-tool execution and state commits', async () => {
	await using batch = await createBatch({ complete: true });
	await expect(
		batch.agent.read(await batch.agent.dispatch('Run both tools.')),
	).resolves.toMatchObject({ text: 'Next submission succeeds.' });
	expect(batch.counts).toEqual({ first: 1, second: 1 });
	expect(batch.records.filter((record) => record.type === 'tool_results_committed')).toHaveLength(
		1,
	);
	expect(
		batch.records
			.filter((record) => record.type === 'tool_outcome')
			.map((record) => record.isError),
	).toEqual([false, false]);
	expect(batch.records.filter((record) => record.type === 'state_write')).toMatchObject([
		{ value: 'stored' },
		{ value: 'pending' },
	]);
	expect(batch.publications).toHaveLength(2);
});

it('keeps a complete one-tool abort on the normal commit path', async () => {
	await using batch = await createBatch({ oneTool: true });
	const receipt = await batch.agent.dispatch('Run one tool.');
	await batch.firstStarted.promise;
	await batch.agent.abort();
	await expect(batch.agent.read(receipt)).rejects.toMatchObject({ name: 'AgentRunError' });
	expect(batch.counts).toEqual({ first: 1, second: 0 });
	expect(batch.records.filter((record) => record.type === 'tool_outcome')).toHaveLength(1);
	expect(batch.records.filter((record) => record.type === 'tool_results_committed')).toMatchObject([
		{ id: expect.stringMatching(/^record_tool_results_committed_/) },
	]);
	expect(batch.records.filter((record) => record.type === 'submission_settled')).toMatchObject([
		{ outcome: 'aborted' },
	]);
	expect(batch.records.some((record) => record.id.startsWith('record_tool_repair_'))).toBe(false);
});

it('aborts before model work without creating a tool batch', async () => {
	await using batch = await createBatch({ beforeStart: true });
	const receipt = await batch.agent.dispatch('Stop before the model.');
	await batch.hookStarted.promise;
	await batch.agent.abort();
	await expect(batch.agent.read(receipt)).rejects.toMatchObject({ name: 'AgentRunError' });
	expect(batch.faux.state.callCount).toBe(0);
	expect(batch.counts).toEqual({ first: 0, second: 0 });
	expect(
		batch.records.filter(
			(record) => record.type === 'tool_outcome' || record.type === 'tool_results_committed',
		),
	).toEqual([]);
	expect(batch.records.filter((record) => record.type === 'submission_settled')).toMatchObject([
		{ outcome: 'aborted' },
	]);
});

it('leaves a queued submission for its next attempt after abort repair', async () => {
	const repairStarted = Promise.withResolvers<void>();
	const finishRepair = Promise.withResolvers<void>();
	await using batch = await createBatch({
		async beforeAppend(records) {
			if (!records.some((record) => record.id.startsWith('record_tool_repair_commit_'))) return;
			repairStarted.resolve();
			await finishRepair.promise;
		},
	});
	try {
		const receipt = await batch.agent.dispatch('Run both tools.');
		await batch.firstStarted.promise;
		await batch.agent.abort();
		await repairStarted.promise;
		const next = await batch.agent.dispatch('Run after the aborted attempt.');
		finishRepair.resolve();
		await expect(batch.agent.read(receipt)).rejects.toMatchObject({ name: 'AgentRunError' });
		expect(
			batch.joins.filter((join) => join.submissionId === receipt.submissionId && join.afterRepair),
		).toEqual([]);
		await expect(batch.agent.read(next)).resolves.toMatchObject({
			text: 'Next submission succeeds.',
		});
		expect(batch.records.filter((record) => record.type === 'submission_settled')).toMatchObject([
			{ submissionId: receipt.submissionId, outcome: 'aborted' },
			{ submissionId: next.submissionId, outcome: 'completed' },
		]);
	} finally {
		finishRepair.resolve();
	}
});

it('retries a transient commit failure without repeating stored outcomes', async () => {
	const failure = new Error('Test store rejects the repair commit.');
	let failuresRemaining = 1;
	await using batch = await createBatch({
		beforeAppend(records) {
			if (
				failuresRemaining === 0 ||
				!records.some((record) => record.id.startsWith('record_tool_repair_commit_'))
			)
				return;
			failuresRemaining -= 1;
			throw failure;
		},
	});
	const receipt = await batch.agent.dispatch('Run both tools.');
	await batch.firstStarted.promise;
	await batch.agent.abort();
	await expect(batch.agent.read(receipt)).rejects.toMatchObject({ name: 'AgentRunError' });
	expect(failuresRemaining).toBe(0);
	expect(batch.counts).toEqual({ first: 1, second: 0 });
	expect(
		batch.records
			.filter((record) => record.type === 'tool_outcome')
			.map((record) => record.toolCallId),
	).toEqual(['call_first', 'call_second']);
	expect(batch.records.filter((record) => record.type === 'tool_results_committed')).toHaveLength(
		1,
	);
	expect(batch.publications).toHaveLength(1);
	expect(
		batch.records.filter(
			(record) => record.type === 'signal' && record.signalType === 'submission_aborted',
		),
	).toMatchObject([
		{ attributes: { interruptedTools: JSON.stringify([{ name: 'second', id: 'call_second' }]) } },
	]);
	expect(batch.records.filter((record) => record.type === 'submission_settled')).toMatchObject([
		{ outcome: 'aborted' },
	]);
	await batch.agent.abort();
	await expect(batch.agent.read(receipt)).rejects.toMatchObject({ name: 'AgentRunError' });
	expect(batch.records.filter((record) => record.type === 'submission_settled')).toHaveLength(1);
});
