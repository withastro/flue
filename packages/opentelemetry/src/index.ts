import type {
	FlueEventContext,
	FlueExecutionContext,
	FlueExecutionInterceptor,
	FlueObservation,
	FlueObservationSubscriber,
	PromptUsage,
} from '@flue/runtime';
import {
	type Attributes,
	type Context,
	context,
	type Meter,
	metrics,
	type Span,
	SpanKind,
	SpanStatusCode,
	type Tracer,
	trace,
	propagation,
} from '@opentelemetry/api';
import {
	contentValue,
	type GenAIContentPolicy,
	type GenAIContentType,
	validateContentPolicy,
} from './content-policy.ts';
import {
	agentInputMessage,
	agentOutputMessage,
	inputMessages,
	outputMessages,
	systemInstructions,
	toolDefinitions,
} from './gen-ai-content.ts';
import { type GenAILogger, emitInferenceException } from './logs.ts';
import { createGenAIMetrics, recordTokenUsage } from './metrics.ts';
import { ATTR, GEN_AI_SCHEMA_URL } from './semconv.ts';

export {
	FLUE_TELEMETRY_EXTENSION_REVISION,
	GEN_AI_PROJECTION_REVISION,
	GEN_AI_SCHEMA_URL,
	GEN_AI_SEMCONV_REVISION,
} from './semconv.ts';
export type { GenAIContentPolicy, GenAIContentScope } from './content-policy.ts';

export interface OpenTelemetryInstrumentationOptions {
	tracer?: Tracer;
	meter?: Meter;
	logger?: GenAILogger;
	content?: false | GenAIContentPolicy;
	resolveRootContext?: (event: FlueObservation, ctx: FlueEventContext) => Context | undefined;
	diagnostic?: (diagnostic: { type: string; message: string; error?: unknown }) => void;
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
	validateContentPolicy(options.content);
	const tracer =
		options.tracer ??
		trace
			.getTracerProvider()
			.getTracer('@flue/opentelemetry', undefined, { schemaUrl: GEN_AI_SCHEMA_URL });
	const meter =
		options.meter ?? metrics.getMeter('@flue/opentelemetry', undefined, { schemaUrl: GEN_AI_SCHEMA_URL });
	const instruments = createGenAIMetrics(meter);
	const runs = new Map<string, TrackedSpan>();
	const operations = new Map<string, TrackedSpan>();
	const turns = new Map<string, TrackedSpan>();
	const tools = new Map<string, TrackedSpan>();
	const tasks = new Map<string, TrackedSpan>();
	const compactions = new Map<string, TrackedSpan>();
	let disposed = false;

