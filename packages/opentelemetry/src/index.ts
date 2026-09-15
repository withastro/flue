import type {
	FlueEventContext,
	FlueExecutionContext,
	FlueExecutionInterceptor,
	FlueObservation,
	FlueObservationSubscriber,
	PromptUsage,
} from '@flue/runtime';
import {
	agentInputMessage,
	agentOutputMessage,
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
} from '@flue/runtime/telemetry';
import {
	type Attributes,
	type Context,
	context,
	type Exception,
	type Meter,
	metrics,
	propagation,
	type Span,
	SpanKind,
	SpanStatusCode,
	type Tracer,
	trace,
} from '@opentelemetry/api';
import { emitInferenceException, emitSubmissionRecovery, type GenAILogger } from './logs.ts';
import { createGenAIMetrics, recordTokenUsage } from './metrics.ts';
import { ATTR } from './semconv.ts';

export type {
	ContentOption,
	ContentTransform,
	GenAIContentScope,
	GenAIContentType,
} from '@flue/runtime/telemetry';
export {
	CONTENT_BUDGET_BYTES,
	OUTPUT_CONTENT_RESERVE_BYTES,
	truncateContent,
} from '@flue/runtime/telemetry';
export {
	FLUE_TELEMETRY_EXTENSION_REVISION,
	GEN_AI_PROJECTION_REVISION,
	GEN_AI_SEMCONV_REVISION,
} from './semconv.ts';

export interface OpenTelemetryInstrumentationOptions {
	tracer?: Tracer;
	meter?: Meter;
	logger?: GenAILogger;
	/**
	 * `false` opts out of content entirely; `{ transform }` is the policy hook
	 * (redact, drop, reshape, tighten via `truncateContent`, side-effect for
	 * external delivery with `scope.traceId`/`scope.spanId`); absent means
	 * content on with the safety-net truncation alone — all content a span
	 * carries draws from one shared `CONTENT_BUDGET_BYTES` pool. Exception
	 * message/stack flow through the same gate and the same pool.
	 */
	content?: ContentOption;
	resolveRootContext?: (event: FlueObservation, ctx: FlueEventContext) => Context | undefined;
}

const OPEN_TELEMETRY_INSTRUMENTATION_KEY = Symbol.for('@flue/opentelemetry');

export interface OpenTelemetryInstrumentation {
	key: symbol;
	observe: FlueObservationSubscriber;
	interceptor: FlueExecutionInterceptor;
	dispose(): void;
}

