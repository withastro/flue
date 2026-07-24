/**
 * Native Cloudflare tracing: `instrument(createCloudflareTracing())` in
 * `app.ts` plus `observability.traces.enabled` in wrangler emits
 * `invoke_agent` / `chat` / `execute_tool` spans into Workers Traces, nested
 * under the invocation that owns the agent response (alarm-owned execution
 * makes that invocation real platform work).
 *
 * Span lifetime is split across the two instrumentation seams, opposite to
 * `@flue/opentelemetry`: the *interceptor* opens spans with
 * `tracing.startActiveSpan` — activation must wrap the real work, because
 * parenting is async-context-based and platform sub-spans (provider `fetch`)
 * only nest under a span whose activation callback initiated them — and the
 * *observe* subscriber closes them, because the rich finish data (usage,
 * response model, finish reason) arrives in terminal events that fire after
 * the intercepted promise settles. `startActiveSpan` spans are caller-owned
 * (explicit, idempotent `span.end()`), which is what makes that split legal;
 * a span that never sees its terminal event is force-closed by the platform
 * at invocation end.
 *
 * Platform traces carry conversation content by default — input/output
 * messages, system instructions, tool definitions/arguments/results — via the
 * shared `@flue/runtime/telemetry` pipeline: an optional `transform` is
 * policy, the structural in-band truncation under `CONTENT_BUDGET_BYTES` is
 * physics. `content: false` restores content-free spans. Raw error messages
 * and stacks stay excluded regardless of policy (exception content never
 * ships on this backend) — failures record only a low-cardinality
 * `error.type`. Content projection and serialization run only on sampled
 * spans (`isTraced`).
 *
 * This module is the only runtime importer of `cloudflare:workers` on the
 * `@flue/runtime/cloudflare` entry; keep it out of the coordinator /
 * root-internal module graph, which must stay Node-evaluable.
 */
import * as cloudflareWorkers from 'cloudflare:workers';
import type { FlueExecutionInterceptor } from '../../execution-interceptor.ts';
import type { FlueInstrumentation } from '../../instrumentation.ts';
import type { FlueObservationSubscriber } from '../../observation.ts';
import {
	agentInputMessage,
	agentOutputMessage,
	CONTENT_ATTR,
	type ContentOption,
	contentAttribute,
	type GenAIContentType,
	inputMessages,
	normalizeFinishReason,
	outputMessages,
	systemInstructions,
	toolDefinitions,
} from '../../telemetry/index.ts';
import type { FlueObservation, PromptUsage } from '../../types.ts';
import { ATTR, FLUE_ATTR } from './attributes.ts';

export interface CloudflareTracingOptions {
	/**
	 * `false` opts out of content entirely; `{ transform }` is the policy hook
	 * (redact, drop, reshape, tighten via `truncateContent`); absent means
	 * content on with the safety-net truncation alone.
	 */
	content?: ContentOption;
}

/**
 * Structural view of the Workers tracing runtime. Declared locally (rather
 * than via `@cloudflare/workers-types`) because `startActiveSpan` and
 * `Span.end()` ship ahead of the published type package; the factory probes
 * for them at bind time.
 */
interface PlatformSpan {
	readonly isTraced: boolean;
	setAttribute(key: string, value: string | number | boolean | undefined): void;
	end(): void;
}

interface PlatformTracing {
	startActiveSpan<T>(name: string, callback: (span: PlatformSpan) => T): T;
}

type AttributeValues = Record<string, string | number | boolean | undefined>;

interface PendingSpan {
	name: string;
	/** Deferred so attribute work only happens on sampled invocations. */
	attributes: () => AttributeValues;
	/**
	 * Owning operation, for the operation-end sweep of stranded stashes. The
	 * attribute thunks close over request content (input messages, tool
	 * arguments), so an entry whose interception never happened must not
	 * outlive its operation. Absent for task stashes: their envelope stamps
	 * the child task's id, so the parent operation's key cannot be derived.
	 */
	owner?: string;
}

interface TrackedSpan {
	span: PlatformSpan;
	ended: boolean;
	/** Owning operation, for the operation-end sweep of leaked children. */
	operationKey?: string;
}

