import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { FlueContextInternal } from '../src/client.ts';
import { createCloudflareAgentRuntime } from '../src/cloudflare/agent-coordinator.ts';
import type { SqlAgentExecutionStore } from '../src/cloudflare/agent-execution-store.ts';
import type { AgentSubmissionInspection, AgentSubmissionInterruption } from '../src/runtime/agent-submissions.ts';

function makeFakeSql(events: string[] = []) {
	const db = new DatabaseSync(':memory:');
	db.exec('CREATE TABLE cf_agents_runs (name TEXT NOT NULL, snapshot TEXT, created_at INTEGER NOT NULL)');
	return {
		db,
		storage: {
			sql: {
				exec(query: string, ...bindings: unknown[]) {
					if (query.includes('SET recovery_requested_at')) events.push('request-recovery');
					if (query.includes("SET status = 'queued'")) events.push('requeue');
					if (query.includes("SET status = 'terminalizing'")) events.push('begin-terminalization');
					if (query.includes("SET status = 'error', completed_at")) events.push('finish-terminalization');
					const stmt = db.prepare(query);
					let rows: unknown[];
					try {
						rows = stmt.all(...(bindings as never[]));
					} catch {
						stmt.run(...(bindings as never[]));
						rows = [];
					}
					return {
						toArray() {
							return rows as Record<string, unknown>[];
						},
					};
				},
			},
			transactionSync<T>(closure: () => T): T {
				db.exec('BEGIN');
				try {
					const result = closure();
					db.exec('COMMIT');
					return result;
				} catch (error) {
					db.exec('ROLLBACK');
					throw error;
				}
			},
		},
	};
}

function makeRuntime(options: {
	createdAgent?: Parameters<typeof createCloudflareAgentRuntime>[0]['createdAgents'][string];
	createContext?: Parameters<typeof createCloudflareAgentRuntime>[0]['createContext'];
} = {}) {
	return createCloudflareAgentRuntime({
		createdAgents: options.createdAgent ? { assistant: options.createdAgent } : {},
		directHandlers: {},
		websocketAgentHandlers: {},
		createContext: options.createContext ?? (() => {
			throw new Error('Unexpected context creation.');
		}),
		runWithInstanceContext(_instance, _agentName, callback) {
			return callback();
		},
		createWebSocketPair() {
			throw new Error('Unexpected WebSocket pair creation.');
		},
	});
}

function makeInstance(
	storage: ReturnType<typeof makeFakeSql>['storage'],
	events: string[] = [],
) {
	return {
		name: 'agent-1',
		env: {},
		ctx: {
			id: { toString: () => 'do-1' },
			storage,
			acceptWebSocket() {},
		},
		async __unsafe_ensureInitialized() {},
		async schedule(_delaySeconds: number, _callback: string, _payload: undefined, options: { idempotent: boolean }) {
			events.push(options.idempotent ? 'schedule-idempotent' : 'schedule-successor');
		},
		async runFiber(_name: string, _callback: (ctx: { stash(snapshot: unknown): void }) => Promise<void>) {},
	};
}

function makeRecoveryContext(options: {
	inspection?: AgentSubmissionInspection;
	events?: string[];
}) {
	const terminalRecords: AgentSubmissionInterruption[] = [];
	const session = {
		processSubmissionInput() {
			throw new Error('Unexpected submission processing.');
		},
		inspectSubmissionInput() {
			return options.inspection ?? 'applied';
		},
		async recordSubmissionTerminal(input: AgentSubmissionInterruption) {
			options.events?.push('record-terminal');
			terminalRecords.push(input);
		},
	};
	const ctx = {
		async initializeCreatedAgent() {
			return {
				async session() {
					return session;
				},
			};
		},
	} as unknown as FlueContextInternal;
	return { ctx, terminalRecords };
}

function directInput() {
	return {
		kind: 'direct' as const,
		submissionId: 'direct-1',
		agent: 'assistant',
		id: 'agent-1',
		session: 'default',
		payload: { message: 'Hello' },
		acceptedAt: '2026-06-03T00:00:00.000Z',
	};
}

function dispatchInput() {
	return {
		dispatchId: 'dispatch-1',
		agent: 'assistant',
		id: 'agent-1',
		session: 'default',
		input: { message: 'Hello' },
		acceptedAt: '2026-06-03T00:00:00.000Z',
	};
}