	const observe: FlueObservationSubscriber = (event, ctx) => {
		if (disposed) return;
		const time = new Date(event.timestamp);
		if (event.type === 'run_start' || event.type === 'run_resume') {
			const key = runKey(event);
			const existing = runs.get(key);
			if (existing?.awaitingWorkflowObservation) {
				existing.awaitingWorkflowObservation = false;
				return;
			}
			if (event.type === 'run_start' && existing) return;
			if (event.type === 'run_resume') {
				const interrupted = existing;
				if (interrupted) {
					complete(interrupted.span, { type: 'interrupted' }, time);
					runs.delete(key);
				}
				endDescendants(event, operations, turns, tools, tasks, compactions, time);
			}
			const span = startSpan(
				tracer,
				`invoke_workflow ${event.workflowName}`,
				undefined,
				event,
				ctx,
				options,
				SpanKind.INTERNAL,
				{
					...identifiers(event),
					[ATTR.operationName]: 'invoke_workflow',
					[ATTR.workflowName]: event.workflowName,
				},
				event.type === 'run_start' ? new Date(event.startedAt) : time,
			);
			runs.set(runKey(event), {
				...trackedSpan(span, event),
				workflowName: event.workflowName,
				startedAtMs: (event.type === 'run_start' ? new Date(event.startedAt) : time).getTime(),
			});
			return;
		}
		if (event.type === 'operation_start') {
			if (event.operationKind === 'shell') return;
			if (event.taskId && event.operationKind === 'prompt' && tasks.has(taskKey(event))) return;
			const parent = parentSpan(event, operations, tasks, runs);
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
				...(isAgent && event.conversationId
					? { [ATTR.conversationId]: event.conversationId }
					: {}),
				'flue.operation.kind': event.operationKind,
			});
			operations.set(operationKey(event), trackedSpan(span, event));
			return;
		}
		if (event.type === 'task_start') {
			const parent = parentSpan(event, operations, tasks, runs);
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
					...('toolCallId' in event && typeof event.toolCallId === 'string' ? { [ATTR.toolCallId]: event.toolCallId } : {}),
					...(event.agent ? { [ATTR.agentName]: event.agent } : {}),
					...(event.conversationId ? { [ATTR.conversationId]: event.conversationId } : {}),
				},
			);
			setContent(span, ATTR.inputMessages, agentInputMessage(event.agentInput), event, options.content, 'input_messages', options.diagnostic);
			tasks.set(taskKey(event), trackedSpan(span, event));
			return;
		}
		if (event.type === 'compaction_start') {
			compactions.set(
				compactionKey(event),
				trackedSpan(
					startSpan(tracer, 'flue.compaction', parentSpan(event, operations, tasks, runs), event, ctx, options, SpanKind.INTERNAL, {
						...identifiers(event),
						'flue.compaction.reason': event.reason,
					}),
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
					? parentSpan(event, operations, tasks, runs)
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
			setContent(span, ATTR.inputMessages, inputMessages(request.input.messages), event, options.content, 'input_messages', options.diagnostic);
			setContent(span, ATTR.systemInstructions, systemInstructions(request.input.systemPrompt), event, options.content, 'system_instructions', options.diagnostic);
			setContent(span, ATTR.toolDefinitions, toolDefinitions(request.input.tools), event, options.content, 'tool_definitions', options.diagnostic);
			turns.set(turnKey(event), {
				...trackedSpan(span, event),
				clientAttributes: {
					[ATTR.operationName]: 'chat',
					[ATTR.providerName]: request.providerName,
					[ATTR.requestModel]: request.requestedModel,
					...(request.serverAddress ? { [ATTR.serverAddress]: request.serverAddress } : {}),
					...(request.serverPort !== undefined ? { [ATTR.serverPort]: request.serverPort } : {}),
				},
			});
			return;
		}
		if (event.type === 'tool_start') {
			if (event.origin === 'framework' && event.toolName === 'task') return;
			if (tools.has(toolKey(event))) return;
			const shell = event.origin === 'caller' && event.toolName === 'bash';
			const span = startSpan(
				tracer,
				shell ? 'flue.operation shell' : `execute_tool ${event.toolName}`,
				parentSpan(event, operations, tasks, runs),
				event,
				ctx,
				options,
				SpanKind.INTERNAL,
				{
					...identifiers(event),
					...(shell ? {} : { [ATTR.operationName]: 'execute_tool' }),
					...(shell ? {} : { [ATTR.toolName]: event.toolName }),
					...(shell ? {} : { [ATTR.toolCallId]: event.toolCallId }),
					...(!shell && event.toolType ? { [ATTR.toolType]: event.toolType } : {}),
					...(!shell && event.conversationId ? { [ATTR.conversationId]: event.conversationId } : {}),
					...(event.origin ? { 'flue.tool.origin': event.origin } : {}),
				},
			);
			if (!shell) {
				setContent(span, ATTR.toolDescription, event.description, event, options.content, 'tool_description', options.diagnostic, true);
				setToolContent(span, 'arguments', event.args, event, options.content, options.diagnostic);
			}
			tools.set(toolKey(event), trackedSpan(span, event));
			return;
		}
		if (event.type === 'turn') {
			const key = turnKey(event);
			const tracked = turns.get(key);
			if (!tracked) return;
			const span = tracked.span;
			const finishReason = event.response.finishReason;
			span.setAttributes({
				...(event.response.responseModel ? { [ATTR.responseModel]: event.response.responseModel } : {}),
				...(event.response.responseId ? { [ATTR.responseId]: event.response.responseId } : {}),
				...(finishReason ? { [ATTR.finishReasons]: [normalizeFinishReason(finishReason)] } : {}),
				...usageAttributes(event.response.usage),
			});
			setContent(span, ATTR.outputMessages, outputMessages(event.response.output, finishReason), event, options.content, 'output_messages', options.diagnostic);
			const metricAttributes = {
				...(tracked.clientAttributes ?? clientMetricAttributes(event)),
				...(event.response.responseModel ? { [ATTR.responseModel]: event.response.responseModel } : {}),
			};
			recordSignal(options, 'metric_record_error', () => {
				instruments.clientDuration.record(event.durationMs / 1000, {
					...metricAttributes,
					...(event.isError ? { [ATTR.errorType]: metricErrorType(event.response.error?.type) } : {}),
				});
				if (event.response.usage) {
					recordTokenUsage(
						instruments,
						event.response.usage.input + event.response.usage.cacheRead + event.response.usage.cacheWrite,
						event.response.usage.output,
						metricAttributes,
					);
				}
			});
			const exception = event.isError
				? exceptionAttributes(event.response.error?.type, event.response.error, event, span, options)
				: undefined;
			if (exception) recordSignal(options, 'log_emit_error', () => emitInferenceException(options.logger, {
				...metricAttributes,
				...exception,
			}));
			complete(span, exception ? { type: event.response.error?.type, attributes: exception } : undefined, time);

			turns.delete(key);
			return;
		}
		if (event.type === 'tool') {
			if (event.origin === 'framework' && event.toolName === 'task') return;
			const tracked = tools.get(toolKey(event));
			if (!tracked) return;
			const span = tracked.span;
			if (event.origin !== 'caller' || event.toolName !== 'bash') {
				recordSignal(options, 'metric_record_error', () => instruments.toolDuration.record(event.durationMs / 1000, {
					[ATTR.toolName]: event.toolName,
					...(event.toolType ? { [ATTR.toolType]: event.toolType } : {}),
					...(event.agentName ? { [ATTR.agentName]: event.agentName } : {}),
					...(event.isError ? { [ATTR.errorType]: metricErrorType(event.errorInfo?.type) } : {}),
				}));
			}
			if (!event.isError && (event.origin !== 'caller' || event.toolName !== 'bash')) {
				setToolContent(span, 'result', Object.hasOwn(event, 'effectiveResult') ? event.effectiveResult : event.result, event, options.content, options.diagnostic);
			}
			complete(span, event.isError ? { type: event.errorInfo?.type, value: event.result, event, options } : undefined, time);
			tools.delete(toolKey(event));
			return;
		}
		if (event.type === 'task') {
			const key = taskKey(event);
			const span = tasks.get(key)?.span;
			if (span) {
				setContent(span, ATTR.outputMessages, agentOutputMessage(event.agentOutput), event, options.content, 'output_messages', options.diagnostic);
				recordSignal(options, 'metric_record_error', () => instruments.agentDuration.record(event.durationMs / 1000, {
					...(event.agent ? { [ATTR.agentName]: event.agent } : {}),
					...(event.isError ? { [ATTR.errorType]: metricErrorType(event.errorInfo?.type) } : {}),
				}));
			}
			endSpan(tasks, key, event.isError, event.errorInfo?.type, event.result, time, event, options);
			return;
		}
		if (event.type === 'compaction') {
			endSpan(compactions, compactionKey(event), event.isError, undefined, event.error, time, event, options);
			return;
		}
		if (event.type === 'operation') {
			endDescendants(event, operations, turns, tools, tasks, compactions, time);
			const key = operationKey(event);
			const span = operations.get(key)?.span;
			if (span && event.usage) span.setAttributes(usageAttributes(event.usage));
			if (span && (event.operationKind === 'prompt' || event.operationKind === 'skill')) {
				setContent(span, ATTR.inputMessages, agentInputMessage(event.agentInput), event, options.content, 'input_messages', options.diagnostic);
				setContent(span, ATTR.outputMessages, agentOutputMessage(event.agentOutput), event, options.content, 'output_messages', options.diagnostic);
			}
			if (span && (event.operationKind === 'prompt' || event.operationKind === 'skill')) {
				recordSignal(options, 'metric_record_error', () => instruments.agentDuration.record(event.durationMs / 1000, {
					...(event.agentName ? { [ATTR.agentName]: event.agentName } : {}),
					...(event.isError ? { [ATTR.errorType]: metricErrorType(event.errorInfo?.type) } : {}),
				}));
			}
			endSpan(operations, key, event.isError, event.errorInfo?.type, event.error, time, event, options);
			return;
		}
		if (event.type === 'run_end') {
			endDescendants(event, operations, turns, tools, tasks, compactions, time);
			const key = runKey(event);
			const tracked = runs.get(key);
			if (tracked) recordSignal(options, 'metric_record_error', () => instruments.workflowDuration.record(
				Math.max(0, time.getTime() - tracked.startedAtMs) / 1000,
				{
					...(tracked.workflowName ? { [ATTR.workflowName]: tracked.workflowName } : {}),
					...(event.isError ? { [ATTR.errorType]: '_OTHER' } : {}),
				},
			));
			endSpan(runs, key, event.isError, undefined, event.error, time, event, options);
		}
	};

	const interceptor: FlueExecutionInterceptor = (operation, executionContext, next) => {
		let span =
			(operation.type === 'workflow'
				? operation.phase === 'resume'
					? undefined
					: runs.get(runKey(operation))
				: operation.type === 'agent'
					? operations.get(operationKey({ ...executionContext, operationId: operation.operationId }))
					: operation.type === 'model'
						? turns.get(turnKey({ ...executionContext, turnId: operation.turnId }))
						: operation.type === 'tool'
							? tools.get(toolKey({ ...executionContext, toolCallId: operation.toolCallId }))
							: tasks.get(taskKey({ ...executionContext, taskId: operation.taskId })))?.span;
		if (!span && operation.type === 'workflow') {
			const event: FlueObservation = operation.phase === 'start'
				? {
						v: 3,
						type: 'run_start',
						timestamp: new Date().toISOString(),
						eventIndex: 0,
						runId: operation.runId,
						workflowName: operation.workflowName,
						startedAt: operation.startedAt,
						input: undefined,
					}
				: {
						v: 3,
						type: 'run_resume',
						timestamp: new Date().toISOString(),
						eventIndex: 0,
						runId: operation.runId,
						workflowName: operation.workflowName,
						startedAt: operation.startedAt,
					};
			const eventContext = executionContext.eventContext;
			const parentContext = executionContext.traceCarrier
				? extractCarrier(executionContext.traceCarrier)
				: context.active();
			context.with(parentContext, () => observe(event, eventContext ?? {
				id: operation.runId,
				agentName: undefined,
				env: {},
				req: undefined,
				log: { info() {}, warn() {}, error() {} },
			}));
			const tracked = runs.get(runKey(operation));
			if (tracked) tracked.awaitingWorkflowObservation = true;
			span = tracked?.span;
		}
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
			for (const spans of [tools, turns, compactions, tasks, operations, runs]) {
				for (const tracked of spans.values()) complete(tracked.span, { type: 'interrupted' }, new Date());
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
	return tracer.startSpan(name, { kind, startTime, root: parentContext === undefined, attributes }, parentContext);
}

interface ExecutionIdentity {
	runId?: string;
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
	runKey?: string;
	operationKey?: string;
	turnKey?: string;
	workflowName?: string;
	startedAtMs: number;
	awaitingWorkflowObservation?: boolean;
	clientAttributes?: Attributes;
}

function trackedSpan(span: Span, event: FlueObservation): TrackedSpan {
	return {
		span,
		startedAtMs: new Date(event.timestamp).getTime(),
		...(event.runId ? { runKey: runKey(event) } : {}),
		...(event.operationId ? { operationKey: operationKey(event) } : {}),
		...(event.turnId ? { turnKey: turnKey(event) } : {}),
	};
}

function parentSpan(
	event: FlueObservation,
	operations: Map<string, TrackedSpan>,
	tasks: Map<string, TrackedSpan>,
	runs: Map<string, TrackedSpan>,
): Span | undefined {
	return (
		(event.taskId ? tasks.get(taskKey(event))?.span : undefined) ??
		(event.operationId ? operations.get(operationKey(event))?.span : undefined) ??
		(event.runId ? runs.get(runKey(event))?.span : undefined)
	);
}

function identifiers(event: FlueObservation): Attributes {
	return Object.fromEntries(
		Object.entries({
			'flue.run.id': event.runId,
			'flue.instance.id': event.instanceId,
			'flue.submission.id': event.submissionId,
			'flue.dispatch.id': event.dispatchId,
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

function recordSignal(
	options: OpenTelemetryInstrumentationOptions,
	type: 'metric_record_error' | 'log_emit_error',
	record: () => void,
): void {
	try {
		record();
	} catch (error) {
		try {
			options.diagnostic?.({ type, message: 'Telemetry signal emission failed.', error });
		} catch {}
	}
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

function clientMetricAttributes(event: Extract<FlueObservation, { type: 'turn' }>): Attributes {
	return Object.fromEntries(
		Object.entries({
			[ATTR.operationName]: 'chat',
			[ATTR.providerName]: event.request.providerName,
			[ATTR.requestModel]: event.request.requestedModel,
			[ATTR.responseModel]: event.response.responseModel,
		}).filter((entry): entry is [string, string] => entry[1] !== undefined),
	);
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
	span: Span,
	name: string,
	value: unknown,
	event: FlueObservation,
	policy: false | GenAIContentPolicy | undefined,
	contentType: GenAIContentType,
	diagnostic?: OpenTelemetryInstrumentationOptions['diagnostic'],
	rawString = false,
): void {
	const result = contentValue(policy, value, event, span, { contentType, rawString }, diagnostic);
	if (result.value !== undefined) span.setAttribute(name, result.value);
	if (result.truncated !== undefined) {
		span.setAttribute(`flue.telemetry.content.${contentType}.truncated`, true);
	}
	if (result.omitted) span.setAttribute(`flue.telemetry.content.${contentType}.omitted`, true);
}

function setToolContent(
	span: Span,
	kind: 'arguments' | 'result',
	value: unknown,
	event: FlueObservation,
	policy: false | GenAIContentPolicy | undefined,
	diagnostic?: OpenTelemetryInstrumentationOptions['diagnostic'],
): void {
	const contentType = kind === 'arguments' ? 'tool_arguments' : 'tool_result';
	const result = contentValue(policy, value, event, span, { contentType, rawString: true }, diagnostic);
	if (result.value !== undefined) {
		span.setAttribute(result.objectShaped ? ATTR[kind === 'arguments' ? 'toolArguments' : 'toolResult'] : `flue.tool.call.${kind}`, result.value);
	}
	if (result.truncated !== undefined) span.setAttribute(`flue.telemetry.content.${contentType}.truncated`, true);
	if (result.omitted) span.setAttribute(`flue.telemetry.content.${contentType}.omitted`, true);
}

function complete(
	span: Span,
	error: { type: string | undefined; value?: unknown; event?: FlueObservation; options?: OpenTelemetryInstrumentationOptions; attributes?: Attributes } | undefined,
	time: Date,
): void {
	if (error) {
		const attributes = error.attributes ?? (error.event && error.options
			? exceptionAttributes(error.type, error.value, error.event, span, error.options)
			: { [ATTR.errorType]: error.type ?? '_OTHER', 'exception.type': error.type ?? '_OTHER' });
		span.setAttribute(ATTR.errorType, attributes[ATTR.errorType] as string);
		span.setStatus({ code: SpanStatusCode.ERROR });
		span.recordException({
			name: attributes['exception.type'] as string,
			...(attributes['exception.message'] ? { message: attributes['exception.message'] as string } : {}),
		});
	}
	span.end(time);
}

function endDescendants(
	event: FlueObservation,
	operations: Map<string, TrackedSpan>,
	turns: Map<string, TrackedSpan>,
	tools: Map<string, TrackedSpan>,
	tasks: Map<string, TrackedSpan>,
	compactions: Map<string, TrackedSpan>,
	time: Date,
): void {
	const ownerOperationKey = event.operationId ? operationKey(event) : undefined;
	const ownerRunKey = event.runId ? runKey(event) : undefined;
	for (const spans of [turns, tools, tasks, compactions]) {
		for (const [key, tracked] of spans) {
			if (ownerOperationKey ? tracked.operationKey !== ownerOperationKey : tracked.runKey !== ownerRunKey) continue;
			complete(tracked.span, { type: 'interrupted' }, time);
			spans.delete(key);
		}
	}
	if (!ownerOperationKey) {
		for (const [key, tracked] of operations) {
			if (tracked.runKey !== ownerRunKey) continue;
			complete(tracked.span, { type: 'interrupted' }, time);
			operations.delete(key);
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
	complete(tracked.span, isError ? { type: errorType, value: error, event, options } : undefined, time);
	spans.delete(key);
}

function exceptionAttributes(
	errorType: string | undefined,
	error: unknown,
	event: FlueObservation,
	span: Span,
	options: OpenTelemetryInstrumentationOptions,
): Attributes {
	const type = errorType ?? '_OTHER';
	const message = errorMessage(error);
	if (!message) return { [ATTR.errorType]: type, 'exception.type': type };
	const processed = contentValue(options.content, message, event, span, {
		contentType: 'exception_message',
		rawString: true,
	}, options.diagnostic);
	return {
		[ATTR.errorType]: type,
		'exception.type': type,
		...(processed.value !== undefined ? { 'exception.message': processed.value } : {}),
	};
}

function errorMessage(error: unknown): string | undefined {
	if (typeof error === 'string') return error;
	if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message;
	return undefined;
}

function normalizeFinishReason(reason: string): string {
	if (reason === 'toolUse') return 'tool_call';
	if (reason === 'aborted') return 'error';
	return reason;
}

function identityKey(kind: string, fields: Array<string | undefined>): string {
	return JSON.stringify([kind, ...fields.map((value) => value ?? null)]);
}

function runKey(value: { runId?: string }): string {
	return identityKey('run', [value.runId]);
}

function operationKey(value: ExecutionIdentity): string {
	return identityKey('operation', [
		value.runId,
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
		value.runId,
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
		value.runId,
		value.instanceId,
		value.harness,
		value.conversationId,
		value.session,
		value.taskId,
	]);
}

function compactionKey(value: ExecutionIdentity): string {
	return identityKey('compaction', [
		value.runId,
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
		value.runId,
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
