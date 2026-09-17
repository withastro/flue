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
 * (explicit, idempotent `span.end()`), which is what makes that split legal —
 * and what makes closure a hard obligation: the platform only stores spans
 * explicitly ended inside a live invocation. There is no invocation-end
 * flush, and this adapter's registries pin the span objects, so an entry
 * whose terminal event never lands would otherwise be lost while its
 * already-ended children survive — the one failure that breaks whole-trace
 * assembly downstream. Closure is therefore backstopped at two scopes: an
 * operation's terminal event sweeps children whose own terminal event never
 * fired, and `submission_settled` — emitted while an invocation is still
 * live, from the attempt fiber's settle path or a supervisor pass —
 * force-closes anything the submission leaves behind (operations orphaned by
 * deadline force-settlement or recovery), stamped `flue.span.forced_close`
 * so lost primary closes stay measurable. A fiber that outlives its
 * invocation entirely (isolate replacement, platform teardown mid-run) is
 * beyond in-process repair: spans still open at that boundary cannot be
 * stored, and trace consumers must tolerate the orphaned children.
 *
 * Platform traces carry conversation content by default — input/output
 * messages, system instructions, tool definitions/arguments/results — via the
 * shared `@flue/runtime/telemetry` pipeline: an optional `transform` is
 * policy, the structural in-band truncation is physics. Content draws from
 * one per-span `CONTENT_BUDGET_BYTES` pool (workerd caps a span's *total*
 * attribute bytes and ignores every write after the first overflow), and
 * operational attributes precede content within each write batch, so usage,
 * finish, and error data always land regardless of content size.
 * `content: false` restores content-free spans. Raw error messages
 * and stacks stay excluded regardless of policy (exception content never
 * ships on this backend) — failures record only a low-cardinality
 * `error.type`. Content projection and serialization run only on sampled
 * spans (`isTraced`).
 *
 * This module is the only runtime value-importer of `cloudflare:workers`
 * (reached from the `@flue/runtime/cloudflare` and `cloudflare/internal`
 * entries, which only evaluate inside workerd); keep it out of the
 * coordinator / root-internal module graph, which must stay Node-evaluable.
 */
import * as cloudflareWorkers from 'cloudflare:workers';
import type { FlueExecutionInterceptor } from '../../execution-interceptor.ts';
import { type FlueInstrumentation, hasInstrumentation, instrument } from '../../instrumentation.ts';
import type { FlueObservationSubscriber } from '../../observation.ts';
import {
	agentInputMessage,
	agentOutputMessage,
	CONTENT_ATTR,
	type ContentLedger,
	type ContentOption,
	createContentLedger,
	drawContentAttribute,
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
	/**
	 * Per-span content pool in bytes, defaulting to `CONTENT_BUDGET_BYTES`
	 * (56 KiB, sized to workerd's 64 KiB span-attribute cap). On this backend
	 * it is a tightening control only: workerd's span cap is a platform limit
	 * no setting raises, so a value above the default does not ship fuller
	 * content — the oversized write is silently dropped and can suppress the
	 * usage, finish, and error attributes written after it. Raise the pool on
	 * the OpenTelemetry adapter instead, for a backend without that cap. Must
	 * be at least 128 bytes.
	 */
	contentBudgetBytes?: number;
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
	attributes: (ledger: ContentLedger) => AttributeValues;
	/**
	 * Owning operation, for the operation-end sweep of stranded stashes. The
	 * attribute thunks close over request content (input messages, tool
	 * arguments), so an entry whose interception never happened must not
	 * outlive its operation. Absent for task stashes: their envelope stamps
	 * the child task's id, so the parent operation's key cannot be derived.
	 */
	owner?: string;
	/**
	 * Owning submission, for the settlement sweep. Present on every stash of
	 * submission-scoped work — including task stashes, whose operation owner
	 * cannot be derived — so settlement drops entries no interception claimed.
	 */
	submissionId?: string;
}

