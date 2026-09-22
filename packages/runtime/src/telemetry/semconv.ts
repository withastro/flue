/**
 * GenAI semantic-convention vocabulary shared by the trace backends.
 *
 * This is the single home for the content attribute names and the revision
 * stamps of the projection contract; `@flue/opentelemetry` re-exports the
 * revision constants unchanged. Keeping the vocabulary next to the projection
 * (and to the runtime types it projects) is the point of the
 * `@flue/runtime/telemetry` subpath: both change together, in one release.
 */

/**
 * Upstream semconv commit the `gen_ai.*` keys and shapes were read from.
 *
 * This pin is the whole provenance story: the GenAI conventions repo has not
 * published an OTel schema URL (its README's "Schema URL" section is TODO),
 * so no `schemaUrl` is declared on any tracer/meter — fabricating one would
 * hand schema-aware tooling a dead link with defined semantics.
 */
export const GEN_AI_SEMCONV_REVISION = '4c8addb53718b544134be47e256237026fe88875';
/** Bumped when the role/parts message projection changes shape. */
export const GEN_AI_PROJECTION_REVISION = 5;
/**
 * Bumped when the `flue.*` extension vocabulary changes. Revision 5: the
 * `flue.tool.call.arguments`/`flue.tool.call.result` fallback keys are gone —
 * tool payloads of every shape record under the semconv `gen_ai.tool.call.*`
 * keys, which type them `any` and sanction JSON-string form on spans.
 * (Revision 4 moved truncation/omission markers in-band; see `./truncate.ts`.)
 */
export const FLUE_TELEMETRY_EXTENSION_REVISION = 5;

/**
 * Content-bearing attribute names. `gen_ai.*` keys follow the OpenTelemetry
 * GenAI semantic conventions (Development status). The `gen_ai.tool.call.*`
 * keys are typed `any` there: structured form is preferred, and JSON-string
 * form is sanctioned on spans when the attribute store cannot hold objects —
 * which is every span attribute store this runtime writes to. Tool payloads
 * of every shape therefore ride the semconv keys.
 */
export const CONTENT_ATTR = {
	inputMessages: 'gen_ai.input.messages',
	outputMessages: 'gen_ai.output.messages',
	systemInstructions: 'gen_ai.system_instructions',
	toolDefinitions: 'gen_ai.tool.definitions',
	toolDescription: 'gen_ai.tool.description',
	toolArguments: 'gen_ai.tool.call.arguments',
	toolResult: 'gen_ai.tool.call.result',
} as const;
