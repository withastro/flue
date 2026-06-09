import * as v from 'valibot';
import type { FlueEvent } from '../types.ts';

const RunStatusSchema = v.picklist(['active', 'completed', 'errored']);

export const ErrorEnvelopeSchema = v.object({
	error: v.object({
		type: v.string(),
		message: v.string(),
		details: v.string(),
		dev: v.optional(v.string()),
		meta: v.optional(v.record(v.string(), v.unknown())),
	}),
});

const RunOwnerSchema = v.object({
	kind: v.literal('workflow'),
	workflowName: v.string(),
	instanceId: v.string(),
});

export const RunRecordSchema = v.object({
	runId: v.string(),
	owner: RunOwnerSchema,
	status: RunStatusSchema,
	startedAt: v.string(),
	payload: v.optional(v.unknown()),
	endedAt: v.optional(v.string()),
	isError: v.optional(v.boolean()),
	durationMs: v.optional(v.number()),
	result: v.optional(v.unknown()),
	error: v.optional(v.unknown()),
});

const RunPointerSchema = v.object({
	runId: v.string(),
	owner: RunOwnerSchema,
	status: RunStatusSchema,
	startedAt: v.string(),
	endedAt: v.optional(v.string()),
	durationMs: v.optional(v.number()),
	isError: v.optional(v.boolean()),
});