export function createOpenTelemetryInstrumentation(
	options: OpenTelemetryInstrumentationOptions = {},
): OpenTelemetryInstrumentation {
	// No schemaUrl: the GenAI semconv repo has not published one (see
	// GEN_AI_SEMCONV_REVISION for the pinned upstream revision instead).
	const tracer = options.tracer ?? trace.getTracerProvider().getTracer('@flue/opentelemetry');
	const meter = options.meter ?? metrics.getMeter('@flue/opentelemetry');
	const instruments = createGenAIMetrics(meter);
	const operations = new Map<string, TrackedSpan>();
	const turns = new Map<string, TrackedSpan>();
	const tools = new Map<string, TrackedSpan>();
	const tasks = new Map<string, TrackedSpan>();
	const compactions = new Map<string, TrackedSpan>();
	let disposed = false;

	const observe: FlueObservationSubscriber = (event, ctx) => {
		if (disposed) return;
		if (event.type === 'submission_recovery') {
			// No span: recovery happens outside any intercepted execution, so
			// there is nothing live to attach one to.
			recordSignal(() =>
				emitSubmissionRecovery(options.logger, {
					...(event.submissionId ? { 'flue.submission.id': event.submissionId } : {}),
					'flue.recovery.operation': event.operation,
					'flue.recovery.outcome': event.outcome,
					...(event.errorInfo ? { [ATTR.errorType]: metricErrorType(event.errorInfo.type) } : {}),
				}),
			);
			return;
		}
		const time = new Date(event.timestamp);
		if (event.type === 'operation_start') {
			if (event.operationKind === 'shell') return;
			if (event.taskId && event.operationKind === 'prompt' && tasks.has(taskKey(event))) return;
			const parent = parentSpan(event, operations, tasks);
			const isAgent = event.operationKind === 'prompt' || event.operationKind === 'skill';
			const name = isAgent
				? event.agentName
					? `invoke_agent ${event.agentName}`
					: 'invoke_agent'
				: `flue.operation ${event.operationKind}`;
			const span = startSpan(tracer, name, parent, event, ctx, options, SpanKind.INTERNAL, {
				...identifiers(event),
				...(isAgent ? { [ATTR.operationName]: 'invoke_agent' } : {}),
				...(isAgent && event.agentName ? { [ATTR.agentName]: event.agentName } : {}),
				...(isAgent && event.conversationId ? { [ATTR.conversationId]: event.conversationId } : {}),
				'flue.operation.kind': event.operationKind,
			});
			operations.set(operationKey(event), trackedSpan(span, event));
			return;
		}
		if (event.type === 'task_start') {
			const parent = parentSpan(event, operations, tasks);
			const span = startSpan(
				tracer,
				event.agent ? `invoke_agent ${event.agent}` : 'invoke_agent',
				parent,
				event,
				ctx,
				options,
				SpanKind.INTERNAL,
				{
					...identifiers(event),
					[ATTR.operationName]: 'invoke_agent',
					...('toolCallId' in event && typeof event.toolCallId === 'string'
						? { [ATTR.toolCallId]: event.toolCallId }
						: {}),
					...(event.agent ? { [ATTR.agentName]: event.agent } : {}),
					...(event.conversationId ? { [ATTR.conversationId]: event.conversationId } : {}),
				},
			);
			const tracked = trackedSpan(span, event);
			setContent(
				tracked,
				ATTR.inputMessages,
				agentInputMessage(event.agentInput),
				event,
				options.content,
				'input_messages',
			);
			tasks.set(taskKey(event), tracked);
			return;
		}
		if (event.type === 'compaction_start') {
			compactions.set(
				compactionKey(event),
				trackedSpan(
					startSpan(
						tracer,
						'flue.compaction',
						parentSpan(event, operations, tasks),
						event,
						ctx,
						options,
						SpanKind.INTERNAL,
						{
							...identifiers(event),
							'flue.compaction.reason': event.reason,
						},
					),
					event,
				),
			);
			return;
		}
		if (event.type === 'turn_request') {
			const request = event.request;
			const span = startSpan(
				tracer,
				`chat ${request.requestedModel}`,
				event.purpose === 'agent'
					? parentSpan(event, operations, tasks)
					: compactions.get(compactionKey(event))?.span,
				event,
				ctx,
				options,
				SpanKind.CLIENT,
				{
					...identifiers(event),
					[ATTR.operationName]: 'chat',
					[ATTR.providerName]: request.providerName,
					[ATTR.requestModel]: request.requestedModel,
					[ATTR.requestStream]: true,
					// Not in the semconv inference-span table (agent linkage there
					// is structural, via the parent invoke_agent) — recorded here
					// so backends can aggregate the span's token usage by agent
					// without span stitching (#535).
					...(event.agentName ? { [ATTR.agentName]: event.agentName } : {}),
					...(event.conversationId ? { [ATTR.conversationId]: event.conversationId } : {}),
					...(request.reasoningLevel ? { [ATTR.reasoningLevel]: request.reasoningLevel } : {}),
					...(request.maxTokens !== undefined ? { [ATTR.maxTokens]: request.maxTokens } : {}),
					...(request.temperature !== undefined ? { [ATTR.temperature]: request.temperature } : {}),
					...(request.serverAddress ? { [ATTR.serverAddress]: request.serverAddress } : {}),
					...(request.serverPort !== undefined ? { [ATTR.serverPort]: request.serverPort } : {}),
					...(request.contextCompacted ? { [ATTR.compacted]: true } : {}),
					...openaiAttributes(request.providerName, request.api),
					'flue.turn.purpose': event.purpose,
				},
			);
			const tracked: TrackedSpan = {
				...trackedSpan(span, event),
				clientAttributes: {
					[ATTR.operationName]: 'chat',
					[ATTR.providerName]: request.providerName,
					[ATTR.requestModel]: request.requestedModel,
					...(request.serverAddress ? { [ATTR.serverAddress]: request.serverAddress } : {}),
					...(request.serverPort !== undefined ? { [ATTR.serverPort]: request.serverPort } : {}),
				},
			};
			setContent(
				tracked,
				ATTR.inputMessages,
				inputMessages(request.input.messages),
				event,
				options.content,
				'input_messages',
			);
			setContent(
				tracked,
				ATTR.systemInstructions,
				systemInstructions(request.input.systemPrompt),
				event,
				options.content,
				'system_instructions',
			);
			setContent(
				tracked,
				ATTR.toolDefinitions,
				toolDefinitions(request.input.tools),
				event,
				options.content,
				'tool_definitions',
			);
			turns.set(turnKey(event), tracked);
			return;
		}
		if (event.type === 'tool_start') {
			if (event.origin === 'framework' && event.toolName === 'task') return;
			if (tools.has(toolKey(event))) return;
			const shell = event.origin === 'caller' && event.toolName === 'bash';
			const span = startSpan(
				tracer,
				shell ? 'flue.operation shell' : `execute_tool ${event.toolName}`,
				parentSpan(event, operations, tasks),
				event,
				ctx,
				options,
				SpanKind.INTERNAL,
				{
					...identifiers(event),
					...(shell ? {} : { [ATTR.operationName]: 'execute_tool' }),
					...(shell ? {} : { [ATTR.toolName]: event.toolName }),
					...(shell ? {} : { [ATTR.toolCallId]: event.toolCallId }),
					...(shell ? {} : { [ATTR.toolType]: 'function' }),
					// Conditionally required on execute_tool spans: the agent the
					// tool runs on behalf of.
					...(!shell && event.agentName ? { [ATTR.agentName]: event.agentName } : {}),
					...(!shell && event.conversationId
						? { [ATTR.conversationId]: event.conversationId }
						: {}),
					...(event.origin ? { 'flue.tool.origin': event.origin } : {}),
				},
			);
			const tracked = trackedSpan(span, event);
			if (!shell) {
				setContent(
					tracked,
					ATTR.toolDescription,
					event.description,
					event,
					options.content,
					'tool_description',
					true,
				);
				setToolContent(tracked, 'arguments', event.args, event, options.content);
			}
			tools.set(toolKey(event), tracked);
			return;
		}
		if (event.type === 'turn') {
			const key = turnKey(event);
			const tracked = turns.get(key);
			if (!tracked) return;
			const span = tracked.span;
			const finishReason = event.response.finishReason;
			span.setAttributes({
				...(event.response.responseModel
					? { [ATTR.responseModel]: event.response.responseModel }
					: {}),
				...(event.response.responseId ? { [ATTR.responseId]: event.response.responseId } : {}),
				...(finishReason ? { [ATTR.finishReasons]: [normalizeFinishReason(finishReason)] } : {}),
				...usageAttributes(event.response.usage),
			});
			setContent(
				tracked,
				ATTR.outputMessages,
				outputMessages(event.response.output, finishReason),
				event,
				options.content,
				'output_messages',
			);
			const metricAttributes = {
				...tracked.clientAttributes,
				...(event.response.responseModel
					? { [ATTR.responseModel]: event.response.responseModel }
					: {}),
			};
			recordSignal(() => {
				instruments.clientDuration.record(event.durationMs / 1000, {
					...metricAttributes,
					...(event.isError
						? { [ATTR.errorType]: metricErrorType(event.response.error?.type) }
						: {}),
				});
				if (event.response.usage) {
					recordTokenUsage(
						instruments,
						event.response.usage.input +
							event.response.usage.cacheRead +
							event.response.usage.cacheWrite,
						event.response.usage.output,
						metricAttributes,
					);
				}
			});
			const exception = event.isError
				? exceptionAttributes(
						event.response.error?.type,
						event.response.error,
						event,
						span,
						options,
						tracked.ledger,
					)
				: undefined;
			// The exception event requires `exception.type` or `exception.message`;
			// with neither (no class name, content off), `error.type` on the span
			// and metrics is the whole failure record.
			if (exception && hasExceptionContent(exception))
				recordSignal(() =>
					emitInferenceException(options.logger, {
						...metricAttributes,
						...exception,
					}),
				);
			complete(
				span,
				exception ? { type: event.response.error?.type, attributes: exception } : undefined,
				time,
			);

			turns.delete(key);
			return;
		}
		if (event.type === 'tool') {
			if (event.origin === 'framework' && event.toolName === 'task') return;
			const tracked = tools.get(toolKey(event));
			if (!tracked) return;
			const span = tracked.span;
			if (event.origin !== 'caller' || event.toolName !== 'bash') {
				recordSignal(() =>
					instruments.toolDuration.record(event.durationMs / 1000, {
						[ATTR.toolName]: event.toolName,
						[ATTR.toolType]: 'function',
						...(event.agentName ? { [ATTR.agentName]: event.agentName } : {}),
						...(event.isError ? { [ATTR.errorType]: metricErrorType(event.errorInfo?.type) } : {}),
					}),
				);
			}
			if (!event.isError && (event.origin !== 'caller' || event.toolName !== 'bash')) {
				setToolContent(
					tracked,
					'result',
					Object.hasOwn(event, 'effectiveResult') ? event.effectiveResult : event.result,
					event,
					options.content,
				);
			}
			// Prefer the runtime's classified error — on error, event.result
			// is the model-facing content array, which has no message to extract.
			// The errorInfo object also carries the throw-site stack.
			complete(
				span,
				event.isError
					? {
							type: event.errorInfo?.type,
							value: event.errorInfo ?? event.result,
							event,
							options,
							ledger: tracked.ledger,
						}
					: undefined,
				time,
			);
			tools.delete(toolKey(event));
			return;
		}
		if (event.type === 'task') {
			const key = taskKey(event);
			const tracked = tasks.get(key);
			if (tracked) {
				setContent(
					tracked,
					ATTR.outputMessages,
					agentOutputMessage(event.agentOutput),
					event,
					options.content,
					'output_messages',
				);
				recordSignal(() =>
					instruments.agentDuration.record(event.durationMs / 1000, {
						...(event.agent ? { [ATTR.agentName]: event.agent } : {}),
						...(event.isError ? { [ATTR.errorType]: metricErrorType(event.errorInfo?.type) } : {}),
					}),
				);
			}
			endSpan(
				tasks,
				key,
				event.isError,
				event.errorInfo?.type,
				event.errorInfo ?? event.result,
				time,
				event,
				options,
			);
			return;
		}
		if (event.type === 'compaction') {
			endSpan(
				compactions,
				compactionKey(event),
				event.isError,
				event.errorInfo?.type,
				event.errorInfo ?? event.error,
				time,
				event,
				options,
			);
			return;
		}
		if (event.type === 'operation') {
			endDescendants(event, turns, tools, tasks, compactions, time);
			const key = operationKey(event);
			const tracked = operations.get(key);
			const span = tracked?.span;
			if (span && event.usage) span.setAttributes(usageAttributes(event.usage));
			if (tracked && (event.operationKind === 'prompt' || event.operationKind === 'skill')) {
				setContent(
					tracked,
					ATTR.inputMessages,
					agentInputMessage(event.agentInput),
					event,
					options.content,
					'input_messages',
				);
				setContent(
					tracked,
					ATTR.outputMessages,
					agentOutputMessage(event.agentOutput),
					event,
					options.content,
					'output_messages',
				);
			}
			if (span && (event.operationKind === 'prompt' || event.operationKind === 'skill')) {
				recordSignal(() =>
					instruments.agentDuration.record(event.durationMs / 1000, {
						...(event.agentName ? { [ATTR.agentName]: event.agentName } : {}),
						...(event.isError ? { [ATTR.errorType]: metricErrorType(event.errorInfo?.type) } : {}),
					}),
				);
			}
			endSpan(
				operations,
				key,
				event.isError,
				event.errorInfo?.type,
				event.errorInfo ?? event.error,
				time,
				event,
				options,
			);
		}
	};

	const interceptor: FlueExecutionInterceptor = (operation, executionContext, next) => {
		if (operation.type === 'coordinator') {
			// Framework bookkeeping around agent invocations: an internal span
			// activated in context so auto-instrumented storage/RPC calls group
			// under it instead of landing as unparented siblings of
			// invoke_agent. Wholly interception-scoped — no observe event owes
			// it attributes — and the coordinator starts attempt fibers only
			// after this interception returns, so the semconv spans never nest
			// under it. One stable span name; phases distinguish by attribute.
			const span = tracer.startSpan(
				'flue.coordinator',
				{
					kind: SpanKind.INTERNAL,
					attributes: {
						'flue.coordinator.phase': operation.phase,
						...(executionContext.instanceId
							? { 'flue.instance.id': executionContext.instanceId }
							: {}),
						...(executionContext.agentName
							? { 'flue.agent.name': executionContext.agentName }
							: {}),
					},
				},
				context.active(),
			);
			return context.with(trace.setSpan(context.active(), span), next).then(
				(value) => {
					span.end();
					return value;
				},
				(error: unknown) => {
					span.setStatus({ code: SpanStatusCode.ERROR });
					span.end();
					throw error;
				},
			);
		}
		const span = (
			operation.type === 'agent'
				? operations.get(operationKey({ ...executionContext, operationId: operation.operationId }))
				: operation.type === 'model'
					? turns.get(turnKey({ ...executionContext, turnId: operation.turnId }))
					: operation.type === 'tool'
						? tools.get(toolKey({ ...executionContext, toolCallId: operation.toolCallId }))
						: tasks.get(taskKey({ ...executionContext, taskId: operation.taskId }))
		)?.span;
		if (span) return context.with(trace.setSpan(context.active(), span), next);
		if (executionContext.traceCarrier) {
			return context.with(extractCarrier(executionContext.traceCarrier), next);
		}
		return next();
	};

	function extractCarrier(carrier: NonNullable<FlueExecutionContext['traceCarrier']>) {
		return propagation.extract(context.active(), carrier, {
			keys: () => (carrier.tracestate ? ['traceparent', 'tracestate'] : ['traceparent']),
			get: (value, key) => value[key as keyof typeof value],
		});
	}

	return {
		key: OPEN_TELEMETRY_INSTRUMENTATION_KEY,
		observe,
		interceptor,
		dispose() {
			if (disposed) return;
			disposed = true;
			for (const spans of [tools, turns, compactions, tasks, operations]) {
				for (const tracked of spans.values())
					complete(tracked.span, { type: 'interrupted' }, new Date());
				spans.clear();
			}
		},
	};
}

