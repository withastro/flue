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
	filename: v.optional(v.string()),
});

export const DirectAgentPayloadSchema = v.object({
	message: v.string(),
	images: v.optional(v.array(DirectAgentImageSchema)),
});

export const WorkflowRouteParamSchema = v.object({ name: v.string() });
/** Shared `?wait` query contract for agent and workflow invocation routes. */
export const InvocationQuerySchema = v.object({
	wait: v.optional(v.literal('result')),
});
export const AgentRouteParamSchema = v.object({ name: v.string(), id: v.string() });