function prepare(
	runtime: ReturnType<typeof makeRuntime>,
	instance: ReturnType<typeof makeInstance>,
): SqlAgentExecutionStore {
	const prepared = runtime.prepare({
		storage: instance.ctx.storage,
		className: 'FlueAssistantAgent',
		agentName: 'assistant',
	});
	runtime.attach(instance, prepared);
	return prepared.executionStore;
}

describe('createCloudflareAgentRuntime()', () => {
	it('initializes SQLite during preparation before instance attachment', () => {
		const runtime = makeRuntime();

		expect(() =>
			runtime.prepare({ storage: {}, className: 'FlueAssistantAgent', agentName: 'assistant' }),
		).toThrow('Cloudflare durable agent class "FlueAssistantAgent" requires Durable Object SQLite.');
	});

	it('restores a pending wake before inherited startup when unsettled work exists', async () => {
		const events: string[] = [];
		const { storage } = makeFakeSql();
		const runtime = makeRuntime();
		const instance = makeInstance(storage, events);
		const executionStore = prepare(runtime, instance);
		executionStore.submissions.admitDirect(directInput());

		await runtime.onStart(instance, () => {
			events.push('inherited-start');
		});

		expect(events.slice(0, 2)).toEqual(['schedule-idempotent', 'inherited-start']);
	});

	it('arms a fresh non-idempotent successor before scheduled reconciliation', async () => {
		const events: string[] = [];
		const { storage } = makeFakeSql();
		const runtime = makeRuntime();
		const instance = makeInstance(storage, events);
		const executionStore = prepare(runtime, instance);
		executionStore.submissions.admitDirect(directInput());

		await runtime.wakeSubmissions(instance);

		expect(events[0]).toBe('schedule-successor');
	});

	it('restores a wake before recording recovered raw Fiber ownership', async () => {
		const events: string[] = [];
		const { storage } = makeFakeSql(events);
		const runtime = makeRuntime();
		const instance = makeInstance(storage, events);
		const executionStore = prepare(runtime, instance);
		executionStore.submissions.admitDirect(directInput());
		executionStore.submissions.claimSubmission('direct-1', 'attempt-1');

		await runtime.onFiberRecovered(
			instance,
			{ name: 'flue:submission-attempt', snapshot: { submissionId: 'direct-1', attemptId: 'attempt-1' } },
			() => {},
		);

		expect(events).toEqual(['schedule-idempotent', 'request-recovery']);
	});

	it('ignores SQL NULL pre-stash markers so queued submissions remain claimable', async () => {
		const { db, storage } = makeFakeSql();
		const runtime = makeRuntime();
		const instance = makeInstance(storage);
		const executionStore = prepare(runtime, instance);
		db.prepare('INSERT INTO cf_agents_runs (name, snapshot, created_at) VALUES (?, ?, ?)').run(
			'flue:submission-attempt',
			null,
			Date.now(),
		);
		executionStore.submissions.admitDirect(directInput());

		await runtime.onStart(instance, () => {});

		expect(executionStore.submissions.getSubmission('direct-1')).toMatchObject({ status: 'running' });
	});

	it('blocks claims when an active raw Fiber marker has malformed non-NULL evidence', async () => {
		const { db, storage } = makeFakeSql();
		const runtime = makeRuntime();
		const instance = makeInstance(storage);
		const executionStore = prepare(runtime, instance);
		db.prepare('INSERT INTO cf_agents_runs (name, snapshot, created_at) VALUES (?, ?, ?)').run(
			'flue:submission-attempt',
			'null',
			Date.now(),
		);
		executionStore.submissions.admitDirect(directInput());

		await runtime.onStart(instance, () => {});

		expect(executionStore.submissions.getSubmission('direct-1')).toMatchObject({ status: 'queued' });
	});

	it('requeues interrupted attempts when canonical input is absent', async () => {
		const events: string[] = [];
		const { storage } = makeFakeSql(events);
		const recovery = makeRecoveryContext({ inspection: 'absent' });
		const runtime = makeRuntime({
			createdAgent: {} as never,
			createContext: () => recovery.ctx,
		});
		const instance = makeInstance(storage);
		const executionStore = prepare(runtime, instance);
		executionStore.submissions.admitDirect(directInput());
		executionStore.submissions.claimSubmission('direct-1', 'attempt-1');

		await runtime.onStart(instance, () => {});

		expect(events).toContain('requeue');
		expect(executionStore.submissions.getSubmission('direct-1')).toMatchObject({ status: 'running' });
	});

	it('records interruption before settling applied incomplete canonical input as error', async () => {
		const events: string[] = [];
		const { storage } = makeFakeSql(events);
		const recovery = makeRecoveryContext({ inspection: 'applied', events });
		const payloads: unknown[] = [];
		const runtime = makeRuntime({
			createdAgent: {} as never,
			createContext: ({ payload }) => {
				payloads.push(payload);
				return recovery.ctx;
			},
		});
		const instance = makeInstance(storage);
		const executionStore = prepare(runtime, instance);
		executionStore.submissions.admitDirect(directInput());
		executionStore.submissions.claimSubmission('direct-1', 'attempt-1');
		executionStore.submissions.markSubmissionInputApplied('direct-1', 'attempt-1');

		await runtime.onStart(instance, () => {});

		expect(events).toEqual(['begin-terminalization', 'record-terminal', 'finish-terminalization']);
		expect(payloads).toEqual([directInput(), directInput().payload]);
		expect(executionStore.submissions.getSubmission('direct-1')).toMatchObject({ status: 'error' });
	});

	it('resumes terminalizing rows by recording interruption before final SQL settlement', async () => {
		const events: string[] = [];
		const { storage } = makeFakeSql(events);
		const recovery = makeRecoveryContext({ events });
		const runtime = makeRuntime({
			createdAgent: {} as never,
			createContext: () => recovery.ctx,
		});
		const instance = makeInstance(storage);
		const executionStore = prepare(runtime, instance);
		executionStore.submissions.admitDirect(directInput());
		executionStore.submissions.claimSubmission('direct-1', 'attempt-1');
		executionStore.submissions.beginSubmissionTerminalization('direct-1', 'attempt-1');
		events.splice(0);

		await runtime.onStart(instance, () => {});

		expect(events).toEqual(['record-terminal', 'finish-terminalization']);
		expect(executionStore.submissions.getSubmission('direct-1')).toMatchObject({ status: 'error' });
	});

	it('settles interrupted attempts when canonical completion is already persisted', async () => {
		const { storage } = makeFakeSql();
		const recovery = makeRecoveryContext({ inspection: 'completed' });
		const runtime = makeRuntime({
			createdAgent: {} as never,
			createContext: () => recovery.ctx,
		});
		const instance = makeInstance(storage);
		const executionStore = prepare(runtime, instance);
		executionStore.submissions.admitDirect(directInput());
		executionStore.submissions.claimSubmission('direct-1', 'attempt-1');
		executionStore.submissions.markSubmissionInputApplied('direct-1', 'attempt-1');

		await runtime.onStart(instance, () => {});

		expect(executionStore.submissions.getSubmission('direct-1')).toMatchObject({ status: 'completed' });
	});

	it('uses the public dispatch input as processing context payload without internal envelope fields', async () => {
		const { storage } = makeFakeSql();
		const payloads: unknown[] = [];
		let resolveProcessed!: () => void;
		const processed = new Promise<void>((resolve) => {
			resolveProcessed = resolve;
		});
		const session = {
			async processSubmissionInput() {
				resolveProcessed();
			},
			async recordSubmissionTerminal() {},
		};
		const runtime = makeRuntime({
			createdAgent: {} as never,
			createContext: ({ payload }) => {
				payloads.push(payload);
				return {
					async initializeCreatedAgent() {
						return {
							async session() {
								return session;
							},
						};
					},
					setEventCallback() {},
				} as unknown as FlueContextInternal;
			},
		});
		const instance = makeInstance(storage);
		instance.runFiber = async (_name, callback) => callback({ stash() {} });
		const executionStore = prepare(runtime, instance);
		executionStore.submissions.admitDispatch(dispatchInput());

		await runtime.onStart(instance, () => {});
		await processed;

		expect(payloads).toEqual([dispatchInput()]);
	});

	it('uses the full dispatch input when constructing detached recovery context', async () => {
		const { storage } = makeFakeSql();
		const recovery = makeRecoveryContext({ inspection: 'completed' });
		const payloads: unknown[] = [];
		const runtime = makeRuntime({
			createdAgent: {} as never,
			createContext: ({ payload }) => {
				payloads.push(payload);
				return recovery.ctx;
			},
		});
		const instance = makeInstance(storage);
		const executionStore = prepare(runtime, instance);
		executionStore.submissions.admitDispatch(dispatchInput());
		executionStore.submissions.claimSubmission('dispatch-1', 'attempt-1');
		executionStore.submissions.markSubmissionInputApplied('dispatch-1', 'attempt-1');

		await runtime.onStart(instance, () => {});

		expect(payloads).toEqual([dispatchInput()]);
		expect(executionStore.submissions.getSubmission('dispatch-1')).toMatchObject({ status: 'completed' });
	});
});
