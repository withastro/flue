import type {
	AgentPromptImage,
	AgentPromptResponse,
	ConversationStreamChunk,
	FlueClient,
	FlueEvent,
	WorkflowRunResult,
} from '@flue/sdk';
import {
	type ConsoleTranscript,
	createConsoleTranscript,
	reduceConsoleTranscript,
	type TranscriptAction,
} from './console-transcript.ts';

export type ConsoleResource =
	| { kind: 'agent'; name: string; instanceId: string }
	| { kind: 'workflow'; name: string };

type ConsoleStatus = 'ready' | 'active' | 'completed' | 'failed' | 'closing' | 'closed';

export interface ConsoleQueuedPrompt {
	readonly id: number;
	readonly message: string;
}

interface ConsoleSnapshot {
	readonly resource: ConsoleResource;
	readonly id?: string;
	readonly server: string;
	readonly status: ConsoleStatus;
	readonly active: boolean;
	readonly composerEnabled: boolean;
	readonly queuedPrompts: readonly ConsoleQueuedPrompt[];
	readonly transcript: ConsoleTranscript;
}

export interface ConsoleControllerOptions {
	readonly client: FlueClient;
	readonly resource: ConsoleResource;
	readonly server: string;
	readonly initialInput?: unknown;
}

export interface ConsoleController {
	readonly subscribe: (listener: () => void) => () => void;
	readonly getSnapshot: () => ConsoleSnapshot;
	start(): Promise<void>;
	submit(message: string): Promise<void>;
	close(): Promise<void>;
	forceCloseSync(): void;
}

interface AgentInput {
	message: string;
	images?: AgentPromptImage[];
}

type ExecutionTarget =
	| { kind: 'agent'; name: string; instanceId: string; input: AgentInput }
	| { kind: 'workflow'; name: string; input?: unknown };

