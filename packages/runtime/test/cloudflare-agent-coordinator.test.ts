import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import type { FlueContextInternal } from '../src/client.ts';
import { createCloudflareAgentRuntime } from '../src/cloudflare/agent-coordinator.ts';
import type { AgentExecutionStore } from '../src/agent-execution-store.ts';
import type {
	AgentSubmissionInspection,
	AgentSubmissionInterruption,
	DirectAgentSubmissionInput,
} from '../src/runtime/agent-submissions.ts';
import { createTestEventStreamStore } from './helpers/test-event-stream-store.ts';

afterEach(() => {
	vi.restoreAllMocks();
});

function queryExpectsRows(query: string): boolean {
	const trimmed = query.trimStart().toUpperCase();
	if (trimmed.startsWith('SELECT') || trimmed.startsWith('WITH')) return true;
	if (/\bRETURNING\b/i.test(query)) return true;
	return false;
}

function makeFakeSql(events: string[] = []) {
	const db = new DatabaseSync(':memory:');
	db.exec(
		'CREATE TABLE cf_agents_runs (name TEXT NOT NULL, snapshot TEXT, created_at INTEGER NOT NULL)',
	);
	return {
		db,
		storage: {
			sql: {
				exec(query: string, ...bindings: unknown[]) {
					if (query.includes('SET recovery_requested_at')) events.push('request-recovery');
					if (query.includes("SET status = 'queued'")) events.push('requeue');
					if (query.includes("SET status = 'settled', settled_at")) events.push('settle');
					const stmt = db.prepare(query);
					let rows: unknown[];
					if (queryExpectsRows(query)) {
						rows = stmt.all(...(bindings as never[]));
					} else {
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

function makeRuntime(
	options: {
		createdAgent?: Parameters<typeof createCloudflareAgentRuntime>[0]['createdAgents'][string];
		createContext?: Parameters<typeof createCloudflareAgentRuntime>[0]['createContext'];
		createEventStreamStore?: Parameters<
			typeof createCloudflareAgentRuntime
		>[0]['createEventStreamStore'];
	} = {},
) {
	return createCloudflareAgentRuntime({
		createdAgents: options.createdAgent ? { assistant: options.createdAgent } : {},
		createContext:
			options.createContext ??
			(() => {
				throw new Error('Unexpected context creation.');
			}),
		runWithInstanceContext(_instance, _agentName, callback) {
			return callback();
		},
		createEventStreamStore: options.createEventStreamStore ?? (() => createTestEventStreamStore()),
	});
}

function makeInstance(storage: ReturnType<typeof makeFakeSql>['storage'], events: string[] = []) {
	return {
		name: 'agent-1',
		env: {},
		ctx: {
			id: { toString: () => 'do-1' },
			storage,
		},
		async __unsafe_ensureInitialized() {},
		async schedule(
			_delaySeconds: number,
			_callback: string,
			_payload: undefined,
			options: { idempotent: boolean },
		) {
			events.push(options.idempotent ? 'schedule-idempotent' : 'schedule-successor');
		},
		async runFiber(
			_name: string,
			_callback: (ctx: { stash(snapshot: unknown): void }) => Promise<void>,
		) {},
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
			return options.inspection ?? 'uncertain';
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

function directInput(
	overrides: Partial<DirectAgentSubmissionInput> = {},
): DirectAgentSubmissionInput {
	return {
		kind: 'direct',
		submissionId: 'direct-1',
		agent: 'assistant',
		id: 'agent-1',
		session: 'default',
		payload: { message: 'Hello' },
		acceptedAt: '2026-06-03T00:00:00.000Z',
		...overrides,
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
): AgentExecutionStore {
	const prepared = runtime.prepare({
		storage: instance.ctx.storage,
		className: 'FlueAssistantAgent',
		agentName: 'assistant',
	});
	runtime.attach(instance, prepared);
	return prepared.executionStore;
}

describe('createCloudflareAgentRuntime()', () => {
	it('reuses one event stream store for reads and writes on an instance', async () => {
		const store = {
			getStreamMeta: vi.fn(),
			readEvents: vi.fn(),
			createStream: vi.fn(),
			appendEvent: vi.fn(),
			closeStream: vi.fn(),
			subscribe: vi.fn(),
			deleteStream: vi.fn(),
		};
		const createEventStreamStore = vi.fn(() => store);
		const runtime = makeRuntime({ createEventStreamStore });
		const { storage } = makeFakeSql();
		const instance = makeInstance(storage);
		prepare(runtime, instance);

		await runtime.onRequest(instance, new Request('http://localhost/agents/assistant/agent-1'));

		expect(createEventStreamStore).toHaveBeenCalledOnce();
	});

	it('initializes SQLite during preparation before instance attachment', () => {
		const runtime = makeRuntime();

		expect(() =>
			runtime.prepare({ storage: {}, className: 'FlueAssistantAgent', agentName: 'assistant' }),
		).toThrow(
			'Cloudflare durable agent class "FlueAssistantAgent" requires Durable Object SQLite.',
		);
	});

	it('restores a pending wake before inherited startup when unsettled work exists', async () => {
		const events: string[] = [];
		const { storage } = makeFakeSql();
		const runtime = makeRuntime();
		const instance = makeInstance(storage, events);
		const executionStore = prepare(runtime, instance);
		await executionStore.submissions.admitDirect(directInput());

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
		await executionStore.submissions.admitDirect(directInput());

		await runtime.wakeSubmissions(instance);

		expect(events[0]).toBe('schedule-successor');
	});

	it('restores a wake before recording recovered raw Fiber ownership', async () => {
		const events: string[] = [];
		const { storage } = makeFakeSql(events);
		const runtime = makeRuntime();
		const instance = makeInstance(storage, events);
		const executionStore = prepare(runtime, instance);
		await executionStore.submissions.admitDirect(directInput());
		await executionStore.submissions.claimSubmission({
			submissionId: 'direct-1',
			attemptId: 'attempt-1',
			ownerId: 'test-owner',
			leaseExpiresAt: Date.now() + 30_000,
		});

		await runtime.onFiberRecovered(
			instance,
			{
				name: 'flue:submission-attempt',
				snapshot: { submissionId: 'direct-1', attemptId: 'attempt-1' },
			},
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
		await executionStore.submissions.admitDirect(directInput());

		await runtime.onStart(instance, () => {});

		expect(await executionStore.submissions.getSubmission('direct-1')).toMatchObject({
			status: 'running',
		});
	});

	it('skips malformed raw Fiber markers and continues reconciliation', async () => {
		const { db, storage } = makeFakeSql();
		const runtime = makeRuntime();
		const instance = makeInstance(storage);
		const executionStore = prepare(runtime, instance);
		db.prepare('INSERT INTO cf_agents_runs (name, snapshot, created_at) VALUES (?, ?, ?)').run(
			'flue:submission-attempt',
			'null',
			Date.now(),
		);
		await executionStore.submissions.admitDirect(directInput());

		await runtime.onStart(instance, () => {});

		// Malformed marker is skipped; the queued submission is claimed and processed.
		expect(await executionStore.submissions.getSubmission('direct-1')).toMatchObject({
			status: 'running',
		});
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
		await executionStore.submissions.admitDirect(directInput());
		await executionStore.submissions.claimSubmission({
			submissionId: 'direct-1',
			attemptId: 'attempt-1',
			ownerId: 'test-owner',
			leaseExpiresAt: Date.now() + 30_000,
		});

		await runtime.onStart(instance, () => {});

		expect(events).toContain('requeue');
		expect(await executionStore.submissions.getSubmission('direct-1')).toMatchObject({
			status: 'running',
		});
	});

	it('records interruption before settling applied incomplete canonical input as error', async () => {
		const events: string[] = [];
		const { storage } = makeFakeSql(events);
		const recovery = makeRecoveryContext({ inspection: 'uncertain', events });
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
		await executionStore.submissions.admitDirect(directInput());
		await executionStore.submissions.claimSubmission({
			submissionId: 'direct-1',
			attemptId: 'attempt-1',
			ownerId: 'test-owner',
			leaseExpiresAt: Date.now() + 30_000,
		});
		await executionStore.submissions.markSubmissionInputApplied({
			submissionId: 'direct-1',
			attemptId: 'attempt-1',
		});

		await runtime.onStart(instance, () => {});

		expect(events).toEqual(['record-terminal', 'settle']);
		expect(payloads).toEqual([directInput(), directInput().payload]);
		expect(await executionStore.submissions.getSubmission('direct-1')).toMatchObject({
			status: 'settled',
		});
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
		await executionStore.submissions.admitDirect(directInput());
		await executionStore.submissions.claimSubmission({
			submissionId: 'direct-1',
			attemptId: 'attempt-1',
			ownerId: 'test-owner',
			leaseExpiresAt: Date.now() + 30_000,
		});
		await executionStore.submissions.markSubmissionInputApplied({
			submissionId: 'direct-1',
			attemptId: 'attempt-1',
		});

		await runtime.onStart(instance, () => {});

		expect(await executionStore.submissions.getSubmission('direct-1')).toMatchObject({
			status: 'settled',
		});
	});

	it('claims queued submissions when another attempt fails to start synchronously', async () => {
		const { storage } = makeFakeSql();
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		let startCalls = 0;
		const runtime = makeRuntime();
		const instance = makeInstance(storage);
		instance.runFiber = (_name, _callback) => {
			startCalls += 1;
			if (startCalls === 1) throw new Error('Fiber startup failed');
			return new Promise<void>(() => {});
		};
		const executionStore = prepare(runtime, instance);
		await executionStore.submissions.admitDirect(directInput());

		await runtime.onStart(instance, () => {});

		expect(startCalls).toBe(1);
		expect(await executionStore.submissions.getSubmission('direct-1')).toMatchObject({
			status: 'running',
		});
		expect(consoleError).toHaveBeenCalledWith(
			'[flue:submission-reconciliation]',
			expect.objectContaining({
				submissionId: 'direct-1',
				operation: 'start_submission',
				outcome: 'deferred_to_scheduled_wake',
			}),
			expect.any(Error),
		);
	});

	it('retries a synchronously failed attempt on a later wake when canonical input is absent', async () => {
		const events: string[] = [];
		const { storage } = makeFakeSql(events);
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const recovery = makeRecoveryContext({ inspection: 'absent' });
		let startCalls = 0;
		const runtime = makeRuntime({
			createdAgent: {} as never,
			createContext: () => recovery.ctx,
		});
		const instance = makeInstance(storage);
		instance.runFiber = (_name, _callback) => {
			startCalls += 1;
			if (startCalls === 1) throw new Error('Fiber startup failed');
			return new Promise<void>(() => {});
		};
		const executionStore = prepare(runtime, instance);
		await executionStore.submissions.admitDirect(directInput());

		await runtime.onStart(instance, () => {});
		const failedAttempt = (await executionStore.submissions.getSubmission('direct-1'))?.attemptId;
		await runtime.wakeSubmissions(instance);

		expect(startCalls).toBe(2);
		expect(events).toContain('requeue');
		expect(await executionStore.submissions.getSubmission('direct-1')).toMatchObject({
			status: 'running',
			attemptId: expect.any(String),
		});
		expect((await executionStore.submissions.getSubmission('direct-1'))?.attemptId).not.toBe(
			failedAttempt,
		);
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
					subscribeEvent() {
						return () => {};
					},
				} as unknown as FlueContextInternal;
			},
		});
		const instance = makeInstance(storage);
		instance.runFiber = async (_name, callback) => callback({ stash() {} });
		const executionStore = prepare(runtime, instance);
		await executionStore.submissions.admitDispatch(dispatchInput());

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
		await executionStore.submissions.admitDispatch(dispatchInput());
		await executionStore.submissions.claimSubmission({
			submissionId: 'dispatch-1',
			attemptId: 'attempt-1',
			ownerId: 'test-owner',
			leaseExpiresAt: Date.now() + 30_000,
		});
		await executionStore.submissions.markSubmissionInputApplied({
			submissionId: 'dispatch-1',
			attemptId: 'attempt-1',
		});

		await runtime.onStart(instance, () => {});

		expect(payloads).toEqual([dispatchInput()]);
		expect(await executionStore.submissions.getSubmission('dispatch-1')).toMatchObject({
			status: 'settled',
		});
	});
});
