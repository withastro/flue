/**
 * GenAI semantic-convention vocabulary shared by the trace backends.
 *
 * This is the single home for the content attribute names and the revision
 * stamps of the projection contract; `@flue/opentelemetry` re-exports the
 * revision constants unchanged. Keeping the vocabulary next to the projection
 * (and to the runtime types it projects) is the point of the
 * `@flue/runtime/telemetry` subpath: both change together, in one release.
 */

/** Upstream semconv commit the `gen_ai.*` keys and shapes were read from. */
export const GEN_AI_SEMCONV_REVISION = '4c8addb53718b544134be47e256237026fe88875';
/** Bumped when the role/parts message projection changes shape. */
export const GEN_AI_PROJECTION_REVISION = 5;
export const GEN_AI_SCHEMA_URL = 'https://opentelemetry.io/schemas/gen-ai-dev/1.42.0-dev';
/**
 * Bumped when the `flue.*` extension vocabulary changes. Revision 4: the
 * `flue.telemetry.content.<type>.truncated/.omitted` marker attributes are
 * gone — truncation and omission are represented in-band, inside the content
 * payload, by `[flue]`-prefixed sentinels (see `./truncate.ts`).
 */
export const FLUE_TELEMETRY_EXTENSION_REVISION = 4;

/**
 * Content-bearing attribute names. `gen_ai.*` keys follow the OpenTelemetry
 * GenAI semantic conventions (Development status). The two `flue.*` keys are
 * the fallback names for tool payloads that are not plain objects — the
 * semconv `gen_ai.tool.call.*` keys are specified as object-shaped, so
 * non-object payloads move to the extension namespace rather than lie about
 * their shape.
 */
export const CONTENT_ATTR = {
	inputMessages: 'gen_ai.input.messages',
	outputMessages: 'gen_ai.output.messages',
	systemInstructions: 'gen_ai.system_instructions',
	toolDefinitions: 'gen_ai.tool.definitions',
	toolDescription: 'gen_ai.tool.description',
	toolArguments: 'gen_ai.tool.call.arguments',
	toolResult: 'gen_ai.tool.call.result',
	toolArgumentsRaw: 'flue.tool.call.arguments',
	toolResultRaw: 'flue.tool.call.result',
} as const;
