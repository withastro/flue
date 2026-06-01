import {
	type AttributeValue,
	type Context,
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
import { describe, expect, it } from 'vitest';
import { createOpenTelemetryObserver } from '../src/index.ts';

class RecordingSpan implements Span {
	readonly attributes: Record<string, AttributeValue> = {};
	readonly events: Array<{ name: string; attributes?: Record<string, AttributeValue> }> = [];
	readonly exceptions: unknown[] = [];
	status?: SpanStatus;
	ended = false;

	constructor(
		readonly name: string,
		readonly options: SpanOptions | undefined,
		readonly parent: Span | undefined,
	) {
		Object.assign(this.attributes, options?.attributes);
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

	addLink(_link: Link) {
		return this;
	}
	addLinks(_links: Link[]) {
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
		expect(tracer.spans[0]?.attributes).not.toHaveProperty('flue.workflow.restarted_from_run_id');
		expect(tracer.spans[0]?.attributes).not.toHaveProperty('flue.workflow.payload');
		expect(tracer.spans[2]?.attributes).toMatchObject({
			'gen_ai.request.model': 'sonnet',
			'gen_ai.usage.input_tokens': 2,
			'gen_ai.usage.output_tokens': 3,
		});
		expect(tracer.spans.every((span) => span.ended)).toBe(true);
	});

	it('starts a recovered run-handling segment when terminalization continues after interruption', () => {
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
		expect(tracer.spans[1]?.attributes).not.toHaveProperty('flue.workflow.resumed');
		expect(tracer.spans.every((span) => span.ended)).toBe(true);
	});

	it('does not export failed task result content unless capture is enabled', () => {
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

	it('traces standalone harness tools and only captures content when enabled', () => {
		const tracer = new RecordingTracer();
		const observe = createOpenTelemetryObserver({ tracer: tracer as never, captureContent: true });
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
});