function startSpan(
	tracer: Tracer,
	name: string,
	parent: Span | undefined,
	event: FlueObservation,
	ctx: FlueEventContext,
	options: OpenTelemetryInstrumentationOptions,
	kind: SpanKind,
	attributes: Attributes,
	startTime = new Date(event.timestamp),
): Span {
	const activeContext = context.active();
	const parentContext = parent
		? trace.setSpan(activeContext, parent)
		: trace.getSpanContext(activeContext)
			? activeContext
			: options.resolveRootContext?.(event, ctx);
	return tracer.startSpan(
		name,
		{ kind, startTime, root: parentContext === undefined, attributes },
		parentContext,
	);
}

interface ExecutionIdentity {
	instanceId?: string;
	harness?: string;
	conversationId?: string;
	session?: string;
	operationId?: string;
	turnId?: string;
	taskId?: string;
}

interface TrackedSpan {
	span: Span;
	/** Shared content pool: message, tool, and exception draws bill one span. */
	ledger: ContentLedger;
	operationKey?: string;
	clientAttributes?: Attributes;
}

function trackedSpan(span: Span, event: FlueObservation): TrackedSpan {
	return {
		span,
		ledger: createContentLedger(),
		...(event.operationId ? { operationKey: operationKey(event) } : {}),
	};
}

