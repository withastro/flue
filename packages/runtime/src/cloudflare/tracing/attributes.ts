/**
 * Attribute keys for the native Cloudflare tracing adapter.
 *
 * `gen_ai.*` keys follow the OpenTelemetry GenAI semantic conventions where
 * they exist (Development status — centralizing them here keeps spec churn a
 * one-file edit; none of these constants are exported from the package). The
 * key set deliberately mirrors `@flue/opentelemetry`'s projection so a Flue
 * agent reads the same across OTel backends and the Cloudflare dashboard —
 * restricted to the scalar subset Workers `Span.setAttribute` accepts
 * (array-typed keys like `gen_ai.response.finish_reasons` are omitted rather
 * than JSON-encoded under an array-typed name).
 *
 * Non-`gen_ai.*` keys come from the general OpenTelemetry conventions
 * (`error.type`, `server.*`, `session.id`). Flue-specific keys live under
 * `flue.*`. The `cloudflare.agents.*` namespace belongs to Cloudflare's
 * agents SDK and is not emitted here.
 */
export const ATTR = {
	operationName: 'gen_ai.operation.name',
	providerName: 'gen_ai.provider.name',
	requestModel: 'gen_ai.request.model',
	responseModel: 'gen_ai.response.model',
	responseId: 'gen_ai.response.id',
	/**
	 * GenAI registry: "The unique identifier for a conversation (session,
	 * thread), used to store and correlate messages within this
	 * conversation."
	 * https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/registry/attributes/gen-ai.md
	 *
	 * Always the conversation doing the work: a delegated task runs in its
	 * own conversation with its own message history (it never sees the
	 * parent's), so its spans report that conversation, not the parent's.
	 * Grouping a parent with its delegates is `sessionId`'s job.
	 */
	conversationId: 'gen_ai.conversation.id',
	compacted: 'gen_ai.conversation.compacted',
	agentName: 'gen_ai.agent.name',
	requestStream: 'gen_ai.request.stream',
	reasoningLevel: 'gen_ai.request.reasoning.level',
	maxTokens: 'gen_ai.request.max_tokens',
	temperature: 'gen_ai.request.temperature',
	inputTokens: 'gen_ai.usage.input_tokens',
	outputTokens: 'gen_ai.usage.output_tokens',
	cacheReadTokens: 'gen_ai.usage.cache_read.input_tokens',
	cacheCreationTokens: 'gen_ai.usage.cache_creation.input_tokens',
	toolName: 'gen_ai.tool.name',
	toolCallId: 'gen_ai.tool.call.id',
	toolType: 'gen_ai.tool.type',
	errorType: 'error.type',
	serverAddress: 'server.address',
	serverPort: 'server.port',
	openaiApiType: 'openai.api.type',
	/**
	 * General session convention (not part of the GenAI registry, which
	 * defines no `session.*` key): "A unique ID to identify a session."
	 * Development status, Opt-In.
	 * https://opentelemetry.io/docs/specs/semconv/general/session/
	 * https://opentelemetry.io/docs/specs/semconv/registry/attributes/session/
	 *
	 * Flue's use is its own mapping, not something the convention
	 * prescribes: the Session is a root conversation plus everything it
	 * delegates, so the value is the root conversation id — equal to
	 * `gen_ai.conversation.id` on the root's own spans, inherited unchanged
	 * by every delegated task (any depth), model turn, and tool span beneath
	 * it. The convention's text frames sessions around client applications
	 * and inactivity/timeout rollover; Flue's server-side Session does
	 * neither and ends only with its root conversation. Absent (never
	 * synthesized) when the context carries no root.
	 */
	sessionId: 'session.id',
} as const;

export const FLUE_ATTR = {
	/**
	 * The agent instance id, same key `@flue/opentelemetry` uses. Deliberately
	 * not `gen_ai.agent.id`: the semconv reserves that for hosted-agent
	 * identifiers on the *client* invoke_agent variant (and recommends against
	 * in-memory instance ids); Flue's agent spans are the in-process variant.
	 */
	instanceId: 'flue.instance.id',
	submissionId: 'flue.submission.id',
	operationId: 'flue.operation.id',
	operationKind: 'flue.operation.kind',
	turnId: 'flue.turn.id',
	taskId: 'flue.task.id',
	toolOrigin: 'flue.tool.origin',
	turnPurpose: 'flue.turn.purpose',
	finishReason: 'flue.response.finish_reason',
	usageTotalTokens: 'flue.usage.total_tokens',
	/** Recognized cancellation — a control path, never counted as an error. */
	canceled: 'flue.canceled',
	/**
	 * Stamped on spans the adapter force-closes because their terminal event
	 * never arrived (value names the close path, e.g. `settlement`). Absent on
	 * every normally-closed span, so backends can measure lost primary closes.
	 */
	forcedClose: 'flue.span.forced_close',
	recoveryOperation: 'flue.recovery.operation',
	recoveryOutcome: 'flue.recovery.outcome',
	/** Phase of a `flue.coordinator` span; new phases extend this, not the span name. */
	coordinatorPhase: 'flue.coordinator.phase',
} as const;
