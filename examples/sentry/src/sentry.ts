// flue-blueprint: tooling/sentry@3

/**
 * Sentry observability for Flue.
 *
 * This file is the entire integration. It does three things:
 *
 *   1. Initializes the Sentry Node SDK at module scope so every process
 *      that imports it has a configured Sentry client, with tracing and
 *      Sentry Logs enabled.
 *
 *   2. When SENTRY_TRACES_SAMPLE_RATE > 0, registers Flue's OpenTelemetry
 *      instrumentation. Sentry's SDK owns the global tracer provider, so
 *      Flue's `invoke_agent` → `chat` / `execute_tool` span hierarchy —
 *      token usage included — lands in Sentry as one trace per operation.
 *
 *   3. Registers a keyed Flue instrumentation whose observer turns
 *      terminal failures into Sentry issues and forwards every `log.*`
 *      call to Sentry Logs at its own level.
 *
 * Issues are limited to terminal failures: a failed operation or a failed
 * durable submission. Recovered errors an agent logs and moves past stay
 * logs — they arrive in Sentry Logs on the same trace, not as issues.
 *
 * Model and tool content (prompts, completions, tool arguments/results)
 * stays out of traces unless SENTRY_AI_RECORD_INPUTS /
 * SENTRY_AI_RECORD_OUTPUTS opt in, and even then it passes through the
 * `scrub` redaction below.
 */

import {
	type ContentOption,
	createOpenTelemetryInstrumentation,
	type GenAIContentType,
	truncateContent,
} from '@flue/opentelemetry';
import { type FlueObservation, instrument } from '@flue/runtime';
import * as Sentry from '@sentry/node';

const recordInputs = process.env.SENTRY_AI_RECORD_INPUTS === 'true';
const recordOutputs = process.env.SENTRY_AI_RECORD_OUTPUTS === 'true';
const tracesSampleRate = clampRate(process.env.SENTRY_TRACES_SAMPLE_RATE, 0);

// Sentry ships integrations that patch AI provider SDKs directly. Flue's
// instrumentation already emits one `chat` span per model turn, so those
// integrations would double-count every model call.
const SENTRY_AI_PROVIDER_INTEGRATIONS = new Set([
	'Anthropic_AI',
	'OpenAI',
	'Google_GenAI',
	'LangChain',
	'LangGraph',
	'VercelAI',
]);

Sentry.init({
	dsn: process.env.SENTRY_DSN,
	enabled: Boolean(process.env.SENTRY_DSN),
	environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
	release: process.env.SENTRY_RELEASE,
	tracesSampleRate,
	// Stream spans to Sentry as each one finishes, so gen_ai children that
	// complete after their parent span are not lost.
	traceLifecycle: 'stream',
	streamGenAiSpans: true,
	enableLogs: true,
	integrations: (defaults) =>
		defaults.filter((integration) => !SENTRY_AI_PROVIDER_INTEGRATIONS.has(integration.name)),
});

// ─── Traces: Flue's OpenTelemetry instrumentation ───────────────────────────

// `Sentry.init` registered Sentry as the global OTel tracer provider, so
// Flue's spans flow to Sentry without further wiring. Content capture is
// on by default in the adapter; `contentPolicy()` narrows it to what the
// record flags allow. The instrumentation is keyed, so a `vite dev` reload
// replaces the previous registration instead of stacking a duplicate.
if (tracesSampleRate > 0) {
	instrument(createOpenTelemetryInstrumentation({ content: contentPolicy() }));
}

// ─── Issues and logs: the Flue → Sentry event bridge ────────────────────────

// A failed submission emits a rich `operation` failure first (the original
// error, with the throw-site stack on the live `errorInfo`) and then a
// `submission_settled` whose durable `error` collapses non-Flue causes to a
// generic internal-error payload. Capture the operation and remember its
// submissionId so the settlement is skipped; a settlement with no captured
// operation (reconciled after a crash) is captured from its own `errorInfo`.
const capturedFailedSubmissions = new Set<string>();

// Best-effort flush of buffered events (notably Sentry Logs, which the SDK
// batches) on shutdown. Never call process.exit() here — Flue's generated
// server handles SIGINT/SIGTERM, awaits its lifecycle stop, and exits with
// the correct code; this listener only flushes within that window. It is not
// a delivery guarantee: the server exits as soon as its stop resolves and
// Node does not await promises started by signal listeners, so a flush still
// in flight can be cut short. Traces and issues are sent during the run;
// only very-recently-buffered logs are at risk.
const flush = () => void Sentry.flush(2000);
if (process.env.SENTRY_DSN) {
	process.on('SIGINT', flush);
	process.on('SIGTERM', flush);
}