function parentSpan(
	event: FlueObservation,
	operations: Map<string, TrackedSpan>,
	tasks: Map<string, TrackedSpan>,
): Span | undefined {
	return (
		(event.taskId ? tasks.get(taskKey(event))?.span : undefined) ??
		(event.operationId ? operations.get(operationKey(event))?.span : undefined)
	);
}

function identifiers(event: FlueObservation): Attributes {
	return Object.fromEntries(
		Object.entries({
			'flue.instance.id': event.instanceId,
			'flue.submission.id': event.submissionId,
			'flue.agent.name': event.agentName,
			'flue.harness.name': event.harness,
			'flue.session.name': event.session,
			'flue.parent_session.name': event.parentSession,
			'flue.operation.id': event.operationId,
			'flue.turn.id': event.turnId,
			'flue.task.id': event.taskId,
			'flue.event.index': event.eventIndex,
		}).filter((entry): entry is [string, string | number] => entry[1] !== undefined),
	);
}

/** Metric/log emission must never alter execution; failures are swallowed. */
function recordSignal(record: () => void): void {
	try {
		record();
	} catch {}
}

function metricErrorType(value: string | undefined): string {
	if (!value) return '_OTHER';
	return /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(value) ? value : '_OTHER';
}

function openaiAttributes(providerName: string, api: string): Attributes {
	if (providerName !== 'openai') return {};
	if (api === 'openai-completions') return { [ATTR.openaiApiType]: 'chat_completions' };
	if (api === 'openai-responses' || api === 'azure-openai-responses') {
		return { [ATTR.openaiApiType]: 'responses' };
	}
	return {};
}

