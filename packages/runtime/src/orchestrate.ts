/**
 * Deterministic multi-agent orchestration primitives for Flue.
 *
 * Inspired by Claude Code Dynamic Workflows. These primitives give you
 * code-driven control over "what runs when" while letting the LLM handle
 * "what to say/do" within each step.
 *
 * Design principles:
 * - Deterministic: orchestration logic is TypeScript, not LLM-generated
 * - Barrier-aware: parallel() waits for all; pipeline() is barrier-free
 * - Fault-tolerant: failed tasks return null by default, never crash the batch
 * - Schema-first: every task can enforce structured output
 * - Observable: phase markers and events for tracing/UI integration
 *
 * @module
 */

import type { FlueSession, PromptResponse, TaskOptions } from './types.ts';
import type * as v from 'valibot';

// ─── Types ──────────────────────────────────────────────────────────────────

/** A single task descriptor for parallel/pipeline execution. */
export interface TaskDescriptor<S extends v.GenericSchema | undefined = undefined> {
	/** The prompt to send to the sub-agent. */
	prompt: string;
	/** Display label for observability (like Claude Code's `label` option). */
	label?: string;
	/** Route to a declared sub-agent profile by name. */
	agent?: string;
	/** Working directory override for the task's sandbox. */
	cwd?: string;
	/** Optional valibot schema for structured result extraction. */
	result?: S;
	/** Override model for this specific task. */
	model?: string;
}

export interface ParallelOptions {
	/**
	 * Maximum number of tasks running concurrently.
	 * Default: 16 (matches Claude Code Workflows limit).
	 */
	concurrency?: number;
	/**
	 * How to handle individual task failures:
	 * - "lenient": failed tasks return null, others continue (default)
	 * - "strict": first failure aborts all remaining tasks
	 */
	failMode?: 'lenient' | 'strict';
	/** AbortSignal to cancel all pending tasks. */
	signal?: AbortSignal;
}

export interface PipelineOptions {
	/**
	 * Maximum items processed concurrently through the full stage sequence.
	 * Default: 16.
	 */
	concurrency?: number;
	/** AbortSignal to cancel processing. */
	signal?: AbortSignal;
}

/** Result from a parallel() or pipeline() execution. */
export type OrchestrationResult = PromptResponse | null;

// ─── Phase ──────────────────────────────────────────────────────────────────

/**
 * Mark a new orchestration phase. Phases are logical groupings for
 * observability — they appear in traces, logs, and any future UI.
 *
 * Equivalent to Claude Code Workflows' `phase(title)`.
 */
export function phase(title: string): void {
	const timestamp = new Date().toISOString();
	console.log(`[orchestrate] ---- ${title} ---- (${timestamp})`);
}

/**
 * Log a narrative message within the current orchestration flow.
 * Equivalent to Claude Code Workflows' `log(msg)`.
 */
export function log(message: string): void {
	console.log(`[orchestrate] ${message}`);
}

// ─── Parallel ───────────────────────────────────────────────────────────────

/**
 * Execute multiple tasks concurrently with barrier semantics.
 * Waits for ALL tasks to complete (or fail) before returning.
 *
 * Failed tasks return `null` in lenient mode (default).
 * In strict mode, the first failure aborts remaining tasks and throws.
 */
export async function parallel(
	session: FlueSession,
	tasks: TaskDescriptor[],
	options?: ParallelOptions,
): Promise<OrchestrationResult[]> {
	const { concurrency = 16, failMode = 'lenient', signal } = options ?? {};

	if (tasks.length === 0) return [];

	const results: OrchestrationResult[] = new Array(tasks.length).fill(null);
	const queue: { task: TaskDescriptor; index: number }[] = tasks.map((task, index) => ({
		task,
		index,
	}));

	const semaphore = new Semaphore(Math.min(concurrency, tasks.length));
	const abortController = new AbortController();
	let firstError: Error | null = null;

	if (signal) {
		signal.addEventListener('abort', () => abortController.abort(signal.reason), { once: true });
		if (signal.aborted) throw new Error('[orchestrate] Aborted before start');
	}

	const promises = queue.map(async ({ task, index }) => {
		await semaphore.acquire();
		if (abortController.signal.aborted) {
			semaphore.release();
			return;
		}

		try {
			const taskOpts: TaskOptions = { signal: abortController.signal };
			if (task.agent) taskOpts.agent = task.agent;
			if (task.cwd) taskOpts.cwd = task.cwd;
			if (task.model) taskOpts.model = task.model;
			if (task.result) (taskOpts as any).result = task.result;

			const result = await session.task(task.prompt, taskOpts);
			results[index] = result;

			if (task.label) log(`[OK] ${task.label}`);
		} catch (err) {
			if (failMode === 'strict' && !firstError) {
				firstError = err instanceof Error ? err : new Error(String(err));
				abortController.abort(firstError);
			}
			results[index] = null;

			if (task.label) {
				log(`[FAIL] ${task.label}: ${err instanceof Error ? err.message : err}`);
			}
		} finally {
			semaphore.release();
		}
	});

	await Promise.all(promises);

	if (failMode === 'strict' && firstError) {
		throw firstError;
	}

	return results;
}

