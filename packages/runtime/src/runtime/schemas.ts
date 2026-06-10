import * as v from 'valibot';

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