function usageAttributes(usage: PromptUsage | undefined): Attributes {
	if (!usage) return {};
	return {
		[ATTR.inputTokens]: usage.input + usage.cacheRead + usage.cacheWrite,
		[ATTR.outputTokens]: usage.output,
		[ATTR.cacheReadTokens]: usage.cacheRead,
		[ATTR.cacheCreationTokens]: usage.cacheWrite,
		'flue.usage.total_tokens': usage.totalTokens,
	};
}

function setContent(
	tracked: TrackedSpan,
	name: string,
	value: unknown,
	event: FlueObservation,
	policy: ContentOption | undefined,
	contentType: GenAIContentType,
	rawString = false,
): void {
	if (policy === false) return;
	const spanContext = tracked.span.spanContext();
	const result = drawContentAttribute(tracked.ledger, policy, () => value, event, {
		key: name,
		contentType,
		rawString,
		traceId: spanContext.traceId,
		spanId: spanContext.spanId,
	});
	if (result.value !== undefined) tracked.span.setAttribute(name, result.value);
}

function setToolContent(
	tracked: TrackedSpan,
	kind: 'arguments' | 'result',
	value: unknown,
	event: FlueObservation,
	policy: ContentOption | undefined,
): void {
	if (policy === false) return;
	const spanContext = tracked.span.spanContext();
	const name = ATTR[kind === 'arguments' ? 'toolArguments' : 'toolResult'];
	const result = drawContentAttribute(tracked.ledger, policy, () => value, event, {
		key: name,
		contentType: kind === 'arguments' ? 'tool_arguments' : 'tool_result',
		rawString: true,
		traceId: spanContext.traceId,
		spanId: spanContext.spanId,
	});
	if (result.value !== undefined) tracked.span.setAttribute(name, result.value);
}