const noopSpan: PlatformSpan = {
	isTraced: false,
	setAttribute() {},
	end() {},
};

const noopTracing: PlatformTracing = {
	startActiveSpan(_name, callback) {
		return callback(noopSpan);
	},
};

const CLOUDFLARE_TRACING_INSTRUMENTATION_KEY = Symbol.for('@flue/runtime/cloudflare-tracing');

/**
 * Accessed via the namespace and probed per-method so runtimes that predate
 * the `tracing` export — or its caller-owned `startActiveSpan` — degrade to a
 * no-op tracer instead of failing at module link or first use.
 */
function bindPlatformTracing(): PlatformTracing {
	const exported = (cloudflareWorkers as { tracing?: unknown }).tracing as
		Partial<PlatformTracing> | undefined;
	if (typeof exported?.startActiveSpan !== 'function') return noopTracing;
	return exported as PlatformTracing;
}

export function createCloudflareTracing(
	options: CloudflareTracingOptions = {},
): FlueInstrumentation {
	const platform = bindPlatformTracing();
	const content = options.content;
	const pending = new Map<string, PendingSpan>();
	const active = new Map<string, TrackedSpan>();
	let disposed = false;

	function openSpan<T>(
		key: string,
		span: PendingSpan,
		next: () => Promise<T>,
		owner?: string,
	): Promise<T> {
		pending.delete(key);
		return platform.startActiveSpan(span.name, (opened) => {
			const tracked: TrackedSpan = { span: opened, ended: false, operationKey: owner };
			active.set(key, tracked);
			// Attribute (and content-projection) work only on sampled invocations.
			if (opened.isTraced) writeAttributes(tracked, span.attributes());
			let running: Promise<T>;
			try {
				running = next();
			} catch (error) {
				settleSpan(key, tracked, rejectionAttributes(error));
				throw error;
			}
			return running.then(
				// Success leaves the span open: the terminal observe event carries
				// the finish attributes and ends it.
				(value) => value,
				(error) => {
					settleSpan(key, tracked, rejectionAttributes(error));
					throw error;
				},
			);
		});
	}

	function writeAttributes(tracked: TrackedSpan, attributes: AttributeValues): void {
		if (tracked.ended || !tracked.span.isTraced) return;
		try {
			for (const [key, value] of Object.entries(attributes)) {
				if (value !== undefined) tracked.span.setAttribute(key, value);
			}
		} catch {
			// Drop the attributes; tracing must never alter execution.
		}
	}

	function settleSpan(key: string, tracked: TrackedSpan, attributes?: AttributeValues): void {
		if (tracked.ended) return;
		if (attributes) writeAttributes(tracked, attributes);
		tracked.ended = true;
		try {
			tracked.span.end();
		} catch {}
		active.delete(key);
	}

	function endFromEvent(key: string, attributes: () => AttributeValues): void {
		pending.delete(key);
		const tracked = active.get(key);
		if (!tracked) return;
		// Deferred like the start-side thunks: finish attributes (and the
		// output-content projection) are only built for sampled spans.
		if (!tracked.ended && tracked.span.isTraced) writeAttributes(tracked, attributes());
		settleSpan(key, tracked);
	}

	const observe: FlueObservationSubscriber = (event) => {
		if (disposed) return;
		if (event.type === 'operation_start') {
			if (event.operationKind !== 'prompt' && event.operationKind !== 'skill') return;
			// A prompt inside a task context is the task's own model loop; the
			// task span is its `invoke_agent` — a nested duplicate says nothing.
			if (event.taskId && event.operationKind === 'prompt') return;
			pending.set(operationKey(event), {
				name: spanName('invoke_agent', event.agentName),
				attributes: () => ({
					[ATTR.operationName]: 'invoke_agent',
					[ATTR.agentName]: event.agentName,
					[ATTR.agentId]: event.instanceId,
					[ATTR.conversationId]: event.conversationId,
					[FLUE_ATTR.submissionId]: event.submissionId,
					[FLUE_ATTR.operationKind]: event.operationKind,
				}),
			});
			return;
		}
		if (event.type === 'task_start') {
			pending.set(taskKey(event), {
				name: spanName('invoke_agent', event.agent),
				attributes: () => ({
					[ATTR.operationName]: 'invoke_agent',
					[ATTR.agentName]: event.agent,
					[ATTR.conversationId]: event.conversationId,
					[ATTR.toolCallId]: event.toolCallId,
					[FLUE_ATTR.taskId]: event.taskId,
					...contentEntry(
						content,
						event,
						CONTENT_ATTR.inputMessages,
						() => agentInputMessage(event.agentInput),
						'input_messages',
					),
				}),
			});
			return;
		}
		if (event.type === 'turn_request') {
			const request = event.request;
			pending.set(turnKey(event), {
				name: spanName('chat', request.requestedModel),
				owner: ownerKey(event),
				attributes: () => ({
					[ATTR.operationName]: 'chat',
					[ATTR.providerName]: request.providerName,
					[ATTR.requestModel]: request.requestedModel,
					[ATTR.requestStream]: true,
					[ATTR.conversationId]: event.conversationId,
					[ATTR.reasoningLevel]: request.reasoningLevel,
					[ATTR.maxTokens]: request.maxTokens,
					[ATTR.temperature]: request.temperature,
					...(event.purpose !== 'agent' ? { [FLUE_ATTR.turnPurpose]: event.purpose } : {}),
					...contentEntry(
						content,
						event,
						CONTENT_ATTR.inputMessages,
						() => inputMessages(request.input.messages),
						'input_messages',
					),
					...contentEntry(
						content,
						event,
						CONTENT_ATTR.systemInstructions,
						() => systemInstructions(request.input.systemPrompt),
						'system_instructions',
					),
					...contentEntry(
						content,
						event,
						CONTENT_ATTR.toolDefinitions,
						() => toolDefinitions(request.input.tools),
						'tool_definitions',
					),
				}),
			});
			return;
		}
		if (event.type === 'tool_start') {
			// The framework `task` tool is the task operation's plumbing; the task
			// span covers it.
			if (event.origin === 'framework' && event.toolName === 'task') return;
			// Caller-origin bash is the user's shell operation, not a model tool
			// call — its command line and output stay out of trace content (same
			// exclusion as @flue/opentelemetry).
			const shell = event.origin === 'caller' && event.toolName === 'bash';
			pending.set(toolKey(event), {
				name: spanName('execute_tool', event.toolName),
				owner: ownerKey(event),
				attributes: () => ({
					[ATTR.operationName]: 'execute_tool',
					[ATTR.toolName]: event.toolName,
					[ATTR.toolCallId]: event.toolCallId,
					[ATTR.toolType]: 'function',
					[ATTR.conversationId]: event.conversationId,
					[FLUE_ATTR.toolOrigin]: event.origin,
					...(shell
						? {}
						: {
								...contentEntry(
									content,
									event,
									CONTENT_ATTR.toolDescription,
									() => event.description,
									'tool_description',
									true,
								),
								...toolPayloadEntry(content, event, 'arguments', event.args),
							}),
				}),
			});
			return;
		}
		if (event.type === 'turn') {
			endFromEvent(turnKey(event), () => ({
				[ATTR.responseModel]: event.response.responseModel,
				[ATTR.responseId]: event.response.responseId,
				...(event.response.finishReason
					? { [FLUE_ATTR.finishReason]: normalizeFinishReason(event.response.finishReason) }
					: {}),
				...usageAttributes(event.response.usage),
				...contentEntry(
					content,
					event,
					CONTENT_ATTR.outputMessages,
					() => outputMessages(event.response.output, event.response.finishReason),
					'output_messages',
				),
				...(event.isError ? terminalErrorAttributes(event.response.error?.type) : {}),
			}));
			return;
		}
		if (event.type === 'tool') {
			if (event.origin === 'framework' && event.toolName === 'task') return;
			endFromEvent(toolKey(event), () => ({
				// Results ride only successful completions; errored tools carry the
				// low-cardinality error class and no payload. Caller-origin bash
				// stays content-free (see tool_start).
				...(event.isError || (event.origin === 'caller' && event.toolName === 'bash')
					? {}
					: toolPayloadEntry(
							content,
							event,
							'result',
							Object.hasOwn(event, 'effectiveResult') ? event.effectiveResult : event.result,
						)),
				...(event.isError ? terminalErrorAttributes(event.errorInfo?.type) : {}),
			}));
			return;
		}
		if (event.type === 'task') {
			endFromEvent(taskKey(event), () => ({
				...contentEntry(
					content,
					event,
					CONTENT_ATTR.outputMessages,
					() => agentOutputMessage(event.agentOutput),
					'output_messages',
				),
				...(event.isError ? terminalErrorAttributes(event.errorInfo?.type) : {}),
			}));
			return;
		}
		if (event.type === 'operation') {
			const key = operationKey(event);
			// Children whose terminal event never fired (interrupted turn, torn
			// stream) must not outlive their operation — neither open spans nor
			// stashes stranded between event emission and interception.
			for (const [childKey, tracked] of active) {
				if (childKey !== key && tracked.operationKey === key) settleSpan(childKey, tracked);
			}
			for (const [childKey, stash] of pending) {
				if (stash.owner === key) pending.delete(childKey);
			}
			endFromEvent(key, () => ({
				...usageAttributes(event.usage),
				...(event.operationKind === 'prompt' || event.operationKind === 'skill'
					? {
							...contentEntry(
								content,
								event,
								CONTENT_ATTR.inputMessages,
								() => agentInputMessage(event.agentInput),
								'input_messages',
							),
							...contentEntry(
								content,
								event,
								CONTENT_ATTR.outputMessages,
								() => agentOutputMessage(event.agentOutput),
								'output_messages',
							),
						}
					: {}),
				...(event.isError ? terminalErrorAttributes(event.errorInfo?.type) : {}),
			}));
			return;
		}
	};

	// Same guard the interceptor applies when tagging opened spans, so a
	// stash's owner and its operation's terminal key meet on the same value.
	function ownerKey(event: FlueObservation): string | undefined {
		return event.operationId ? operationKey(event) : undefined;
	}

	const interceptor: FlueExecutionInterceptor = (operation, ctx, next) => {
		if (disposed) return next();
		if (operation.type === 'agent') {
			const key = operationKey({ ...ctx, operationId: operation.operationId });
			const span = pending.get(key);
			// No stash means no `operation_start` preceded this interception: the
			// submission-level wrapper in agent-submissions. The alarm invocation
			// is already the platform root for it — pass through.
			if (!span) return next();
			return openSpan(key, span, next);
		}
		const owner = ctx.operationId ? operationKey(ctx) : undefined;
		if (operation.type === 'model') {
			const key = turnKey({ ...ctx, turnId: operation.turnId });
			// Per-pull re-entries of the provider stream: the span opened at the
			// creation call is still active and covers the whole turn.
			if (active.has(key)) return next();
			const span = pending.get(key);
			if (!span) return next();
			return openSpan(key, span, next, owner);
		}
		if (operation.type === 'tool') {
			const key = toolKey({ ...ctx, toolCallId: operation.toolCallId });
			const span = pending.get(key);
			if (!span) return next();
			return openSpan(key, span, next, owner);
		}
		const key = taskKey({ ...ctx, taskId: operation.taskId });
		const span = pending.get(key);
		if (!span) return next();
		return openSpan(key, span, next, owner);
	};

	return {
		key: CLOUDFLARE_TRACING_INSTRUMENTATION_KEY,
		observe,
		interceptor,
		dispose() {
			if (disposed) return;
			disposed = true;
			for (const [key, tracked] of active) settleSpan(key, tracked);
			active.clear();
			pending.clear();
		},
	};
}