// ─── Workflow Registry ──────────────────────────────────────────────────────

/**
 * A named, reusable workflow that takes the output of the previous stage
 * and returns the input for the next one. Internally it may call
 * session.task(), session.prompt(), or any orchestration primitive.
 */
export type NamedWorkflow = (
	input: PromptResponse,
	session: FlueSession,
) => Promise<PromptResponse>;

const workflowRegistry = new Map<string, NamedWorkflow>();

/**
 * Register a named workflow for later reference in pipeline stages.
 * A registered workflow can be referenced by its string name instead
 * of an inline function.
 *
 * @example
 * ```ts
 * registerWorkflow('analyze-ticket', async (input, session) => {
 *   return session.task(`Analyze: ${input.text}`);
 * });
 * pipeline(session, tickets, ['analyze-ticket', 'verify', 'respond']);
 * ```
 */
export function registerWorkflow(name: string, workflow: NamedWorkflow): void {
	workflowRegistry.set(name, workflow);
}

/**
 * Resolve a registered workflow by name. Throws if not found.
 */
export function resolveWorkflow(name: string): NamedWorkflow {
	const workflow = workflowRegistry.get(name);
	if (!workflow) {
		const registered = [...workflowRegistry.keys()].join(', ');
		throw new Error(
			`[orchestrate] Unknown workflow: "${name}". Registered: [${registered}]`,
		);
	}
	return workflow;
}

/** Returns all registered workflow names. */
export function listWorkflows(): string[] {
	return [...workflowRegistry.keys()];
}

// ─── Pipeline ───────────────────────────────────────────────────────────────

/**
 * A stage that takes the previous result and returns the next task descriptor.
 * Pass a string to invoke a named workflow registered via {@link registerWorkflow}.
 */
export type PipelineStage =
	| ((input: PromptResponse) => TaskDescriptor)
	| string;

/**
 * Process items through a multi-stage pipeline WITHOUT barrier.
 * Each item flows independently through all stages — fast items
 * don't wait for slow ones.
 */
export async function pipeline(
	session: FlueSession,
	items: PromptResponse[],
	stages: PipelineStage[],
	options?: PipelineOptions,
): Promise<OrchestrationResult[]> {
	const { concurrency = 16, signal } = options ?? {};

	if (items.length === 0 || stages.length === 0) return [];
	if (signal?.aborted) throw new Error('[orchestrate] Aborted before start');

	// Eagerly validate all named workflow references.
	for (const stage of stages) {
		if (typeof stage === 'string') resolveWorkflow(stage);
	}

	const semaphore = new Semaphore(Math.min(concurrency, items.length));

	return Promise.all(
		items.map(async (item) => {
			await semaphore.acquire();
			try {
				let current: PromptResponse = item;

				for (const stage of stages) {
					if (signal?.aborted) return null;

					if (typeof stage === 'string') {
						const workflow = resolveWorkflow(stage);
						current = await workflow(current, session);
						continue;
					}

					const descriptor = stage(current);
					const taskOpts: TaskOptions = { signal };
					if (descriptor.agent) taskOpts.agent = descriptor.agent;
					if (descriptor.cwd) taskOpts.cwd = descriptor.cwd;
					if (descriptor.model) taskOpts.model = descriptor.model;
					if (descriptor.result) (taskOpts as any).result = descriptor.result;

					current = await session.task(descriptor.prompt, taskOpts);
				}

				return current;
			} catch {
				return null;
			} finally {
				semaphore.release();
			}
		}),
	);
}

// ─── Semaphore ──────────────────────────────────────────────────────────────

/** Async semaphore for bounding concurrency. */
class Semaphore {
	private waiting: (() => void)[] = [];
	private count: number;

	constructor(max: number) {
		this.count = max;
	}

	async acquire(): Promise<void> {
		if (this.count > 0) {
			this.count--;
			return;
		}
		return new Promise<void>((resolve) => this.waiting.push(resolve));
	}

	release(): void {
		const next = this.waiting.shift();
		if (next) {
			next();
		} else {
			this.count++;
		}
	}
}