function complete(
	span: Span,
	error:
		| {
				type: string | undefined;
				value?: unknown;
				event?: FlueObservation;
				options?: OpenTelemetryInstrumentationOptions;
				ledger?: ContentLedger;
				attributes?: Attributes;
		  }
		| undefined,
	time: Date,
): void {
	if (error) {
		const attributes =
			error.attributes ??
			(error.event && error.options && error.ledger
				? exceptionAttributes(
						error.type,
						error.value,
						error.event,
						span,
						error.options,
						error.ledger,
					)
				: { [ATTR.errorType]: error.type ?? '_OTHER' });
		span.setAttribute(ATTR.errorType, attributes[ATTR.errorType] as string);
		// The status message reuses the content-policy-processed exception
		// message, so trace UIs that render status.message (not exception
		// events) show the same redacted/truncated text.
		span.setStatus({
			code: SpanStatusCode.ERROR,
			...(attributes['exception.message']
				? { message: attributes['exception.message'] as string }
				: {}),
		});
		// An exception record needs a class name or a message; without either
		// (no throw-site class, content off) the span's `error.type` is the
		// whole failure record — recording an empty exception would only echo
		// the taxonomy into a slot the spec defines as the class name.
		if (hasExceptionContent(attributes)) {
			span.recordException({
				...(attributes['exception.type'] ? { name: attributes['exception.type'] as string } : {}),
				...(attributes['exception.message']
					? { message: attributes['exception.message'] as string }
					: {}),
				...(attributes['exception.stacktrace']
					? { stack: attributes['exception.stacktrace'] as string }
					: {}),
			} as Exception);
		}
	}
	span.end(time);
}

