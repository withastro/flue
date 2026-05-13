import * as v from 'valibot';
import type { FlueEvent } from '../types.ts';

export const RunStatusSchema = v.picklist(['active', 'completed', 'errored']);

export const ErrorEnvelopeSchema = v.object({
	error: v.object({
		type: v.string(),
		message: v.string(),
		details: v.string(),
		dev: v.optional(v.string()),
		meta: v.optional(v.record(v.string(), v.unknown())),
	}),
});

export const RunRecordSchema = v.object({
	runId: v.string(),
	instanceId: v.string(),
	agentName: v.string(),
	status: RunStatusSchema,
	startedAt: v.string(),
	endedAt: v.optional(v.string()),
	isError: v.optional(v.boolean()),
	durationMs: v.optional(v.number()),
	result: v.optional(v.unknown()),
	error: v.optional(v.unknown()),
});

export const RunPointerSchema = v.object({
	runId: v.string(),
	agentName: v.string(),
	instanceId: v.string(),
	status: RunStatusSchema,
	startedAt: v.string(),
	endedAt: v.optional(v.string()),
	durationMs: v.optional(v.number()),
	isError: v.optional(v.boolean()),
});

const EventBaseSchema = {
	runId: v.optional(v.string()),
	eventIndex: v.optional(v.number()),
	timestamp: v.optional(v.string()),
	session: v.optional(v.string()),
	parentSession: v.optional(v.string()),
	taskId: v.optional(v.string()),
	harness: v.optional(v.string()),
	operationId: v.optional(v.string()),
} satisfies v.ObjectEntries;

const flueEvent = <const TEntries extends v.ObjectEntries>(entries: TEntries) =>
	v.looseObject({ ...EventBaseSchema, ...entries });

const PromptUsageSchema = v.object({
	input: v.number(),
	output: v.number(),
	cacheRead: v.number(),
	cacheWrite: v.number(),
	totalTokens: v.number(),
	cost: v.object({
		input: v.number(),
		output: v.number(),
		cacheRead: v.number(),
		cacheWrite: v.number(),
		total: v.number(),
	}),
});

const TruncatedEventSchema = flueEvent({
	type: v.string(),
	truncated: v.literal(true),
	originalSize: v.number(),
	preview: v.string(),
});

export const FLUE_EVENT_TYPES = [
	'run_start',
	'text_delta',
	'thinking_start',
	'thinking_delta',
	'thinking_end',
	'tool_start',
	'tool_call',
	'turn',
	'task_start',
	'task',
	'compaction_start',
	'compaction',
	'operation_start',
	'operation',
	'log',
	'idle',
	'run_end',
] as const;

export const FlueEventSchema = v.union([
	flueEvent({
		type: v.literal('run_start'),
		runId: v.string(),
		instanceId: v.string(),
		agentName: v.string(),
		startedAt: v.string(),
		payload: v.unknown(),
	}),
	flueEvent({ type: v.literal('text_delta'), text: v.string() }),
	flueEvent({ type: v.literal('thinking_start') }),
	flueEvent({ type: v.literal('thinking_delta'), delta: v.string() }),
	flueEvent({ type: v.literal('thinking_end'), content: v.string() }),
	flueEvent({
		type: v.literal('tool_start'),
		toolName: v.string(),
		toolCallId: v.string(),
		args: v.optional(v.unknown()),
	}),
	flueEvent({
		type: v.literal('tool_call'),
		toolName: v.string(),
		toolCallId: v.string(),
		isError: v.boolean(),
		result: v.optional(v.unknown()),
		durationMs: v.number(),
	}),
	flueEvent({
		type: v.literal('turn'),
		durationMs: v.number(),
		model: v.optional(v.string()),
		usage: v.optional(PromptUsageSchema),
		stopReason: v.optional(v.string()),
		isError: v.boolean(),
		error: v.optional(v.unknown()),
	}),
	flueEvent({
		type: v.literal('task_start'),
		taskId: v.string(),
		prompt: v.string(),
		role: v.optional(v.string()),
		cwd: v.optional(v.string()),
	}),
	flueEvent({
		type: v.literal('task'),
		taskId: v.string(),
		isError: v.boolean(),
		result: v.optional(v.unknown()),
		durationMs: v.number(),
	}),
	flueEvent({
		type: v.literal('compaction_start'),
		reason: v.picklist(['threshold', 'overflow']),
		estimatedTokens: v.number(),
	}),
	flueEvent({
		type: v.literal('compaction'),
		messagesBefore: v.number(),
		messagesAfter: v.number(),
		durationMs: v.number(),
		usage: v.optional(PromptUsageSchema),
	}),
	flueEvent({
		type: v.literal('operation_start'),
		operationId: v.string(),
		operationKind: v.picklist(['prompt', 'skill', 'task', 'shell']),
	}),
	flueEvent({
		type: v.literal('operation'),
		operationId: v.string(),
		operationKind: v.picklist(['prompt', 'skill', 'task', 'shell']),
		durationMs: v.number(),
		isError: v.boolean(),
		error: v.optional(v.unknown()),
		result: v.optional(v.unknown()),
		usage: v.optional(PromptUsageSchema),
	}),
	flueEvent({
		type: v.literal('log'),
		level: v.picklist(['info', 'warn', 'error']),
		message: v.string(),
		attributes: v.optional(v.record(v.string(), v.unknown())),
	}),
	flueEvent({ type: v.literal('idle') }),
	flueEvent({
		type: v.literal('run_end'),
		runId: v.string(),
		result: v.optional(v.unknown()),
		isError: v.boolean(),
		error: v.optional(v.unknown()),
		durationMs: v.number(),
	}),
	TruncatedEventSchema,
]);

