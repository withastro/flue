import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentExecutionStore } from '../src/agent-execution-store.ts';
import type { FlueContextInternal } from '../src/client.ts';
import { createCloudflareAgentRuntime } from '../src/cloudflare/agent-coordinator.ts';
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

function makeFakeSql() {
	const db = new DatabaseSync(':memory:');
	return {
		db,
		storage: {
			sql: {
				exec(query: string, ...bindings: unknown[]) {
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
		createdAgent?: Parameters<typeof createCloudflareAgentRuntime>[0]['agents'][number]['definition'];
		createContext?: Parameters<typeof createCloudflareAgentRuntime>[0]['createContext'];
		createEventStreamStore?: Parameters<
			typeof createCloudflareAgentRuntime
		>[0]['createEventStreamStore'];
	} = {},
) {
	return createCloudflareAgentRuntime({
		agents: options.createdAgent
			? [{ name: 'assistant', definition: options.createdAgent }]
			: [],
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
		reconstructSubmissionResult() {
			return undefined;
		},
		async recordSubmissionTerminal(input: AgentSubmissionInterruption) {
			options.events?.push('record-terminal');
			terminalRecords.push(input);
		},
	};
	const ctx = {
		async initializeRootHarness() {
			return {
				async session() {
					return session;
				},
			};
		},
		createEvent(event: unknown) {
			return event;
		},
		publishEvent() {},
		emitEvent(event: unknown) {
			return event;
		},
		async flushEventCallbacks() {},
		subscribeEvent() {
			return () => {};
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
			appendEventOnce: vi.fn(),
			closeStream: vi.fn(),
			subscribe: vi.fn(),
		};
		const createEventStreamStore = vi.fn(() => store);
		const runtime = makeRuntime({ createEventStreamStore });
		const { storage } = makeFakeSql();
		const instance = makeInstance(storage);
		prepare(runtime, instance);

		await runtime.onRequest(instance, new Request('http://localhost/agents/assistant/agent-1'));

		expect(createEventStreamStore).toHaveBeenCalledOnce();
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
		const { storage } = makeFakeSql();
		const runtime = makeRuntime();
		const instance = makeInstance(storage, events);
		const executionStore = prepare(runtime, instance);
		const originalRequestRecovery = executionStore.submissions.requestSubmissionRecovery.bind(
			executionStore.submissions,
		);
		executionStore.submissions.requestSubmissionRecovery = async (attempt) => {
			events.push('request-recovery');
			return originalRequestRecovery(attempt);
		};
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

	it('skips interrupted-attempt reconciliation while a fresh attempt marker covers the running attempt', async () => {
		const events: string[] = [];
		const { storage } = makeFakeSql();
		const recovery = makeRecoveryContext({ inspection: 'absent' });
		const runtime = makeRuntime({
			createdAgent: {} as never,
			createContext: () => recovery.ctx,
		});
		const instance = makeInstance(storage);
		const executionStore = prepare(runtime, instance);
		const originalRequeue = executionStore.submissions.requeueSubmissionBeforeInputApplied.bind(
			executionStore.submissions,
		);
		executionStore.submissions.requeueSubmissionBeforeInputApplied = async (attempt) => {
			events.push('requeue');
			return originalRequeue(attempt);
		};
		await executionStore.submissions.admitDirect(directInput());
		await executionStore.submissions.claimSubmission({
			submissionId: 'direct-1',
			attemptId: 'attempt-1',
			ownerId: 'test-owner',
			leaseExpiresAt: Date.now() + 30_000,
		});
		await executionStore.submissions.insertAttemptMarker({
			submissionId: 'direct-1',
			attemptId: 'attempt-1',
		});

		await runtime.onStart(instance, () => {});

		expect(events).not.toContain('requeue');
		expect(await executionStore.submissions.getSubmission('direct-1')).toMatchObject({
			status: 'running',
			attemptId: 'attempt-1',
		});
	});

	it('reconciles running attempts when the attempt marker is stale', async () => {
		const events: string[] = [];
		const { db, storage } = makeFakeSql();
		const recovery = makeRecoveryContext({ inspection: 'absent' });
		const runtime = makeRuntime({
			createdAgent: {} as never,
			createContext: () => recovery.ctx,
		});
		const instance = makeInstance(storage);
		const executionStore = prepare(runtime, instance);
		const originalRequeue = executionStore.submissions.requeueSubmissionBeforeInputApplied.bind(
			executionStore.submissions,
		);
		executionStore.submissions.requeueSubmissionBeforeInputApplied = async (attempt) => {
			events.push('requeue');
			return originalRequeue(attempt);
		};
		await executionStore.submissions.admitDirect(directInput());
		await executionStore.submissions.claimSubmission({
			submissionId: 'direct-1',
			attemptId: 'attempt-1',
			ownerId: 'test-owner',
			leaseExpiresAt: Date.now() + 30_000,
		});
		db.prepare(
			'INSERT INTO flue_agent_attempt_markers (submission_id, attempt_id, created_at) VALUES (?, ?, ?)',
		).run('direct-1', 'attempt-1', Date.now() - 16 * 60 * 1000);

		await runtime.onStart(instance, () => {});

		expect(events).toContain('requeue');
		expect(await executionStore.submissions.getSubmission('direct-1')).toMatchObject({
			status: 'running',
		});
	});

	it('inserts an attempt marker before the fiber starts and deletes it after settlement', async () => {
		const { storage } = makeFakeSql();
		const session = {
			async processSubmissionInput() {},
			async recordSubmissionTerminal() {},
		};
		const runtime = makeRuntime({
			createdAgent: {} as never,
			createContext: () =>
				({
					async initializeRootHarness() {
						return {
							async session() {
								return session;
							},
						};
					},
					setEventCallback() {},
					createEvent(event: unknown) {
						return event;
					},
					publishEvent() {},
					emitEvent(event: unknown) {
						return event;
					},
					async flushEventCallbacks() {},
					subscribeEvent() {
						return () => {};
					},
				}) as unknown as FlueContextInternal,
		});
		const instance = makeInstance(storage);
		const executionStore = prepare(runtime, instance);
		let markersAtFiberStart: unknown[] | undefined;
		instance.runFiber = async (_name, callback) => {
			markersAtFiberStart = await executionStore.submissions.listAttemptMarkers();
			await callback({ stash() {} });
		};
		await executionStore.submissions.admitDirect(directInput());

		await runtime.onStart(instance, () => {});

		expect(markersAtFiberStart).toEqual([expect.objectContaining({ submissionId: 'direct-1' })]);
		await vi.waitFor(async () => {
			expect(await executionStore.submissions.listAttemptMarkers()).toEqual([]);
		});
		expect(await executionStore.submissions.getSubmission('direct-1')).toMatchObject({
			status: 'settled',
		});
	});

	it('degrades to an empty marker set when the marker scan fails so queued submissions remain claimable', async () => {
		const { db, storage } = makeFakeSql();
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		const runtime = makeRuntime();
		const instance = makeInstance(storage);
		const executionStore = prepare(runtime, instance);
		db.exec('DROP TABLE flue_agent_attempt_markers');
		await executionStore.submissions.admitDirect(directInput());

		await runtime.onStart(instance, () => {});

		expect(await executionStore.submissions.getSubmission('direct-1')).toMatchObject({
			status: 'running',
		});
		expect(consoleError).toHaveBeenCalledWith(
			'[flue:submission-reconciliation]',
			expect.objectContaining({
				operation: 'list_attempt_markers',
				outcome: 'degraded_to_empty_marker_set',
			}),
			expect.any(Error),
		);
	});

	it('requeues interrupted attempts when canonical input is absent', async () => {
		const events: string[] = [];
		const { storage } = makeFakeSql();
		const recovery = makeRecoveryContext({ inspection: 'absent' });
		const runtime = makeRuntime({
			createdAgent: {} as never,
			createContext: () => recovery.ctx,
		});
		const instance = makeInstance(storage);
		const executionStore = prepare(runtime, instance);
		const originalRequeue = executionStore.submissions.requeueSubmissionBeforeInputApplied.bind(
			executionStore.submissions,
		);
		executionStore.submissions.requeueSubmissionBeforeInputApplied = async (attempt) => {
			events.push('requeue');
			return originalRequeue(attempt);
		};
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
		const { storage } = makeFakeSql();
		const recovery = makeRecoveryContext({ inspection: 'uncertain', events });
		let contextCount = 0;
		const runtime = makeRuntime({
			createdAgent: {} as never,
			createContext: () => {
				contextCount += 1;
				return recovery.ctx;
			},
		});
		const instance = makeInstance(storage);
		const executionStore = prepare(runtime, instance);
		const originalFinalize = executionStore.submissions.finalizeSubmissionTerminal.bind(
			executionStore.submissions,
		);
		executionStore.submissions.finalizeSubmissionTerminal = async (attempt, eventKey) => {
			events.push('settle-error');
			return originalFinalize(attempt, eventKey);
		};
		await executionStore.submissions.admitDirect(directInput());
		const claimed = await executionStore.submissions.claimSubmission({
			submissionId: 'direct-1',
			attemptId: 'attempt-1',
			ownerId: 'test-owner',
			leaseExpiresAt: Date.now() + 30_000,
		});
		if (!claimed) throw new Error('Expected claimed submission.');
		await executionStore.submissions.markSubmissionInputApplied({
			submissionId: 'direct-1',
			attemptId: 'attempt-1',
		});
		// The journal records that the provider was reached for the current
		// turn; with the canonical state still 'uncertain', the interruption
		// cannot be proven replay-safe and must terminalize. (Without a
		// journal the provider was provably never reached and reconciliation
		// retries instead.)
		await executionStore.submissions.beginTurnJournal({
			submissionId: 'direct-1',
			sessionKey: claimed.sessionKey,
			kind: 'direct',
			attemptId: 'attempt-1',
			operationId: 'op-1',
			turnId: 'turn-1',
			phase: 'before_provider',
		});
		await executionStore.submissions.updateTurnJournalPhase(
			{ submissionId: 'direct-1', attemptId: 'attempt-1' },
			'provider_started',
		);

		await runtime.onStart(instance, () => {});

		expect(events).toEqual(['record-terminal', 'settle-error']);
		expect(contextCount).toBe(2);
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
		const { storage } = makeFakeSql();
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
		const originalRequeue = executionStore.submissions.requeueSubmissionBeforeInputApplied.bind(
			executionStore.submissions,
		);
		executionStore.submissions.requeueSubmissionBeforeInputApplied = async (attempt) => {
			events.push('requeue');
			return originalRequeue(attempt);
		};
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

	it('delivers the persisted dispatch submission through the session when processing', async () => {
		const { storage } = makeFakeSql();
		const processedInputs: unknown[] = [];
		let resolveProcessed!: () => void;
		const processed = new Promise<void>((resolve) => {
			resolveProcessed = resolve;
		});
		const session = {
			async processSubmissionInput(input: unknown) {
				processedInputs.push(input);
				resolveProcessed();
			},
			async recordSubmissionTerminal() {},
		};
		const runtime = makeRuntime({
			createdAgent: {} as never,
			createContext: () => {
				return {
					async initializeRootHarness() {
						return {
							async session() {
								return session;
							},
						};
					},
					setEventCallback() {},
					createEvent(event: unknown) {
						return event;
					},
					publishEvent() {},
					emitEvent(event: unknown) {
						return event;
					},
					async flushEventCallbacks() {},
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

		expect(processedInputs).toEqual([
			{ ...dispatchInput(), kind: 'dispatch', submissionId: 'dispatch-1' },
		]);
	});

	it('settles recovered dispatch input without context payload plumbing', async () => {
		const { storage } = makeFakeSql();
		const recovery = makeRecoveryContext({ inspection: 'completed' });
		let contextCount = 0;
		const runtime = makeRuntime({
			createdAgent: {} as never,
			createContext: () => {
				contextCount += 1;
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

		expect(contextCount).toBe(1);
		expect(await executionStore.submissions.getSubmission('dispatch-1')).toMatchObject({
			status: 'settled',
		});
	});
});
