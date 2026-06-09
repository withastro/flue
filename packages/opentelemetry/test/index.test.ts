import {
	type AttributeValue,
	type Context,
	context,
	type Exception,
	type Link,
	type Span,
	type SpanContext,
	type SpanOptions,
	type SpanStatus,
	SpanStatusCode,
	type TimeInput,
	trace,
} from '@opentelemetry/api';
import { describe, expect, it, vi } from 'vite-plus/test';
import { createOpenTelemetryObserver } from '../src/index.ts';

class RecordingSpan implements Span {
	readonly attributes: Record<string, AttributeValue> = {};
	readonly events: Array<{ name: string; attributes?: Record<string, AttributeValue> }> = [];
	readonly exceptions: unknown[] = [];
	readonly links: Link[] = [];
	status?: SpanStatus;
	ended = false;

	constructor(
		readonly name: string,
		readonly options: SpanOptions | undefined,
		readonly parent: Span | undefined,
	) {
		Object.assign(this.attributes, options?.attributes);
		this.links.push(...(options?.links ?? []));
	}

	spanContext(): SpanContext {
		return {
			traceId: '00000000000000000000000000000001',
			spanId: '0000000000000001',
			traceFlags: 1,
		};
	}

	setAttribute(key: string, value: AttributeValue) {
		this.attributes[key] = value;
		return this;
	}

	setAttributes(attributes: Record<string, AttributeValue>) {
		Object.assign(this.attributes, attributes);
		return this;
	}

	addEvent(name: string, attributesOrStartTime?: Record<string, AttributeValue> | TimeInput) {
		const attributes =
			attributesOrStartTime &&
			typeof attributesOrStartTime === 'object' &&
			!Array.isArray(attributesOrStartTime) &&
			!(attributesOrStartTime instanceof Date)
				? attributesOrStartTime
				: undefined;
		this.events.push({ name, attributes });
		return this;
	}

	addLink(link: Link) {
		this.links.push(link);
		return this;
	}
	addLinks(links: Link[]) {
		this.links.push(...links);
		return this;
	}

	setStatus(status: SpanStatus) {
		this.status = status;
		return this;
	}

	updateName() {
		return this;
	}

	end(_endTime?: TimeInput) {
		this.ended = true;
	}

	isRecording() {
		return true;
	}

	recordException(exception: Exception, _time?: TimeInput) {
		this.exceptions.push(exception);
	}
}

class RecordingTracer {
	readonly spans: RecordingSpan[] = [];

	startSpan(name: string, options?: SpanOptions, parentContext?: Context): Span {
		const parent = parentContext ? trace.getSpan(parentContext) : undefined;
		const span = new RecordingSpan(name, options, parent);
		this.spans.push(span);
		return span;
	}
}