function usageAttributes(usage: PromptUsage | undefined): AttributeValues {
	if (!usage) return {};
	return {
		[ATTR.inputTokens]: usage.input + usage.cacheRead + usage.cacheWrite,
		[ATTR.outputTokens]: usage.output,
		[ATTR.cacheReadTokens]: usage.cacheRead,
		[ATTR.cacheCreationTokens]: usage.cacheWrite,
		[FLUE_ATTR.usageTotalTokens]: usage.totalTokens,
	};
}

/**
 * Failure policy for a rejection observed at the interception boundary:
 * cancellation is a control path (no `error.type`, so aborts don't inflate
 * error rates); everything else records only the low-cardinality error class.
 */
function rejectionAttributes(error: unknown): AttributeValues {
	if (isCancellation(error)) return { [FLUE_ATTR.canceled]: true };
	return {
		[ATTR.errorType]: error instanceof Error ? error.name || 'Error' : typeof error,
	};
}

/** Same policy for the runtime's classified error type on terminal events. */
function terminalErrorAttributes(type: string | undefined): AttributeValues {
	if (type === 'aborted') return { [FLUE_ATTR.canceled]: true };
	return { [ATTR.errorType]: lowCardinality(type) };
}

function isCancellation(error: unknown): boolean {
	return (
		typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError'
	);
}

