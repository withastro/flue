import type { FlueContextInternal } from '../client.ts';
import type {
	AttachedAgentEvent,
	CreatedAgent,
	DirectAgentPayload,
} from '../types.ts';
import type { DispatchInput } from './dispatch-queue.ts';

export interface DispatchAgentSubmissionInput extends DispatchInput {
	readonly kind: 'dispatch';
	readonly submissionId: string;
}

export interface DirectAgentSubmissionInput {
	readonly kind: 'direct';
	readonly submissionId: string;
	readonly agent: string;
	readonly id: string;
	readonly session: string;
	readonly payload: DirectAgentPayload;
	readonly acceptedAt: string;
}

export type AgentSubmissionInput = DispatchAgentSubmissionInput | DirectAgentSubmissionInput;

export interface AgentSubmissionInterruption {
	readonly submissionId: string;
	readonly kind: AgentSubmissionInput['kind'];
	readonly reason: 'interrupted_before_input_marker' | 'interrupted_after_input_application';
	readonly message: string;
}

export type AgentSubmissionInspection = 'absent' | 'applied' | 'completed' | 'advanced';

export interface ProcessAgentSubmissionOptions {
	onInputApplied?: () => Promise<void> | void;
}

interface AgentSubmissionSession {
	inspectSubmissionInput?(input: AgentSubmissionInput): AgentSubmissionInspection;
	processSubmissionInput?(
		input: AgentSubmissionInput,
		options?: ProcessAgentSubmissionOptions,
	): PromiseLike<unknown>;
	recordSubmissionTerminal?(input: AgentSubmissionInterruption): Promise<void>;
}

type AgentSubmissionHandler = (ctx: FlueContextInternal) => unknown | Promise<unknown>;

interface AgentSubmissionObserver {
	onEvent?: (event: AttachedAgentEvent) => Promise<void> | void;
}

interface AgentSubmissionAttachment {
	readonly completion: Promise<unknown>;
	detach(): void;
}

interface AgentSubmissionObserverRegistry {
	attach(submissionId: string, observer: AgentSubmissionObserver): AgentSubmissionAttachment;
	publish(submissionId: string, event: AttachedAgentEvent): Promise<void>;
	complete(submissionId: string, result: unknown): void;
	fail(submissionId: string, error: unknown): void;
}

export type AttachedAgentSubmissionAdmission = (
	payload: DirectAgentPayload,
	request: Request,
	onEvent?: (event: AttachedAgentEvent) => Promise<void> | void,
) => Promise<unknown>;

export function createDispatchAgentSubmissionInput(input: DispatchInput): DispatchAgentSubmissionInput {
	return { ...input, kind: 'dispatch', submissionId: input.dispatchId };
}

export function createAgentSubmissionHandler(
	agent: CreatedAgent,
	input: AgentSubmissionInput,
	options?: ProcessAgentSubmissionOptions,
): AgentSubmissionHandler {
	return async (ctx) => {
		const session = await openAgentSubmissionSession(ctx, agent, input);
		if (typeof session.processSubmissionInput !== 'function') {
			throw new Error('[flue] Internal session does not support submission input processing.');
		}
		return session.processSubmissionInput(input, options);
	};
}

export function createAgentSubmissionInspectionHandler(
	agent: CreatedAgent,
	input: AgentSubmissionInput,
): AgentSubmissionHandler {
	return async (ctx) => {
		const session = await openAgentSubmissionSession(ctx, agent, input);
		if (typeof session.inspectSubmissionInput !== 'function') {
			throw new Error('[flue] Internal session does not support submission input inspection.');
		}
		return session.inspectSubmissionInput(input);
	};
}

export function createAgentSubmissionTerminalHandler(
	agent: CreatedAgent,
	input: AgentSubmissionInput,
	terminal: AgentSubmissionInterruption,
): AgentSubmissionHandler {
	return async (ctx) => {
		const session = await openAgentSubmissionSession(ctx, agent, input);
		if (typeof session.recordSubmissionTerminal !== 'function') {
			throw new Error('[flue] Internal session does not support submission terminal persistence.');
		}
		await session.recordSubmissionTerminal(terminal);
	};
}

export function agentSubmissionContextPayload(input: AgentSubmissionInput): unknown {
	return input.kind === 'dispatch' ? agentSubmissionDispatchInput(input) : input.payload;
}

export function agentSubmissionInspectionContextPayload(input: AgentSubmissionInput): unknown {
	return input.kind === 'dispatch' ? agentSubmissionDispatchInput(input) : input;
}

export function agentSubmissionDispatchId(input: AgentSubmissionInput): string | undefined {
	return input.kind === 'dispatch' ? input.dispatchId : undefined;
}

export function agentSubmissionDispatchInput(input: DispatchAgentSubmissionInput): DispatchInput {
	const { kind: _kind, submissionId: _submissionId, ...dispatch } = input;
	return dispatch;
}

export function createAgentSubmissionObserverRegistry(): AgentSubmissionObserverRegistry {
	const observers = new Map<
		string,
		Set<AgentSubmissionObserver & { resolve(value: unknown): void; reject(error: unknown): void }>
	>();
	return {
		attach(submissionId, observer) {
			let resolve!: (value: unknown) => void;
			let reject!: (error: unknown) => void;
			const completion = new Promise<unknown>((resolve_, reject_) => {
				resolve = resolve_;
				reject = reject_;
			});
			const attached = { ...observer, resolve, reject };
			const bucket = observers.get(submissionId) ?? new Set();
			bucket.add(attached);
			observers.set(submissionId, bucket);
			return {
				completion,
				detach() {
					bucket.delete(attached);
					if (bucket.size === 0) observers.delete(submissionId);
				},
			};
		},
		async publish(submissionId, event) {
			for (const observer of observers.get(submissionId) ?? []) {
				try {
					await observer.onEvent?.(event);
				} catch {}
			}
		},
		complete(submissionId, result) {
			for (const observer of observers.get(submissionId) ?? []) observer.resolve(result);
			observers.delete(submissionId);
		},
		fail(submissionId, error) {
			for (const observer of observers.get(submissionId) ?? []) observer.reject(error);
			observers.delete(submissionId);
		},
	};
}

async function openAgentSubmissionSession(
	ctx: FlueContextInternal,
	agent: CreatedAgent,
	input: AgentSubmissionInput,
): Promise<AgentSubmissionSession> {
	const harness = await ctx.initializeCreatedAgent(agent, undefined);
	const session = await harness.session(input.session);
	if (!session || typeof session !== 'object') {
		throw new Error('[flue] Internal session is unavailable for submission processing.');
	}
	return session as AgentSubmissionSession;
}
