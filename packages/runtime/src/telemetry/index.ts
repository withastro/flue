/**
 * `@flue/runtime/telemetry` — the backend-neutral GenAI content machinery
 * shared by the native Cloudflare tracing adapter and `@flue/opentelemetry`:
 * the role/parts message projection, the content pipeline
 * (detach → transform → serialize → truncate-at-budget), the in-band
 * truncation helper, and the semconv vocabulary/revision stamps.
 *
 * This entry is Node-evaluable and dependency-free — no `cloudflare:workers`,
 * no `@opentelemetry/api`. It lives as a runtime subpath (not a standalone
 * package) because the projection is a function of the runtime's own
 * message/event types and must version atomically with them.
 */
export {
	CONTENT_BUDGET_BYTES,
	assertContentBudgetBytes,
	type ContentAttributeOptions,
	type ContentAttributeResult,
	type ContentDrawOptions,
	type ContentLedger,
	type ContentOption,
	type ContentTransform,
	contentAttribute,
	createContentLedger,
	drawContentAttribute,
	type GenAIContentScope,
	type GenAIContentType,
	OUTPUT_CONTENT_RESERVE_BYTES,
} from './content.ts';
export {
	agentInputMessage,
	agentOutputMessage,
	type GenAIContent,
	inputMessages,
	normalizeFinishReason,
	outputMessages,
	systemInstructions,
	toolDefinitions,
} from './projection.ts';
export {
	CONTENT_ATTR,
	FLUE_TELEMETRY_EXTENSION_REVISION,
	GEN_AI_PROJECTION_REVISION,
	GEN_AI_SEMCONV_REVISION,
} from './semconv.ts';
export {
	CONTENT_BUDGET_EXCEEDED,
	CONTENT_TRANSFORM_FAILED,
	CONTENT_UNSERIALIZABLE,
	truncateContent,
} from './truncate.ts';