function lowCardinality(value: string | undefined): string {
	if (!value) return '_OTHER';
	return /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(value) ? value : '_OTHER';
}

/**
 * One content-bearing attribute through the shared pipeline. The producer is
 * lazy so projection work is skipped entirely under `content: false` (and,
 * via the deferred attribute thunks, on unsampled spans).
 */
function contentEntry(
	content: ContentOption | undefined,
	event: FlueObservation,
	name: string,
	produce: () => unknown,
	contentType: GenAIContentType,
	rawString = false,
): AttributeValues {
	if (content === false) return {};
	const result = contentAttribute(content, produce(), event, { contentType, rawString });
	return result.value === undefined ? {} : { [name]: result.value };
}

/**
 * Tool payloads keep the semconv `gen_ai.tool.call.*` keys for plain objects
 * and move to the `flue.tool.call.*` fallback names otherwise, mirroring
 * `@flue/opentelemetry`.
 */
function toolPayloadEntry(
	content: ContentOption | undefined,
	event: FlueObservation,
	kind: 'arguments' | 'result',
	value: unknown,
): AttributeValues {
	if (content === false) return {};
	const result = contentAttribute(content, value, event, {
		contentType: kind === 'arguments' ? 'tool_arguments' : 'tool_result',
		rawString: true,
	});
	if (result.value === undefined) return {};
	const key =
		kind === 'arguments'
			? result.objectShaped
				? CONTENT_ATTR.toolArguments
				: CONTENT_ATTR.toolArgumentsRaw
			: result.objectShaped
				? CONTENT_ATTR.toolResult
				: CONTENT_ATTR.toolResultRaw;
	return { [key]: result.value };
}