instrument({
	// Keyed registration: on a `vite dev` reload this module re-evaluates
	// while the runtime's registry persists, and the newest install wins —
	// the previous bridge (and its signal listeners) is disposed, so no
	// event is ever double-reported.
	key: Symbol.for('flue.sentry.bridge'),
	observe(event) {
		if (event.type === 'operation' && event.isError) {
			captureTerminalFailure(event.errorInfo ?? event.error, correlationTags(event), {
				durationMs: event.durationMs,
				operationKind: event.operationKind,
			});
			if (event.submissionId) capturedFailedSubmissions.add(event.submissionId);
			return;
		}
		if (event.type === 'submission_settled') {
			const alreadyCaptured = capturedFailedSubmissions.delete(event.submissionId);
			if (event.outcome === 'failed' && !alreadyCaptured) {
				captureTerminalFailure(event.errorInfo ?? event.error, correlationTags(event));
			}
			return;
		}
		if (event.type === 'log') {
			Sentry.logger[event.level](event.message, logAttributes(event));
		}
	},
	interceptor: (_operation, _ctx, next) => next(),
	async dispose() {
		process.off('SIGINT', flush);
		process.off('SIGTERM', flush);
		await Sentry.flush(2000);
	},
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function captureTerminalFailure(
	error: unknown,
	tags: Record<string, string>,
	context?: Record<string, unknown>,
): void {
	Sentry.withScope((scope) => {
		scope.setTags(tags);
		scope.setLevel('error');
		if (context) scope.setContext('flue.incident', context);
		Sentry.captureException(toError(error));
	});
}

/**
 * Build the Sentry tags attached to every capture from this bridge. Tag keys
 * use the `flue.*` prefix — the same names the trace spans carry — so
 * pivoting on `flue.instance.id` in Sentry's search box finds every issue,
 * log, and span from a single agent instance.
 */
function correlationTags(event: FlueObservation): Record<string, string> {
	const tags: Record<string, string> = {};
	if (event.instanceId) tags['flue.instance.id'] = event.instanceId;
	if (event.agentName) tags['flue.agent.name'] = event.agentName;
	if (event.conversationId) tags['flue.conversation.id'] = event.conversationId;
	if (event.submissionId) tags['flue.submission.id'] = event.submissionId;
	if (event.harness) tags['flue.harness'] = event.harness;
	if (event.session) tags['flue.session'] = event.session;
	if (event.parentSession) tags['flue.parent_session'] = event.parentSession;
	if (event.operationId) tags['flue.operation.id'] = event.operationId;
	if (event.taskId) tags['flue.task.id'] = event.taskId;
	return tags;
}

type LogAttribute = string | number | boolean;

function logAttributes(
	event: Extract<FlueObservation, { type: 'log' }>,
): Record<string, LogAttribute> {
	const attributes: Record<string, LogAttribute> = {};
	for (const [key, value] of Object.entries(correlationTags(event))) attributes[key] = value;
	for (const [key, value] of Object.entries(event.attributes ?? {})) {
		const scrubbed = scrub(value);
		attributes[`flue.log.${key}`] =
			typeof scrubbed === 'string' || typeof scrubbed === 'number' || typeof scrubbed === 'boolean'
				? scrubbed
				: stringify(scrubbed);
	}
	return attributes;
}

/**
 * The content policy for trace spans. With both record flags off, no model
 * or tool content reaches Sentry at all (`content: false`). With either flag
 * on, the transform admits only the enabled direction, scrubs sensitive keys,
 * and tightens the adapter's default 56 KiB budget to 16 KiB per attribute.
 */
function contentPolicy(): ContentOption {
	if (!recordInputs && !recordOutputs) return false;
	return {
		transform(content, scope) {
			if (isInputContent(scope.contentType) && !recordInputs) return undefined;
			if (isOutputContent(scope.contentType) && !recordOutputs) return undefined;
			return truncateContent(scrub(content), { maxBytes: 16_384 });
		},
	};
}

function isInputContent(contentType: GenAIContentType): boolean {
	return (
		contentType === 'input_messages' ||
		contentType === 'system_instructions' ||
		contentType === 'tool_definitions' ||
		contentType === 'tool_description' ||
		contentType === 'tool_arguments'
	);
}

function isOutputContent(contentType: GenAIContentType): boolean {
	return (
		contentType === 'output_messages' ||
		contentType === 'tool_result' ||
		contentType === 'exception_message' ||
		contentType === 'exception_stacktrace'
	);
}

const SENSITIVE_KEY = /api[-_]?key|authorization|cookie|dsn|password|secret|token/i;

function scrub(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
	if (depth > 8) return '[truncated]';
	if (value instanceof Error) return { name: value.name, message: value.message };
	if (value === null || typeof value !== 'object') return value;
	if (seen.has(value)) return '[circular]';
	seen.add(value);
	if (Array.isArray(value)) return value.map((item) => scrub(item, seen, depth + 1));
	return Object.fromEntries(
		Object.entries(value).map(([key, nested]) => [
			key,
			SENSITIVE_KEY.test(key) ? '[redacted]' : scrub(nested, seen, depth + 1),
		]),
	);
}

/**
 * Reconstruct an `Error` from whatever the event carried: a live `Error`, a
 * serialized envelope (`{ name, message, stack? }`), or an arbitrary thrown
 * value. Sentry groups issues far better when given a real `Error` with a
 * stable name and message — and a `stack` when the live `errorInfo` had one.
 */
function toError(value: unknown): Error {
	if (value instanceof Error) return value;
	if (value && typeof value === 'object') {
		const source = value as { name?: unknown; message?: unknown; stack?: unknown };
		const error = new Error(typeof source.message === 'string' ? source.message : stringify(value));
		if (typeof source.name === 'string') error.name = source.name;
		if (typeof source.stack === 'string') error.stack = source.stack;
		return error;
	}
	return new Error(typeof value === 'string' ? value : stringify(value));
}

function stringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}

function clampRate(value: string | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
}