type NonTruncatedSchemaEvent = Exclude<v.InferOutput<typeof FlueEventSchema>, { truncated: true }>;
type _NonTruncatedEventSchemaAssignableToRuntime = NonTruncatedSchemaEvent extends FlueEvent
	? true
	: never;
// One-way check: every non-truncated schema variant must stay inside the
// runtime's published event type. The schema also documents persisted
// truncation envelopes from `truncateEventForPersistence`; those are runtime
// artifacts intentionally kept out of the public TypeScript discriminant so
// user narrowing on `event.type` remains precise.
const _eventSchemaTypeCheck: _NonTruncatedEventSchemaAssignableToRuntime = true;
void _eventSchemaTypeCheck;

export const RunEventListResponseSchema = v.object({
	events: v.array(FlueEventSchema),
});

export const AgentInvocationResponseSchema = v.object({
	result: v.unknown(),
	_meta: v.object({ runId: v.string() }),
});

export const WebhookInvocationResponseSchema = v.object({
	status: v.literal('accepted'),
	runId: v.string(),
});

export const AgentInvocationBodySchema = v.looseObject({});

const integerString = (message: string) => v.pipe(v.string(), v.regex(/^\d+$/, message));
const eventTypesPattern = new RegExp(
	`^(${FLUE_EVENT_TYPES.join('|')})(,(${FLUE_EVENT_TYPES.join('|')}))*$`,
);

export const RunEventsQuerySchema = v.object({
	after: v.optional(integerString('after must be a non-negative integer.')),
	types: v.optional(
		v.pipe(
			v.string(),
			v.regex(eventTypesPattern, 'types must be a comma-separated list of known event type names.'),
		),
	),
	limit: v.optional(
		v.pipe(
			integerString('limit must be an integer between 1 and 1000.'),
			v.transform(Number),
			v.minValue(1, 'limit must be at least 1.'),
			v.maxValue(1000, 'limit must be at most 1000.'),
		),
	),
});

export const RunIdParamSchema = v.object({ runId: v.string() });
export const AgentRouteParamSchema = v.object({ name: v.string(), id: v.string() });

export const AgentManifestEntrySchema = v.object({
	name: v.string(),
	triggers: v.object({ webhook: v.optional(v.boolean()) }),
});

export const InstanceSummarySchema = v.object({
	agentName: v.string(),
	instanceId: v.string(),
});

export const ListAgentsResponseSchema = v.object({
	items: v.array(AgentManifestEntrySchema),
	nextCursor: v.optional(v.string()),
});

export const ListInstancesResponseSchema = v.object({
	items: v.array(InstanceSummarySchema),
	nextCursor: v.optional(v.string()),
});

export const ListRunsResponseSchema = v.object({
	items: v.array(RunPointerSchema),
	nextCursor: v.optional(v.string()),
});

export const AgentNameParamSchema = v.object({ name: v.string() });
export const AgentInstanceParamSchema = v.object({ name: v.string(), id: v.string() });

const ListLimitSchema = v.optional(
	v.pipe(
		integerString('limit must be an integer between 1 and 1000.'),
		v.transform(Number),
		v.minValue(1, 'limit must be at least 1.'),
		v.maxValue(1000, 'limit must be at most 1000.'),
	),
);

export const AdminInstancesQuerySchema = v.object({
	cursor: v.optional(v.string()),
	limit: ListLimitSchema,
});

export const AdminInstanceRunsQuerySchema = v.object({
	status: v.optional(RunStatusSchema),
	cursor: v.optional(v.string()),
	limit: ListLimitSchema,
});

export const AdminRunsQuerySchema = v.object({
	status: v.optional(RunStatusSchema),
	agentName: v.optional(v.string()),
	cursor: v.optional(v.string()),
	limit: ListLimitSchema,
});