/**
 * `"{operation} {target}"`, falling back to the bare operation past the
 * Workers Observability 64-UTF-8-byte span-name budget — the full target
 * stays on its semantic attribute.
 */
function spanName(operation: string, target: string | undefined): string {
	if (!target) return operation;
	const name = `${operation} ${target}`;
	return new TextEncoder().encode(name).length <= 64 ? name : operation;
}

/**
 * Identity keys shared by the interceptor (which builds them from
 * `FlueExecutionContext`) and the observe subscriber (from event fields) —
 * the same scheme `@flue/opentelemetry` uses, so the two sides meet on the
 * same entries even when one isolate hosts several agent instances.
 */
interface ExecutionIdentity {
	instanceId?: string;
	harness?: string;
	conversationId?: string;
	session?: string;
	operationId?: string;
	turnId?: string;
	taskId?: string;
}

function identityKey(kind: string, fields: Array<string | undefined>): string {
	return JSON.stringify([kind, ...fields.map((value) => value ?? null)]);
}

function operationKey(value: ExecutionIdentity): string {
	return identityKey('operation', [
		value.instanceId,
		value.harness,
		value.conversationId,
		value.session,
		value.taskId,
		value.operationId,
	]);
}

function turnKey(value: ExecutionIdentity): string {
	return identityKey('turn', [
		value.instanceId,
		value.harness,
		value.conversationId,
		value.session,
		value.taskId,
		value.operationId,
		value.turnId,
	]);
}

function taskKey(value: ExecutionIdentity): string {
	return identityKey('task', [
		value.instanceId,
		value.harness,
		value.conversationId,
		value.session,
		value.taskId,
	]);
}

function toolKey(value: ExecutionIdentity & { toolCallId?: string }): string {
	return identityKey('tool', [
		value.instanceId,
		value.harness,
		value.conversationId,
		value.session,
		value.taskId,
		value.operationId,
		value.turnId,
		value.toolCallId,
	]);
}