describe('createOpenTelemetryObserver', () => {
	it('creates workflow and nested semantic spans without capturing content by default', () => {
		const tracer = new RecordingTracer();
		const observe = createOpenTelemetryObserver({ tracer: tracer as never });
		observe(
			{
				type: 'run_start',
				runId: 'run-1',
				owner: { kind: 'workflow', workflowName: 'report', instanceId: 'run-1' },
				instanceId: 'run-1',
				workflowName: 'report',
				startedAt: '2026-05-27T00:00:00.000Z',
				payload: { secret: true },
				timestamp: '2026-05-27T00:00:00.000Z',
			},
			{} as never,
		);
		observe(
			{
				type: 'operation_start',
				runId: 'run-1',
				operationId: 'op-1',
				operationKind: 'prompt',
				timestamp: '2026-05-27T00:00:00.010Z',
			},
			{} as never,
		);
		observe(
			{
				type: 'turn_request',
				runId: 'run-1',
				operationId: 'op-1',
				turnId: 'turn-1',
				purpose: 'agent',
				model: 'sonnet',
				provider: 'anthropic',
				api: 'messages',
				input: { messages: [] },
				timestamp: '2026-05-27T00:00:00.020Z',
			},
			{} as never,
		);
		observe(
			{
				type: 'turn',
				runId: 'run-1',
				operationId: 'op-1',
				turnId: 'turn-1',
				purpose: 'agent',
				durationMs: 10,
				isError: false,
				usage: {
					input: 2,
					output: 3,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 5,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
				},
				timestamp: '2026-05-27T00:00:00.030Z',
			},
			{} as never,
		);
		observe(
			{
				type: 'operation',
				runId: 'run-1',
				operationId: 'op-1',
				operationKind: 'prompt',
				durationMs: 30,
				isError: false,
				timestamp: '2026-05-27T00:00:00.040Z',
			},
			{} as never,
		);
		observe(
			{
				type: 'run_end',
				runId: 'run-1',
				durationMs: 40,
				isError: false,
				timestamp: '2026-05-27T00:00:00.050Z',
			},
			{} as never,
		);

		expect(tracer.spans.map((span) => span.name)).toEqual([
			'flue.workflow report',
			'flue.operation prompt',
			'gen_ai.generate',
		]);
		expect(tracer.spans[0]?.attributes).toMatchObject({
			'flue.workflow.name': 'report',
		});
		expect(tracer.spans[0]?.options?.root).toBe(true);
		expect(tracer.spans[0]?.attributes).not.toHaveProperty('flue.workflow.restarted_from_run_id');
		expect(tracer.spans[0]?.attributes).not.toHaveProperty('flue.workflow.payload');
		expect(tracer.spans[2]?.attributes).toMatchObject({
			'gen_ai.request.model': 'sonnet',
			'gen_ai.usage.input_tokens': 2,
			'gen_ai.usage.output_tokens': 3,
		});
		expect(tracer.spans.every((span) => span.ended)).toBe(true);
	});

	it('exports scoped event indexes and compaction usage rollups without changing model turn leaf usage', () => {
		const tracer = new RecordingTracer();
		const observe = createOpenTelemetryObserver({ tracer: tracer as never });
		observe(
			{
				type: 'run_start',
				runId: 'run-1',
				owner: { kind: 'workflow', workflowName: 'report', instanceId: 'run-1' },
				instanceId: 'run-1',
				workflowName: 'report',
				startedAt: '2026-05-27T00:00:00.000Z',
				payload: {},
				eventIndex: 0,
				timestamp: '2026-05-27T00:00:00.000Z',
			},
			{} as never,
		);
		observe(
			{
				type: 'operation_start',
				runId: 'run-1',
				operationId: 'op-1',
				operationKind: 'prompt',
				eventIndex: 1,
				timestamp: '2026-05-27T00:00:00.010Z',
			},
			{} as never,
		);
		observe(
			{
				type: 'compaction_start',
				runId: 'run-1',
				operationId: 'op-1',
				reason: 'threshold',
				estimatedTokens: 10_000,
				eventIndex: 2,
				timestamp: '2026-05-27T00:00:00.020Z',
			},
			{} as never,
		);
		observe(
			{
				type: 'turn_request',
				runId: 'run-1',
				operationId: 'op-1',
				turnId: 'turn-1',
				purpose: 'compaction',
				model: 'sonnet',
				provider: 'anthropic',
				api: 'messages',
				input: { messages: [] },
				eventIndex: 3,
				timestamp: '2026-05-27T00:00:00.030Z',
			},
			{} as never,
		);
		observe(
			{
				type: 'turn',
				runId: 'run-1',
				operationId: 'op-1',
				turnId: 'turn-1',
				purpose: 'compaction',
				durationMs: 10,
				isError: false,
				usage: {
					input: 2,
					output: 3,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 5,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
				},
				eventIndex: 4,
				timestamp: '2026-05-27T00:00:00.040Z',
			},
			{} as never,
		);
		observe(
			{
				type: 'compaction',
				runId: 'run-1',
				operationId: 'op-1',
				messagesBefore: 12,
				messagesAfter: 3,
				durationMs: 20,
				usage: {
					input: 2,
					output: 3,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 5,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
				},
				eventIndex: 5,
				timestamp: '2026-05-27T00:00:00.050Z',
			},
			{} as never,
		);
		observe(
			{
				type: 'log',
				runId: 'run-1',
				operationId: 'op-1',
				level: 'info',
				message: 'Compacted',
				eventIndex: 6,
				timestamp: '2026-05-27T00:00:00.060Z',
			},
			{} as never,
		);
		observe(
			{
				type: 'operation',
				runId: 'run-1',
				operationId: 'op-1',
				operationKind: 'prompt',
				durationMs: 60,
				isError: false,
				eventIndex: 7,
				timestamp: '2026-05-27T00:00:00.070Z',
			},
			{} as never,
		);
		observe(
			{
				type: 'run_end',
				runId: 'run-1',
				durationMs: 70,
				isError: false,
				eventIndex: 8,
				timestamp: '2026-05-27T00:00:00.080Z',
			},
			{} as never,
		);

		expect(tracer.spans.map((span) => span.name)).toEqual([
			'flue.workflow report',
			'flue.operation prompt',
			'flue.compaction',
			'gen_ai.generate',
		]);
		expect(tracer.spans[0]?.attributes).toMatchObject({
			'flue.event.start_index': 0,
			'flue.event.end_index': 8,
		});
		expect(tracer.spans[1]?.attributes).toMatchObject({
			'flue.event.start_index': 1,
			'flue.event.end_index': 7,
		});
		expect(tracer.spans[1]?.events).toEqual([
			{ name: 'flue.log', attributes: { 'flue.log.level': 'info', 'flue.event.index': 6 } },
		]);
		expect(tracer.spans[2]?.attributes).toMatchObject({
			'flue.event.start_index': 2,
			'flue.event.end_index': 5,
			'flue.compaction.usage.input_tokens': 2,
			'flue.compaction.usage.output_tokens': 3,
			'flue.compaction.usage.total_tokens': 5,
			'flue.compaction.usage.cost_total': 0.01,
		});
		expect(tracer.spans[3]?.attributes).toMatchObject({
			'flue.event.start_index': 3,
			'flue.event.end_index': 4,
			'gen_ai.usage.input_tokens': 2,
			'gen_ai.usage.output_tokens': 3,
			'gen_ai.usage.total_tokens': 5,
			'gen_ai.usage.cost_total': 0.01,
		});
	});

	it('uses a resolved parent context for workflow roots without changing nested span parenting', () => {
		const tracer = new RecordingTracer();
		const parent = new RecordingSpan('application.request', undefined, undefined);
		const parentContext = trace.setSpan(context.active(), parent);
		const resolvedEvents: string[] = [];
		const observe = createOpenTelemetryObserver({
			tracer: tracer as never,
			resolveRootContext: (event) => {
				resolvedEvents.push(event.type);
				return parentContext;
			},
		});
		observe(
			{
				type: 'run_start',
				runId: 'run-1',
				owner: { kind: 'workflow', workflowName: 'report', instanceId: 'run-1' },
				instanceId: 'run-1',
				workflowName: 'report',
				startedAt: '2026-05-27T00:00:00.000Z',
				payload: {},
				timestamp: '2026-05-27T00:00:00.000Z',
			},
			{} as never,
		);
		observe(
			{
				type: 'operation_start',
				runId: 'run-1',
				operationId: 'op-1',
				operationKind: 'prompt',
				timestamp: '2026-05-27T00:00:00.010Z',
			},
			{} as never,
		);

		expect(tracer.spans).toHaveLength(2);
		expect(tracer.spans[0]?.parent).toBe(parent);
		expect(tracer.spans[0]?.options?.root).toBe(false);
		expect(tracer.spans[1]?.parent).toBe(tracer.spans[0]);
		expect(tracer.spans[1]?.options?.root).toBe(false);
		expect(resolvedEvents).toEqual(['run_start']);
	});

	it('resolves a parent context selectively for dispatched operation roots', () => {
		const tracer = new RecordingTracer();
		const parent = new RecordingSpan('application.dispatch', undefined, undefined);
		const parentContext = trace.setSpan(context.active(), parent);
		const observe = createOpenTelemetryObserver({
			tracer: tracer as never,
			resolveRootContext: (event) =>
				event.dispatchId === 'dispatch-1' ? parentContext : undefined,
		});
		observe(
			{
				type: 'operation_start',
				instanceId: 'agent-1',
				operationId: 'op-1',
				operationKind: 'prompt',
				timestamp: '2026-05-27T00:00:00.000Z',
			},
			{} as never,
		);
		observe(
			{
				type: 'operation',
				instanceId: 'agent-1',
				operationId: 'op-1',
				operationKind: 'prompt',
				durationMs: 5,
				isError: false,
				timestamp: '2026-05-27T00:00:00.010Z',
			},
			{} as never,
		);
		observe(
			{
				type: 'operation_start',
				instanceId: 'agent-1',
				dispatchId: 'dispatch-1',
				operationId: 'op-2',
				operationKind: 'prompt',
				timestamp: '2026-05-27T00:00:00.020Z',
			},
			{} as never,
		);

		expect(tracer.spans).toHaveLength(2);
		expect(tracer.spans[0]?.parent).toBeUndefined();
		expect(tracer.spans[0]?.options?.root).toBe(true);
		expect(tracer.spans[1]?.parent).toBe(parent);
		expect(tracer.spans[1]?.options?.root).toBe(false);
		expect(tracer.spans[1]?.attributes).toMatchObject({
			'flue.instance_id': 'agent-1',
			'flue.dispatch_id': 'dispatch-1',
		});
	});

	it('starts a recovered run-handling segment when terminalization continues after interruption', () => {
		const tracer = new RecordingTracer();
		const parent = new RecordingSpan('application.request', undefined, undefined);
		const parentContext = trace.setSpan(context.active(), parent);
		const observe = createOpenTelemetryObserver({
			tracer: tracer as never,
			resolveRootContext: () => parentContext,
		});
		observe(
			{
				type: 'run_start',
				runId: 'run-1',
				owner: { kind: 'workflow', workflowName: 'report', instanceId: 'run-1' },
				instanceId: 'run-1',
				workflowName: 'report',
				startedAt: '2026-05-27T00:00:00.000Z',
				payload: {},
				timestamp: '2026-05-27T00:00:00.000Z',
			},
			{} as never,
		);
		observe(
			{
				type: 'run_resume',
				runId: 'run-1',
				owner: { kind: 'workflow', workflowName: 'report', instanceId: 'run-1' },
				instanceId: 'run-1',
				workflowName: 'report',
				startedAt: '2026-05-27T00:00:00.000Z',
				timestamp: '2026-05-27T00:01:00.000Z',
			},
			{} as never,
		);
		observe(
			{
				type: 'run_end',
				runId: 'run-1',
				durationMs: 60_020,
				isError: true,
				error: { name: 'Error', message: 'interrupted' },
				timestamp: '2026-05-27T00:01:00.020Z',
			},
			{} as never,
		);

		expect(tracer.spans.map((span) => span.name)).toEqual([
			'flue.workflow report',
			'flue.workflow report',
		]);
		expect(tracer.spans[0]?.status).toMatchObject({
			code: SpanStatusCode.ERROR,
			message: 'Workflow execution was interrupted before recovery continued run handling.',
		});
		expect(tracer.spans[1]?.attributes).toMatchObject({
			'flue.workflow.recovery_handling': true,
			'flue.workflow.started_at': '2026-05-27T00:00:00.000Z',
		});
		expect(tracer.spans[1]?.parent).toBe(parent);
		expect(tracer.spans[1]?.options?.root).toBe(false);
		expect(tracer.spans[1]?.links).toEqual([{ context: tracer.spans[0]?.spanContext() }]);
		expect(tracer.spans[1]?.attributes).not.toHaveProperty('flue.workflow.resumed');
		expect(tracer.spans.every((span) => span.ended)).toBe(true);
	});

	it('ends tracked descendant spans when recovery handling continues after interruption', () => {
		const tracer = new RecordingTracer();
		const observe = createOpenTelemetryObserver({ tracer: tracer as never });
		observe(
			{
				type: 'run_start',
				runId: 'run-1',
				owner: { kind: 'workflow', workflowName: 'report', instanceId: 'run-1' },
				instanceId: 'run-1',
				workflowName: 'report',
				startedAt: '2026-05-27T00:00:00.000Z',
				payload: {},
				timestamp: '2026-05-27T00:00:00.000Z',
			},
			{} as never,
		);
		observe(
			{
				type: 'operation_start',
				runId: 'run-1',
				operationId: 'op-1',
				operationKind: 'prompt',
				timestamp: '2026-05-27T00:00:00.010Z',
			},
			{} as never,
		);
		observe(
			{
				type: 'turn_request',
				runId: 'run-1',
				operationId: 'op-1',
				turnId: 'turn-1',
				purpose: 'agent',
				model: 'sonnet',
				provider: 'anthropic',
				api: 'messages',
				input: { messages: [] },
				timestamp: '2026-05-27T00:00:00.020Z',
			},
			{} as never,
		);
		observe(
			{
				type: 'tool_start',
				runId: 'run-1',
				operationId: 'op-1',
				turnId: 'turn-1',
				toolCallId: 'tool-1',
				toolName: 'lookup',
				args: {},
				timestamp: '2026-05-27T00:00:00.030Z',
			},
			{} as never,
		);
		observe(
			{
				type: 'run_resume',
				runId: 'run-1',
				owner: { kind: 'workflow', workflowName: 'report', instanceId: 'run-1' },
				instanceId: 'run-1',
				workflowName: 'report',
				startedAt: '2026-05-27T00:00:00.000Z',
				timestamp: '2026-05-27T00:01:00.000Z',
			},
			{} as never,
		);

		expect(tracer.spans.map((span) => span.name)).toEqual([
			'flue.workflow report',
			'flue.operation prompt',
			'gen_ai.generate',
			'flue.tool lookup',
			'flue.workflow report',
		]);
		expect(tracer.spans.slice(0, 4).every((span) => span.ended)).toBe(true);
		expect(
			tracer.spans.slice(1, 4).every((span) => span.status?.code === SpanStatusCode.ERROR),
		).toBe(true);
		expect(tracer.spans[4]?.ended).toBe(false);
	});

	it('starts recovery handling without a predecessor link when no workflow start was observed', () => {
		const tracer = new RecordingTracer();
		const observe = createOpenTelemetryObserver({ tracer: tracer as never });
		observe(
			{
				type: 'run_resume',
				runId: 'run-1',
				owner: { kind: 'workflow', workflowName: 'report', instanceId: 'run-1' },
				instanceId: 'run-1',
				workflowName: 'report',
				startedAt: '2026-05-27T00:00:00.000Z',
				timestamp: '2026-05-27T00:01:00.000Z',
			},
			{} as never,
		);
		observe(
			{
				type: 'run_end',
				runId: 'run-1',
				durationMs: 60_020,
				isError: true,
				timestamp: '2026-05-27T00:01:00.020Z',
			},
			{} as never,
		);

		expect(tracer.spans).toHaveLength(1);
		expect(tracer.spans[0]?.links).toEqual([]);
		expect(tracer.spans[0]?.attributes).toMatchObject({
			'flue.workflow.recovery_handling': true,
		});
		expect(tracer.spans[0]?.ended).toBe(true);
	});

	it('ends tracked descendant spans when a workflow terminal event arrives without a tracked root', () => {
		const tracer = new RecordingTracer();
		const observe = createOpenTelemetryObserver({ tracer: tracer as never });
		observe(
			{
				type: 'operation_start',
				runId: 'run-1',
				operationId: 'op-1',
				operationKind: 'prompt',
				timestamp: '2026-05-27T00:00:00.010Z',
			},
			{} as never,
		);
		observe(
			{
				type: 'run_end',
				runId: 'run-1',
				durationMs: 10,
				isError: true,
				timestamp: '2026-05-27T00:00:00.020Z',
			},
			{} as never,
		);

		expect(tracer.spans).toHaveLength(1);
		expect(tracer.spans[0]?.ended).toBe(true);
		expect(tracer.spans[0]?.status).toMatchObject({
			code: SpanStatusCode.ERROR,
			message: 'Workflow run ended before this span received its terminal event.',
		});
	});

	it('does not export failed task result content unless sanitization is enabled', () => {
		const tracer = new RecordingTracer();
		const observe = createOpenTelemetryObserver({ tracer: tracer as never });
		observe(
			{
				type: 'task_start',
				instanceId: 'agent-1',
				operationId: 'op-1',
				taskId: 'task-1',
				prompt: 'secret prompt',
				cwd: '/secret/workspace',
				timestamp: '2026-05-27T00:00:00.000Z',
			},
			{} as never,
		);
		observe(
			{
				type: 'task',
				instanceId: 'agent-1',
				operationId: 'op-1',
				taskId: 'task-1',
				durationMs: 5,
				isError: true,
				result: 'secret failure detail',
				timestamp: '2026-05-27T00:00:00.010Z',
			},
			{} as never,
		);

		expect(tracer.spans[0]?.attributes).not.toHaveProperty('flue.task.result');
		expect(tracer.spans[0]?.attributes).not.toHaveProperty('flue.task.cwd');
		expect(tracer.spans[0]?.status?.message).toBe('Task failed.');
		expect(tracer.spans[0]?.exceptions).toEqual(['Task failed.']);
	});

	it('exports generic terminal errors unless the sanitizer returns error content', () => {
		const tracer = new RecordingTracer();
		const observe = createOpenTelemetryObserver({ tracer: tracer as never });
		observe(
			{
				type: 'run_start',
				runId: 'run-1',
				owner: { kind: 'workflow', workflowName: 'report', instanceId: 'run-1' },
				instanceId: 'run-1',
				workflowName: 'report',
				startedAt: '2026-05-27T00:00:00.000Z',
				payload: {},
				timestamp: '2026-05-27T00:00:00.000Z',
			},
			{} as never,
		);
		observe(
			{
				type: 'operation_start',
				runId: 'run-1',
				operationId: 'op-1',
				operationKind: 'prompt',
				timestamp: '2026-05-27T00:00:00.010Z',
			},
			{} as never,
		);
		observe(
			{
				type: 'turn_request',
				runId: 'run-1',
				operationId: 'op-1',
				turnId: 'turn-1',
				purpose: 'agent',
				model: 'sonnet',
				provider: 'anthropic',
				api: 'messages',
				input: { messages: [] },
				timestamp: '2026-05-27T00:00:00.020Z',
			},
			{} as never,
		);
		observe(
			{
				type: 'turn',
				runId: 'run-1',
				operationId: 'op-1',
				turnId: 'turn-1',
				purpose: 'agent',
				durationMs: 5,
				isError: true,
				error: 'secret provider response',
				timestamp: '2026-05-27T00:00:00.030Z',
			},
			{} as never,
		);
		observe(
			{
				type: 'operation',
				runId: 'run-1',
				operationId: 'op-1',
				operationKind: 'prompt',
				durationMs: 10,
				isError: true,
				error: 'secret operation detail',
				timestamp: '2026-05-27T00:00:00.040Z',
			},
			{} as never,
		);
		observe(
			{
				type: 'run_end',
				runId: 'run-1',
				durationMs: 15,
				isError: true,
				error: 'secret workflow detail',
				timestamp: '2026-05-27T00:00:00.050Z',
			},
			{} as never,
		);

		expect(tracer.spans[0]?.status?.message).toBe('Workflow run failed.');
		expect(tracer.spans[0]?.exceptions).toEqual(['Workflow run failed.']);
		expect(tracer.spans[1]?.status?.message).toBe('Operation failed.');
		expect(tracer.spans[1]?.exceptions).toEqual(['Operation failed.']);
		expect(tracer.spans[2]?.status?.message).toBe('Model turn failed.');
		expect(tracer.spans[2]?.exceptions).toEqual(['Model turn failed.']);
	});

	it('traces standalone harness tools and captures content returned by the sanitizer', () => {
		const tracer = new RecordingTracer();
		const observe = createOpenTelemetryObserver({
			tracer: tracer as never,
			sanitize: (event) => event,
		});
		observe(
			{
				type: 'tool_start',
				instanceId: 'agent-1',
				harness: 'default',
				toolName: 'bash',
				toolCallId: 'call-1',
				args: { command: 'pwd' },
				timestamp: '2026-05-27T00:00:00.000Z',
			},
			{} as never,
		);
		observe(
			{
				type: 'tool_call',
				instanceId: 'agent-1',
				harness: 'default',
				toolName: 'bash',
				toolCallId: 'call-1',
				durationMs: 5,
				isError: false,
				result: 'ok',
				timestamp: '2026-05-27T00:00:00.010Z',
			},
			{} as never,
		);

		expect(tracer.spans).toHaveLength(1);
		expect(tracer.spans[0]?.options?.root).toBe(true);
		expect(tracer.spans[0]?.attributes).toMatchObject({
			'flue.instance_id': 'agent-1',
			'flue.tool.name': 'bash',
			'flue.tool.arguments': '{"command":"pwd"}',
			'flue.tool.result': 'ok',
		});
		expect(tracer.spans[0]?.ended).toBe(true);
	});

	it('completes spans with metadata-only fallback when sanitization fails', () => {
		const tracer = new RecordingTracer();
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		const observe = createOpenTelemetryObserver({
			tracer: tracer as never,
			sanitize() {
				throw new Error('sanitizer failed');
			},
		});
		observe(
			{
				type: 'tool_start',
				instanceId: 'agent-1',
				harness: 'default',
				toolName: 'bash',
				toolCallId: 'call-1',
				args: { command: 'print-secret' },
				timestamp: '2026-05-27T00:00:00.000Z',
			},
			{} as never,
		);
		observe(
			{
				type: 'tool_call',
				instanceId: 'agent-1',
				harness: 'default',
				toolName: 'bash',
				toolCallId: 'call-1',
				durationMs: 5,
				isError: true,
				result: 'secret output',
				timestamp: '2026-05-27T00:00:00.010Z',
			},
			{} as never,
		);

		expect(tracer.spans).toHaveLength(1);
		expect(tracer.spans[0]?.attributes).not.toHaveProperty('flue.tool.arguments');
		expect(tracer.spans[0]?.attributes).not.toHaveProperty('flue.tool.result');
		expect(tracer.spans[0]?.status?.message).toBe('Tool call failed.');
		expect(tracer.spans[0]?.ended).toBe(true);
		expect(consoleError).toHaveBeenCalledTimes(2);
		consoleError.mockRestore();
	});

	it('uses shallow sanitizer copies for exported content without changing lifecycle correlation', () => {
		const tracer = new RecordingTracer();
		const startEvent = {
			type: 'tool_start' as const,
			instanceId: 'agent-1',
			harness: 'default',
			toolName: 'bash',
			toolCallId: 'call-1',
			args: { command: 'print-secret' },
			timestamp: '2026-05-27T00:00:00.000Z',
		};
		const endEvent = {
			type: 'tool_call' as const,
			instanceId: 'agent-1',
			harness: 'default',
			toolName: 'bash',
			toolCallId: 'call-1',
			durationMs: 5,
			isError: true,
			result: 'secret output',
			timestamp: '2026-05-27T00:00:00.010Z',
		};
		const observe = createOpenTelemetryObserver({
			tracer: tracer as never,
			sanitize(event) {
				if (event.type === 'tool_start') {
					event.toolCallId = 'changed';
					event.args = { command: '<redacted>' };
				}
				if (event.type === 'tool_call') {
					event.toolCallId = 'changed';
					event.result = '<redacted>';
				}
				return event;
			},
		});

		observe(startEvent, {} as never);
		observe(endEvent, {} as never);

		expect(startEvent.toolCallId).toBe('call-1');
		expect(startEvent.args).toEqual({ command: 'print-secret' });
		expect(endEvent.toolCallId).toBe('call-1');
		expect(endEvent.result).toBe('secret output');
		expect(tracer.spans[0]?.attributes).toMatchObject({
			'flue.tool.call_id': 'call-1',
			'flue.tool.arguments': '{"command":"<redacted>"}',
			'flue.tool.result': '<redacted>',
		});
		expect(tracer.spans[0]?.status?.message).toBe('<redacted>');
		expect(tracer.spans[0]?.ended).toBe(true);
	});
});