interface TrackedSpan {
	span: PlatformSpan;
	ended: boolean;
	/** Shared content pool: start-time and finish-time draws bill one span. */
	ledger: ContentLedger;
	/** Owning operation, for the operation-end sweep of leaked children. */
	operationKey?: string;
	/** Owning submission, for the settlement sweep of orphaned spans. */
	submissionId?: string;
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
			const tracked: TrackedSpan = {
				span: opened,
				ended: false,
				ledger: createContentLedger(options.contentBudgetBytes),
				operationKey: owner,
				submissionId: span.submissionId,
			};
			active.set(key, tracked);
			// Attribute (and content-projection) work only on sampled invocations.
			if (opened.isTraced) writeAttributes(tracked, span.attributes(tracked.ledger));
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
		} catch (error) {
			// A failed end() means the platform will never store this span (the
			// registries pin the object, so no destruction backstop applies) —
			// report it; tracing must never alter execution, but a silent loss
			// here is undiagnosable downstream.
			console.error('[flue:tracing] Failed to end span:', error);
		}
		active.delete(key);
	}

	function endFromEvent(key: string, attributes: (ledger: ContentLedger) => AttributeValues): void {
		pending.delete(key);
		const tracked = active.get(key);
		if (!tracked) return;
		// Deferred like the start-side thunks: finish attributes (and the
		// output-content projection) are only built for sampled spans.
		if (!tracked.ended && tracked.span.isTraced)
			writeAttributes(tracked, attributes(tracked.ledger));
		settleSpan(key, tracked);
	}

	/**
	 * A coordinator recovery/reconciliation failure, recorded as a zero-width
	 * span event on the ambient platform span — the drain runs inside an
	 * alarm invocation Workers Traces already sees, so this nests under that
	 * invocation without opening a new root trace. Same posture as every
	 * other failure this adapter records: only the low-cardinality
	 * `error.type` travels, never a raw message or stack.
	 *
	 * The span name is the bare operation, `submission_recovery`, with no
	 * suffix. The semconv agent-spans grammar (`{operation} {variable-name}`)
	 * reserves that suffix slot for an entity name (agent/workflow/tool) —
	 * "when gen_ai.agent.name is not available, [the name] SHOULD be
	 * `invoke_agent`" — not for a sub-operation discriminator. `event.operation`
	 * already rides `FLUE_ATTR.recoveryOperation`, the attribute the spec
	 * intends for it; folding it into the name would fragment the aggregation
	 * axis into six span names instead of one.
	 */
	function recordRecoveryEvent(
		event: Extract<FlueObservation, { type: 'submission_recovery' }>,
	): void {
		platform.startActiveSpan('submission_recovery', (span) => {
			writeAttributes(
				{ span, ended: false, ledger: createContentLedger(options.contentBudgetBytes) },
				{
					[FLUE_ATTR.submissionId]: event.submissionId,
					[FLUE_ATTR.recoveryOperation]: event.operation,
					[FLUE_ATTR.recoveryOutcome]: event.outcome,
					...(event.errorInfo ? { [ATTR.errorType]: lowCardinality(event.errorInfo.type) } : {}),
				},
			);
			span.end();
		});
	}

	const observe: FlueObservationSubscriber = (event) => {
		if (disposed) return;
		if (event.type === 'submission_recovery') {
			recordRecoveryEvent(event);
			return;
		}
		if (event.type === 'submission_settled') {
			// The settlement backstop: by settle time every span the submission
			// produced has been closed by its terminal event, so anything still
			// open or stashed belongs to work whose terminal event will never
			// arrive — an operation orphaned by deadline force-settlement or
			// recovery. Settlement is emitted while an invocation is live (the
			// attempt fiber's settle path, or a supervisor pass), which is the
			// last moment the platform can still store the span; without this
			// close the run's root would vanish while its ended children
			// survive, breaking whole-trace assembly downstream.
			let swept = 0;
			for (const [key, tracked] of active) {
				if (tracked.submissionId !== event.submissionId) continue;
				settleSpan(key, tracked, { [FLUE_ATTR.forcedClose]: 'settlement' });
				swept++;
			}
			for (const [key, stash] of pending) {
				if (stash.submissionId === event.submissionId) pending.delete(key);
			}
			if (swept > 0) {
				console.warn(
					`[flue:tracing] Submission ${event.submissionId} settled with ${swept} span(s) still open — force-closed.`,
				);
			}
			return;
		}
		if (event.type === 'operation_start') {
			if (event.operationKind !== 'prompt' && event.operationKind !== 'skill') return;
			// A prompt inside a task context is the task's own model loop; the
			// task span is its `invoke_agent` — a nested duplicate says nothing.
			if (event.taskId && event.operationKind === 'prompt') return;
			pending.set(operationKey(event), {
				name: spanName('invoke_agent', event.agentName),
				submissionId: event.submissionId,
				attributes: () => ({
					[ATTR.operationName]: 'invoke_agent',
					[ATTR.agentName]: event.agentName,
					[FLUE_ATTR.instanceId]: event.instanceId,
					[ATTR.conversationId]: event.conversationId,
					[FLUE_ATTR.submissionId]: event.submissionId,
					[FLUE_ATTR.operationId]: event.operationId,
					[FLUE_ATTR.operationKind]: event.operationKind,
				}),
			});
			return;
		}
		if (event.type === 'task_start') {
			pending.set(taskKey(event), {
				name: spanName('invoke_agent', event.agent),
				submissionId: event.submissionId,
				attributes: (ledger) => ({
					[ATTR.operationName]: 'invoke_agent',
					[ATTR.agentName]: event.agent,
					[ATTR.conversationId]: event.conversationId,
					[ATTR.toolCallId]: event.toolCallId,
					[FLUE_ATTR.submissionId]: event.submissionId,
					[FLUE_ATTR.operationId]: event.operationId,
					[FLUE_ATTR.taskId]: event.taskId,
					...contentEntry(
						ledger,
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
				submissionId: event.submissionId,
				attributes: (ledger) => ({
					[ATTR.operationName]: 'chat',
					[ATTR.providerName]: request.providerName,
					[ATTR.requestModel]: request.requestedModel,
					[ATTR.requestStream]: true,
					// Not in the semconv inference-span table (agent linkage there
					// is structural, via the parent invoke_agent) — recorded here
					// so backends can aggregate the span's token usage by agent
					// without span stitching; the registry attribute keeps its
					// registered meaning. Ecosystem precedent: OpenLLMetry stamps
					// agent context on LLM-call spans the same way (#535).
					[ATTR.agentName]: event.agentName,
					[ATTR.conversationId]: event.conversationId,
					[FLUE_ATTR.submissionId]: event.submissionId,
					[FLUE_ATTR.operationId]: event.operationId,
					[FLUE_ATTR.turnId]: event.turnId,
					[ATTR.reasoningLevel]: request.reasoningLevel,
					[ATTR.maxTokens]: request.maxTokens,
					[ATTR.temperature]: request.temperature,
					[ATTR.serverAddress]: request.serverAddress,
					[ATTR.serverPort]: request.serverPort,
					// `true | undefined` by construction — the semconv says never
					// to record `false`, and the undefined-skip in the writer
					// keeps that shape.
					[ATTR.compacted]: request.contextCompacted,
					...openaiAttributes(request.providerName, request.api),
					...(event.purpose !== 'agent' ? { [FLUE_ATTR.turnPurpose]: event.purpose } : {}),
					...contentEntry(
						ledger,
						content,
						event,
						CONTENT_ATTR.inputMessages,
						() => inputMessages(request.input.messages),
						'input_messages',
					),
					...contentEntry(
						ledger,
						content,
						event,
						CONTENT_ATTR.systemInstructions,
						() => systemInstructions(request.input.systemPrompt),
						'system_instructions',
					),
					...contentEntry(
						ledger,
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
			// call: `execute_tool` (and the `gen_ai.tool.*` attributes) describe
			// tools the framework runs on behalf of the model, so claiming them
			// here would pollute that aggregation axis. It gets the same
			// flue-owned span `@flue/opentelemetry` emits for this event — no
			// `gen_ai.*` claims — and its command line and output stay out of
			// trace content.
			if (event.origin === 'caller' && event.toolName === 'bash') {
				pending.set(toolKey(event), {
					name: 'flue.operation shell',
					owner: ownerKey(event),
					submissionId: event.submissionId,
					attributes: () => ({
						[FLUE_ATTR.submissionId]: event.submissionId,
						[FLUE_ATTR.operationId]: event.operationId,
						[FLUE_ATTR.toolOrigin]: event.origin,
					}),
				});
				return;
			}
			pending.set(toolKey(event), {
				name: spanName('execute_tool', event.toolName),
				owner: ownerKey(event),
				submissionId: event.submissionId,
				attributes: (ledger) => ({
					[ATTR.operationName]: 'execute_tool',
					[ATTR.toolName]: event.toolName,
					[ATTR.toolCallId]: event.toolCallId,
					[ATTR.toolType]: 'function',
					// Conditionally required on execute_tool spans: the agent the
					// tool runs on behalf of.
					[ATTR.agentName]: event.agentName,
					[ATTR.conversationId]: event.conversationId,
					[FLUE_ATTR.submissionId]: event.submissionId,
					[FLUE_ATTR.operationId]: event.operationId,
					[FLUE_ATTR.turnId]: event.turnId,
					[FLUE_ATTR.toolOrigin]: event.origin,
					...contentEntry(
						ledger,
						content,
						event,
						CONTENT_ATTR.toolDescription,
						() => event.description,
						'tool_description',
						true,
					),
					...toolPayloadEntry(ledger, content, event, 'arguments', event.args),
				}),
			});
			return;
		}
		if (event.type === 'turn') {
			// Operational attributes precede content within the batch: write order
			// is workerd charge order, so content absorbs any budget overflow.
			endFromEvent(turnKey(event), (ledger) => ({
				[ATTR.responseModel]: event.response.responseModel,
				[ATTR.responseId]: event.response.responseId,
				...(event.response.finishReason
					? { [FLUE_ATTR.finishReason]: normalizeFinishReason(event.response.finishReason) }
					: {}),
				...usageAttributes(event.response.usage),
				...(event.isError ? terminalErrorAttributes(event.response.error?.type) : {}),
				...contentEntry(
					ledger,
					content,
					event,
					CONTENT_ATTR.outputMessages,
					() => outputMessages(event.response.output, event.response.finishReason),
					'output_messages',
				),
			}));
			return;
		}
		if (event.type === 'tool') {
			if (event.origin === 'framework' && event.toolName === 'task') return;
			endFromEvent(toolKey(event), (ledger) => ({
				...(event.isError ? terminalErrorAttributes(event.errorInfo?.type) : {}),
				// Results ride only successful completions; errored tools carry the
				// low-cardinality error class and no payload. Caller-origin bash
				// stays content-free (see tool_start).
				...(event.isError || (event.origin === 'caller' && event.toolName === 'bash')
					? {}
					: toolPayloadEntry(
							ledger,
							content,
							event,
							'result',
							Object.hasOwn(event, 'effectiveResult') ? event.effectiveResult : event.result,
						)),
			}));
			return;
		}
		if (event.type === 'task') {
			endFromEvent(taskKey(event), (ledger) => ({
				...(event.isError ? terminalErrorAttributes(event.errorInfo?.type) : {}),
				...contentEntry(
					ledger,
					content,
					event,
					CONTENT_ATTR.outputMessages,
					() => agentOutputMessage(event.agentOutput),
					'output_messages',
				),
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
			endFromEvent(key, (ledger) => ({
				...usageAttributes(event.usage),
				...(event.isError ? terminalErrorAttributes(event.errorInfo?.type) : {}),
				...(event.operationKind === 'prompt' || event.operationKind === 'skill'
					? {
							...contentEntry(
								ledger,
								content,
								event,
								CONTENT_ATTR.inputMessages,
								() => agentInputMessage(event.agentInput),
								'input_messages',
							),
							...contentEntry(
								ledger,
								content,
								event,
								CONTENT_ATTR.outputMessages,
								() => agentOutputMessage(event.agentOutput),
								'output_messages',
							),
						}
					: {}),
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
		if (operation.type === 'coordinator') {
			// Framework bookkeeping around agent invocations, spanned so the
			// platform's auto-instrumented storage/RPC calls group under it
			// instead of landing as unparented siblings of invoke_agent. The
			// span is wholly interception-scoped (opened here, ended when the
			// work settles) — no terminal observe event owes it attributes —
			// and the coordinator starts attempt fibers only after this
			// interception returns, so the semconv spans never nest under it.
			// One stable span name; phases distinguish by attribute so views
			// keyed on the name survive new phases.
			return platform.startActiveSpan('flue.coordinator', (opened) => {
				const tracked: TrackedSpan = {
					span: opened,
					ended: false,
					ledger: createContentLedger(options.contentBudgetBytes),
				};
				if (opened.isTraced) {
					writeAttributes(tracked, {
						[FLUE_ATTR.coordinatorPhase]: operation.phase,
						[FLUE_ATTR.instanceId]: ctx.instanceId,
						'flue.agent.name': ctx.agentName,
					});
				}
				return next().finally(() => {
					tracked.ended = true;
					try {
						opened.end();
					} catch {}
				});
			});
		}
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

/**
 * Install default-options Cloudflare tracing unless the application already
 * installed its own. Called by the generated Worker entry, whose body
 * evaluates after the user's hoisted `app.ts` imports — an explicit
 * `instrument(createCloudflareTracing(...))` in user module scope therefore
 * always registers first and wins (same evaluation-order contract as the
 * entry's Workers-AI provider guard). Applications never call this: to
 * customize, install the adapter yourself; to suppress the default entirely,
 * set `tracing: false` in `flue.config.ts`, which drops the call from the
 * generated entry. The install is a platform no-op until Workers Traces is
 * enabled on the account (wrangler `observability.traces` or the dashboard).
 *
 * Returns the installed default's disposer, or `undefined` when it yielded.
 */
export function installDefaultCloudflareTracing(): (() => Promise<void>) | undefined {
	if (hasInstrumentation(CLOUDFLARE_TRACING_INSTRUMENTATION_KEY)) return undefined;
	return instrument(createCloudflareTracing());
}

/**
 * `openai.api.type` distinguishes the Chat Completions and Responses
 * surfaces, same mapping as `@flue/opentelemetry`.
 */
function openaiAttributes(providerName: string, api: string): AttributeValues {
	if (providerName !== 'openai') return {};
	if (api === 'openai-completions') return { [ATTR.openaiApiType]: 'chat_completions' };
	if (api === 'openai-responses' || api === 'azure-openai-responses') {
		return { [ATTR.openaiApiType]: 'responses' };
	}
	return {};
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
 * One content-bearing attribute drawn from the span's pool. The producer is
 * lazy so projection work is skipped entirely under `content: false` (and,
 * via the deferred attribute thunks, on unsampled spans).
 */
function contentEntry(
	ledger: ContentLedger,
	content: ContentOption | undefined,
	event: FlueObservation,
	name: string,
	produce: () => unknown,
	contentType: GenAIContentType,
	rawString = false,
): AttributeValues {
	const result = drawContentAttribute(ledger, content, produce, event, {
		key: name,
		contentType,
		rawString,
	});
	return result.value === undefined ? {} : { [name]: result.value };
}

/**
 * Tool payloads keep the semconv `gen_ai.tool.call.*` keys for plain objects
 * and move to the `flue.tool.call.*` fallback names otherwise, mirroring
 * `@flue/opentelemetry`. The draw is charged under the semconv key; the raw
 * fallback differs by a few bytes, well inside the pool's slack.
 */
function toolPayloadEntry(
	ledger: ContentLedger,
	content: ContentOption | undefined,
	event: FlueObservation,
	kind: 'arguments' | 'result',
	value: unknown,
): AttributeValues {
	const result = drawContentAttribute(ledger, content, () => value, event, {
		key: kind === 'arguments' ? CONTENT_ATTR.toolArguments : CONTENT_ATTR.toolResult,
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