export function createConsoleController(options: ConsoleControllerOptions): ConsoleController {
	const listeners = new Set<() => void>();
	let snapshot: ConsoleSnapshot = {
		resource: options.resource,
		id: options.resource.kind === 'agent' ? options.resource.instanceId : undefined,
		server: options.server,
		status: 'ready',
		active: false,
		composerEnabled: options.resource.kind === 'agent',
		queuedPrompts: [],
		transcript: createConsoleTranscript(),
	};
	let nextQueuedPromptId = 1;
	let started: Promise<void> | undefined;
	let closePromise: Promise<void> | undefined;
	let admissionQueue = Promise.resolve();
	const activeControllers = new Set<AbortController>();
	const inFlight = new Set<Promise<void>>();
	let batchFailed = false;
	let closing = false;

	const publish = (next: Partial<ConsoleSnapshot>, action?: TranscriptAction) => {
		snapshot = {
			...snapshot,
			...next,
			transcript: action ? reduceConsoleTranscript(snapshot.transcript, action) : snapshot.transcript,
		};
		for (const listener of listeners) listener();
	};

	const controller: ConsoleController = {
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		getSnapshot: () => snapshot,
		start() {
			if (started) return started;
			started = start();
			return started;
		},
		submit(message) {
			if (closing) throw new Error('Console is closing.');
			if (options.resource.kind !== 'agent') throw new Error('Workflow consoles are read-only.');
			const queuedPrompt = enqueuePrompt(message);
			return trackExecution(execute({
				kind: 'agent',
				name: options.resource.name,
				instanceId: options.resource.instanceId,
				input: { message },
			}, queuedPrompt));
		},
		close() {
			if (closePromise) return closePromise;
			closing = true;
			closePromise = (async () => {
				publish({ status: 'closing', composerEnabled: false, queuedPrompts: [] }, { type: 'clear-streaming' });
				for (const activeController of activeControllers) activeController.abort();
				await Promise.allSettled([...inFlight]);
				publish({ status: 'closed', active: false });
			})();
			return closePromise;
		},
		forceCloseSync() {
			closing = true;
			for (const activeController of activeControllers) activeController.abort();
		},
	};
	return controller;

	async function start(): Promise<void> {
		if (options.resource.kind === 'agent' && options.initialInput !== undefined) {
			const input = parseAgentInput(options.initialInput);
			const queuedPrompt = enqueuePrompt(input.message);
			await trackExecution(execute({ ...options.resource, input }, queuedPrompt));
		} else if (options.resource.kind === 'workflow') {
			await trackExecution(execute({ ...options.resource, input: options.initialInput }));
		}
	}

	function trackExecution(execution: Promise<void>): Promise<void> {
		if (inFlight.size === 0) batchFailed = false;
		inFlight.add(execution);
		void execution.then(
			() => inFlight.delete(execution),
			() => inFlight.delete(execution),
		);
		return execution;
	}

	function enqueuePrompt(message: string): ConsoleQueuedPrompt {
		const queuedPrompt = { id: nextQueuedPromptId++, message };
		publish({ queuedPrompts: [...snapshot.queuedPrompts, queuedPrompt] });
		return queuedPrompt;
	}

	function removeQueuedPrompt(queuedPrompt: ConsoleQueuedPrompt): readonly ConsoleQueuedPrompt[] {
		return snapshot.queuedPrompts.filter((prompt) => prompt.id !== queuedPrompt.id);
	}

	async function execute(target: ExecutionTarget, queuedPrompt?: ConsoleQueuedPrompt): Promise<void> {
		if (closing) return;
		const activeController = new AbortController();
		activeControllers.add(activeController);
		publish({ status: 'active', active: true, composerEnabled: target.kind === 'agent' });
		let failed = false;
		let promptStarted = false;
		const onEvent = (event: ConversationStreamChunk | FlueEvent): void => {
			if (closing) return;
			const id = !('conversationId' in event) && event.type === 'run_start' ? event.runId : snapshot.id;
			if (queuedPrompt && !promptStarted) {
				promptStarted = true;
				publish(
					{ id, queuedPrompts: removeQueuedPrompt(queuedPrompt) },
					{ type: 'prompt', message: queuedPrompt.message },
				);
				publish({ id }, { type: 'event', event });
				return;
			}
			publish({ id }, { type: 'event', event });
		};
		try {
			const result = target.kind === 'agent'
				? await runAgentTarget(target, onEvent, activeController.signal)
				: await runWorkflowTarget(target, onEvent, activeController.signal);
			if (closing) return;
			if (queuedPrompt && !promptStarted) {
				publish(
					{ queuedPrompts: removeQueuedPrompt(queuedPrompt) },
					{ type: 'prompt', message: queuedPrompt.message },
				);
			}
			const id = result.kind === 'workflow' ? result.runId : snapshot.id;
			publish({ id });
		} catch (error) {
			failed = !activeController.signal.aborted;
			if (failed) batchFailed = true;
			if (!closing && failed) {
				publish(
					queuedPrompt && !promptStarted ? { queuedPrompts: removeQueuedPrompt(queuedPrompt) } : {},
					{ type: 'error', error },
				);
			}
		} finally {
			activeControllers.delete(activeController);
			if (!closing) {
				const active = activeControllers.size > 0;
				publish({
					status: active ? 'active' : batchFailed ? 'failed' : 'completed',
					active,
					composerEnabled: target.kind === 'agent',
				});
			}
		}
	}

	async function runAgentTarget(
		target: Extract<ExecutionTarget, { kind: 'agent' }>,
		onEvent: (event: ConversationStreamChunk | FlueEvent) => void,
		signal: AbortSignal,
	): Promise<{ kind: 'agent'; result: AgentPromptResponse }> {
		const admission = admissionQueue.then(() => {
			signal.throwIfAborted();
			return options.client.agents.send(target.name, target.instanceId, { ...target.input, signal });
		});
		admissionQueue = admission.then(() => undefined, () => undefined);
		const admitted = await admission;
		const result = await options.client.agents.wait<AgentPromptResponse>(admitted, { onEvent, signal });
		return { kind: 'agent', result };
	}

	async function runWorkflowTarget(
		target: Extract<ExecutionTarget, { kind: 'workflow' }>,
		onEvent: (event: ConversationStreamChunk | FlueEvent) => void,
		signal: AbortSignal,
	): Promise<{ kind: 'workflow'; runId: string; result: unknown }> {
		const completed: WorkflowRunResult = await options.client.workflows.run(target.name, {
			input: target.input,
			onEvent,
			signal,
		});
		return { kind: 'workflow', runId: completed.runId, result: completed.result };
	}
}

function parseAgentInput(value: unknown): AgentInput {
	if (!isRecord(value) || typeof value.message !== 'string') {
		throw new TypeError('Agent input must be an object with a string "message" field.');
	}
	const keys = Object.keys(value);
	if (keys.some((key) => key !== 'message' && key !== 'images')) {
		throw new TypeError('Agent input accepts only "message" and optional "images" fields.');
	}
	if (value.images !== undefined && !isAgentImages(value.images)) {
		throw new TypeError('Agent input "images" must be an array of image objects.');
	}
	return value.images === undefined
		? { message: value.message }
		: { message: value.message, images: value.images };
}

function isAgentImages(value: unknown): value is AgentPromptImage[] {
	return Array.isArray(value) && value.every((image) =>
		isRecord(image)
		&& image.type === 'image'
		&& typeof image.data === 'string'
		&& typeof image.mimeType === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