const EventBaseSchema = {
	runId: v.optional(v.string()),
	instanceId: v.optional(v.string()),
	dispatchId: v.optional(v.string()),
	eventIndex: v.optional(v.number()),
	timestamp: v.optional(v.string()),
	session: v.optional(v.string()),
	parentSession: v.optional(v.string()),
	taskId: v.optional(v.string()),
	harness: v.optional(v.string()),
	operationId: v.optional(v.string()),
	turnId: v.optional(v.string()),
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

const LlmTextContentSchema = v.object({
	type: v.literal('text'),
	text: v.string(),
	textSignature: v.optional(v.string()),
});

const LlmThinkingContentSchema = v.object({
	type: v.literal('thinking'),
	thinking: v.string(),
	thinkingSignature: v.optional(v.string()),
	redacted: v.optional(v.boolean()),
});

const LlmImageContentSchema = v.object({
	type: v.literal('image'),
	data: v.string(),
	mimeType: v.string(),
});

const LlmToolCallSchema = v.object({
	type: v.literal('toolCall'),
	id: v.string(),
	name: v.string(),
	arguments: v.record(v.string(), v.unknown()),
	thoughtSignature: v.optional(v.string()),
});

const LlmUserMessageSchema = v.object({
	role: v.literal('user'),
	content: v.union([v.string(), v.array(v.union([LlmTextContentSchema, LlmImageContentSchema]))]),
});

const LlmAssistantMessageSchema = v.object({
	role: v.literal('assistant'),
	content: v.array(v.union([LlmTextContentSchema, LlmThinkingContentSchema, LlmToolCallSchema])),
});

const LlmToolResultMessageSchema = v.object({
	role: v.literal('toolResult'),
	toolCallId: v.string(),
	toolName: v.string(),
	content: v.array(v.union([LlmTextContentSchema, LlmImageContentSchema])),
	isError: v.boolean(),
});

const LlmMessageSchema = v.union([
	LlmUserMessageSchema,
	LlmAssistantMessageSchema,
	LlmToolResultMessageSchema,
]);

const LlmToolSchema = v.object({
	name: v.string(),
	description: v.string(),
	parameters: v.unknown(),
});

const FlueEventSchema = v.union([
	flueEvent({
		type: v.literal('run_start'),
		runId: v.string(),
		owner: v.object({
			kind: v.literal('workflow'),
			workflowName: v.string(),
			instanceId: v.string(),
		}),
		instanceId: v.string(),
		workflowName: v.string(),
		startedAt: v.string(),
		payload: v.unknown(),
	}),
	flueEvent({
		type: v.literal('run_resume'),
		runId: v.string(),
		owner: v.object({
			kind: v.literal('workflow'),
			workflowName: v.string(),
			instanceId: v.string(),
		}),
		instanceId: v.string(),
		workflowName: v.string(),
		startedAt: v.string(),
	}),
	flueEvent({ type: v.literal('agent_start') }),
	flueEvent({ type: v.literal('agent_end'), messages: v.array(v.any()) }),
	flueEvent({
		type: v.literal('turn_start'),
		turnId: v.string(),
		purpose: v.picklist(['agent', 'compaction', 'compaction_prefix']),
	}),
	flueEvent({
		type: v.literal('turn_request'),
		turnId: v.string(),
		purpose: v.picklist(['agent', 'compaction', 'compaction_prefix']),
		model: v.string(),
		provider: v.string(),
		api: v.string(),
		input: v.object({
			systemPrompt: v.optional(v.string()),
			messages: v.array(LlmMessageSchema),
			tools: v.optional(v.array(LlmToolSchema)),
		}),
		reasoning: v.optional(v.string()),
	}),
	flueEvent({
		type: v.literal('turn_end'),
		turnId: v.string(),
		purpose: v.picklist(['agent', 'compaction', 'compaction_prefix']),
		message: v.any(),
		toolResults: v.array(v.any()),
	}),
	flueEvent({ type: v.literal('message_start'), message: v.any() }),
	flueEvent({
		type: v.literal('message_update'),
		message: v.any(),
		assistantMessageEvent: v.unknown(),
	}),
	flueEvent({ type: v.literal('message_end'), message: v.any() }),
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
		turnId: v.string(),
		purpose: v.picklist(['agent', 'compaction', 'compaction_prefix']),
		durationMs: v.number(),
		model: v.optional(v.string()),
		provider: v.optional(v.string()),
		api: v.optional(v.string()),
		output: v.optional(LlmAssistantMessageSchema),
		usage: v.optional(PromptUsageSchema),
		stopReason: v.optional(v.string()),
		isError: v.boolean(),
		error: v.optional(v.unknown()),
	}),
	flueEvent({
		type: v.literal('task_start'),
		taskId: v.string(),
		prompt: v.string(),
		agent: v.optional(v.string()),
		cwd: v.optional(v.string()),
	}),
	flueEvent({
		type: v.literal('task'),
		taskId: v.string(),
		agent: v.optional(v.string()),
		isError: v.boolean(),
		result: v.optional(v.unknown()),
		durationMs: v.number(),
	}),
	flueEvent({
		type: v.literal('compaction_start'),
		reason: v.picklist(['threshold', 'overflow', 'manual']),
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
		operationKind: v.picklist(['prompt', 'skill', 'task', 'shell', 'compact']),
	}),
	flueEvent({
		type: v.literal('operation'),
		operationId: v.string(),
		operationKind: v.picklist(['prompt', 'skill', 'task', 'shell', 'compact']),
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
]);

type _EventSchemaAssignableToRuntime =
	v.InferOutput<typeof FlueEventSchema> extends FlueEvent ? true : never;
const _eventSchemaTypeCheck: _EventSchemaAssignableToRuntime = true;
void _eventSchemaTypeCheck;

export const AgentInvocationResponseSchema = v.object({
	result: v.unknown(),
	streamUrl: v.string(),
	offset: v.string(),
});

export const WorkflowInvocationResponseSchema = v.object({
	result: v.unknown(),
	_meta: v.object({ runId: v.string() }),
});

export const WorkflowAdmissionResponseSchema = v.object({
	status: v.literal('accepted'),
	runId: v.string(),
});

const integerString = (message: string) => v.pipe(v.string(), v.regex(/^\d+$/, message));

export const RunIdParamSchema = v.object({ runId: v.string() });
export const WorkflowRouteParamSchema = v.object({ name: v.string() });
export const WorkflowInvocationQuerySchema = v.object({
	wait: v.optional(v.literal('result')),
});
export const AgentRouteParamSchema = v.object({ name: v.string(), id: v.string() });

const AgentManifestEntrySchema = v.object({
	name: v.string(),
	transports: v.object({
		http: v.optional(v.literal(true)),
	}),
	created: v.boolean(),
});

export const ListAgentsResponseSchema = v.object({
	items: v.array(AgentManifestEntrySchema),
});

export const ListRunsResponseSchema = v.object({
	items: v.array(RunPointerSchema),
	nextCursor: v.optional(v.string()),
});

const ListLimitSchema = v.optional(
	v.pipe(
		integerString('limit must be an integer between 1 and 1000.'),
		v.transform(Number),
		v.minValue(1, 'limit must be at least 1.'),
		v.maxValue(1000, 'limit must be at most 1000.'),
	),
);

export const AdminRunsQuerySchema = v.object({
	status: v.optional(RunStatusSchema),
	workflowName: v.optional(v.string()),
	cursor: v.optional(v.string()),
	limit: ListLimitSchema,
});