function endDescendants(
	event: FlueObservation,
	turns: Map<string, TrackedSpan>,
	tools: Map<string, TrackedSpan>,
	tasks: Map<string, TrackedSpan>,
	compactions: Map<string, TrackedSpan>,
	time: Date,
): void {
	const ownerOperationKey = event.operationId ? operationKey(event) : undefined;
	if (!ownerOperationKey) return;
	for (const spans of [turns, tools, tasks, compactions]) {
		for (const [key, tracked] of spans) {
			if (tracked.operationKey !== ownerOperationKey) continue;
			complete(tracked.span, { type: 'interrupted' }, time);
			spans.delete(key);
		}
	}
}

function endSpan(
	spans: Map<string, TrackedSpan>,
	key: string,
	isError: boolean,
	errorType: string | undefined,
	error: unknown,
	time: Date,
	event: FlueObservation,
	options: OpenTelemetryInstrumentationOptions,
): void {
	const tracked = spans.get(key);
	if (!tracked) return;
	complete(
		tracked.span,
		isError ? { type: errorType, value: error, event, options, ledger: tracked.ledger } : undefined,
		time,
	);
	spans.delete(key);
}

function exceptionAttributes(
	errorType: string | undefined,
	error: unknown,
	event: FlueObservation,
	span: Span,
	options: OpenTelemetryInstrumentationOptions,
	ledger: ContentLedger,
): Attributes {
	const attributes: Attributes = { [ATTR.errorType]: errorType ?? '_OTHER' };
	// `exception.type` (a Stable attribute) is the exception *class name* —
	// the spec wants "the fully qualified class name" — never Flue's error
	// taxonomy, whose home is `error.type`. Classified `errorInfo` carries the
	// throw-site class as `name`; a raw thrown `Error` carries it directly.
	const className = exceptionClassName(error);
	if (className) attributes['exception.type'] = className;
	if (options.content === false) return attributes;
	const spanContext = span.spanContext();
	const message = errorMessage(error);
	if (message) {
		const processed = drawContentAttribute(ledger, options.content, () => message, event, {
			key: 'exception.message',
			contentType: 'exception_message',
			rawString: true,
			traceId: spanContext.traceId,
			spanId: spanContext.spanId,
		});
		if (processed.value !== undefined) attributes['exception.message'] = processed.value;
	}
	// The throw-site stack rides live `errorInfo` only (never durable state)
	// and, like the message, is emitted solely under the content gate —
	// stacks expose filesystem paths and deployment layout; strip them with a
	// transform on `exception_stacktrace` (or disable content) if that matters.
	const stack = errorStack(error);
	if (stack) {
		const processed = drawContentAttribute(ledger, options.content, () => stack, event, {
			key: 'exception.stacktrace',
			contentType: 'exception_stacktrace',
			rawString: true,
			traceId: spanContext.traceId,
			spanId: spanContext.spanId,
		});
		if (processed.value !== undefined) attributes['exception.stacktrace'] = processed.value;
	}
	return attributes;
}

/** True when the attributes can carry a spec-valid exception record. */
function hasExceptionContent(attributes: Attributes): boolean {
	return (
		attributes['exception.type'] !== undefined || attributes['exception.message'] !== undefined
	);
}

/**
 * The exception class name for `exception.type`: `Error#name` on a live
 * throwable, the classified `errorInfo.name` (which `classifyError` takes
 * from the same place) on the runtime's projected shape. Anything else —
 * strings, taxonomy-only objects — has no class to report.
 */
function exceptionClassName(error: unknown): string | undefined {
	if (error instanceof Error) return error.name || error.constructor.name || 'Error';
	if (
		error &&
		typeof error === 'object' &&
		'name' in error &&
		typeof error.name === 'string' &&
		error.name.length > 0
	) {
		return error.name;
	}
	return undefined;
}

function errorMessage(error: unknown): string | undefined {
	if (typeof error === 'string') return error;
	if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string')
		return error.message;
	return undefined;
}

function errorStack(error: unknown): string | undefined {
	if (error && typeof error === 'object' && 'stack' in error && typeof error.stack === 'string')
		return error.stack;
	return undefined;
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

function compactionKey(value: ExecutionIdentity): string {
	return identityKey('compaction', [
		value.instanceId,
		value.harness,
		value.conversationId,
		value.session,
		value.taskId,
		value.operationId,
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
