import * as v from 'valibot';

export const MAX_IMAGE_DATA_LENGTH = 14 * 1024 * 1024;

const DirectAgentImageSchema = v.object({
	type: v.literal('image'),
	data: v.pipe(
		v.string(),
		v.maxLength(
			MAX_IMAGE_DATA_LENGTH,
			`Image data exceeds the ${MAX_IMAGE_DATA_LENGTH} character limit.`,
		),
	),
	mimeType: v.string(),
});

export const DirectAgentPayloadSchema = v.object({
	message: v.string(),
	images: v.optional(v.array(DirectAgentImageSchema)),
});

export const ErrorEnvelopeSchema = v.object({
	error: v.object({
		type: v.string(),
		message: v.string(),
		details: v.string(),
		dev: v.optional(v.string()),
		meta: v.optional(v.record(v.string(), v.unknown())),
	}),
});

// Invocation response envelopes. All four responses share one flat
// convention: `streamUrl` + `offset` are server-provided DS stream
// coordinates on every response, `runId` appears on workflow responses only
// (runs are workflow-only), `submissionId` appears on agent responses only,
// and sync responses add `result`.

export const AgentAdmissionResponseSchema = v.object({
	streamUrl: v.string(),
	offset: v.string(),
	submissionId: v.string(),
});

export const AgentInvocationResponseSchema = v.object({
	result: v.unknown(),
	streamUrl: v.string(),
	offset: v.string(),
	submissionId: v.string(),
});

export const WorkflowAdmissionResponseSchema = v.object({
	runId: v.string(),
	streamUrl: v.string(),
	offset: v.string(),
});

export const WorkflowInvocationResponseSchema = v.object({
	result: v.unknown(),
	runId: v.string(),
	streamUrl: v.string(),
	offset: v.string(),
});

export const WorkflowRouteParamSchema = v.object({ name: v.string() });
/** Shared `?wait` query contract for agent and workflow invocation routes. */
export const InvocationQuerySchema = v.object({
	wait: v.optional(v.literal('result')),
});
export const AgentRouteParamSchema = v.object({ name: v.string(), id: v.string() });
