/**
 * Sentry observability for Flue.
 *
 * This file is the entire integration. It does three things:
 *
 *   1. Initializes the Sentry Node SDK at module scope so every isolate
 *      that imports `app.ts` has a configured Sentry client.
 *
 *   2. Calls `observe(...)` to register a global Flue event subscriber
 *      that translates Flue events into:
 *        - **gen_ai spans** for runs, LLM turns, and tool calls, using
 *          Sentry's AI Agent Monitoring semantic conventions.
 *        - **Sentry.logger** calls so handler logs appear in Sentry Logs.
 *        - **Sentry.captureException** for run-fatal errors and explicit
 *          `ctx.log.error(...)` calls.
 *
 *   3. Mounts the Flue agent routes via Hono.
 *
 * Read top-to-bottom — there are no other Sentry-related files in the
 * project. Every agent in `.flue/agents/` is a plain Flue handler;
 * none of them know that Sentry exists.
 *
 *
 * Isolate scoping (read this once, then forget about it)
 * ──────────────────────────────────────────────────────
 *
 * On the Node target the entire server runs in one V8 isolate, so
 * "global" subscribers are truly global.
 *
 * On the Cloudflare target each agent runs in its own Durable Object,
 * which is its own V8 isolate. This file (`app.ts`) is evaluated once
 * per isolate — the outer Worker once, plus each DO once. That means
 * `Sentry.init` and `observe(...)` run independently inside every DO.
 * Each isolate captures its own errors with its own Sentry client.
 * No cross-isolate plumbing is needed (and none is possible without
 * RPC). This is the right shape, not a workaround.
 *
 *
 * Environment variables
 * ─────────────────────
 *
 *   SENTRY_DSN              required to send anything. If unset, the SDK
 *                           is initialized in "disabled" mode and your app
 *                           runs unchanged.
 *   SENTRY_ENVIRONMENT      e.g. "production", "staging". Defaults to
 *                           NODE_ENV.
 *   SENTRY_RELEASE          e.g. a git SHA. Optional.
 *   SENTRY_AI_RECORD_INPUTS   set to "true" to capture prompt messages
 *                              as `gen_ai.input.messages` on chat spans.
 *   SENTRY_AI_RECORD_OUTPUTS  set to "true" to capture model responses
 *                              as `gen_ai.output.messages` on chat spans.
 */

import { flue, observe } from '@flue/runtime/app';
import type { FlueContext, FlueEvent, PromptUsage } from '@flue/runtime';
import * as Sentry from '@sentry/node';
import { Hono } from 'hono';

// ─── 1. Sentry init ─────────────────────────────────────────────────────────

Sentry.init({
	dsn: process.env.SENTRY_DSN,
	environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
	release: process.env.SENTRY_RELEASE,
	tracesSampleRate: 1.0,
	// Send gen_ai spans as standalone envelopes instead of bundling in
	// the transaction payload. Prevents large AI spans from being dropped.
	streamGenAiSpans: true,
	// Forward Sentry.logger calls to Sentry Logs.
	enableLogs: true,
	enabled: Boolean(process.env.SENTRY_DSN),
});

// ─── 2. The Flue → Sentry event bridge ──────────────────────────────────────

const recordInputs = process.env.SENTRY_AI_RECORD_INPUTS === 'true';
const recordOutputs = process.env.SENTRY_AI_RECORD_OUTPUTS === 'true';

// Per-run state: track the agent-level span so child spans (turns,
// tool calls) can nest under it. Keyed by runId. Cleaned up on run_end.
const activeAgentSpans = new Map<string, ReturnType<typeof Sentry.startInactiveSpan>>();

// Track per-run agent name and accumulated usage for the invoke_agent span.
const runAgentNames = new Map<string, string>();
const runUsage = new Map<string, { input: number; output: number; cacheRead: number; cacheWrite: number; total: number; model?: string }>();

observe((event, ctx) => {
	const tags = flueCorrelationTags(event, ctx);
	const runId = event.runId;

	// ─── Agent span: run_start → run_end ──────────────────────────────
	//
	// Maps the full agent run to a `gen_ai.invoke_agent` span, which
	// is the top-level container in Sentry's AI monitoring view.
	if (event.type === 'run_start' && runId) {
		runAgentNames.set(runId, event.agentName);
		runUsage.set(runId, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });

		// Link multi-turn sessions via conversation ID (ctx.id is the
		// agent instance id from the URL, stable across calls).
		Sentry.setConversationId(ctx.id);

		const attrs: Record<string, string> = {
			'gen_ai.operation.name': 'invoke_agent',
			'gen_ai.agent.name': event.agentName,
			'flue.run_id': runId,
			'flue.instance_id': event.instanceId,
		};
		if (recordInputs && event.payload != null) {
			attrs['gen_ai.input.messages'] = safeStringify(event.payload);
		}
		const span = Sentry.startInactiveSpan({
			op: 'gen_ai.invoke_agent',
			name: `invoke_agent ${event.agentName}`,
			attributes: attrs,
		});
		activeAgentSpans.set(runId, span);
		Sentry.logger.info('Agent run started', {
			'flue.run_id': runId,
			'flue.instance_id': event.instanceId,
			'flue.agent': event.agentName,
		});
		return;
	}

	if (event.type === 'run_end' && runId) {
		const span = activeAgentSpans.get(runId);
		const accumulated = runUsage.get(runId);
		if (span) {
			// Set aggregated usage on the agent span so it shows totals
			// in the AI monitoring view.
			if (accumulated) {
				span.setAttributes({
					'gen_ai.usage.input_tokens': accumulated.input,
					'gen_ai.usage.output_tokens': accumulated.output,
					'gen_ai.usage.total_tokens': accumulated.total,
				});
				if (accumulated.model) {
					span.setAttribute('gen_ai.request.model', accumulated.model);
				}
			}
			if (recordOutputs && event.result != null) {
				span.setAttribute('gen_ai.output.messages', safeStringify(event.result));
			}
			if (event.isError) {
				span.setStatus({ code: 2 });
			}
			span.end();
			activeAgentSpans.delete(runId);
		}
		runAgentNames.delete(runId);
		runUsage.delete(runId);
		Sentry.setConversationId(null);

		if (event.isError) {
			Sentry.withScope((scope) => {
				scope.setTags(tags);
				scope.setLevel('error');
				scope.setContext('flue.run', {
					durationMs: event.durationMs,
					agentName: tags['flue.agent'],
					instanceId: ctx.id,
				});
				Sentry.captureException(reconstructError(event.error));
			});
			Sentry.logger.error('Agent run failed', {
				'flue.run_id': runId,
				'durationMs': event.durationMs,
			});
		} else {
			Sentry.logger.info('Agent run completed', {
				'flue.run_id': runId,
				'durationMs': event.durationMs,
			});
		}
		return;
	}

	// ─── LLM turn → gen_ai.chat span ─────────────────────────────────
	//
	// Each `turn` event represents one completed LLM call. It carries
	// the model name, token usage, and duration. We use
	// `startInactiveSpan` + manual `end()` so the span's wall-clock
	// duration matches the actual LLM call time from `durationMs`.
	if (event.type === 'turn' && runId) {
		const agentSpan = activeAgentSpans.get(runId);
		const modelName = event.model ?? 'unknown';

		// Accumulate usage on the parent invoke_agent span.
		const accumulated = runUsage.get(runId);
		if (accumulated && event.usage) {
			accumulated.input += event.usage.input;
			accumulated.output += event.usage.output;
			accumulated.cacheRead += event.usage.cacheRead;
			accumulated.cacheWrite += event.usage.cacheWrite;
			accumulated.total += event.usage.totalTokens;
			accumulated.model ??= modelName;
		}

		const endTimeMs = event.timestamp ? new Date(event.timestamp).getTime() : Date.now();
		const startTimeMs = endTimeMs - event.durationMs;

		const span = Sentry.withActiveSpan(agentSpan ?? null, () => {
			return Sentry.startInactiveSpan({
				op: 'gen_ai.chat',
				name: `chat ${modelName}`,
				startTime: startTimeMs / 1000,
				attributes: {
					'gen_ai.operation.name': 'chat',
					'gen_ai.request.model': modelName,
					'gen_ai.response.model': modelName,
					...usageAttributes(event.usage),
				},
			});
		});
		if (event.isError) span.setStatus({ code: 2 });
		span.end(endTimeMs / 1000);

		if (event.usage) {
			Sentry.logger.debug('LLM turn completed', {
				'flue.run_id': runId,
				'flue.operation_id': event.operationId ?? '',
				'model': modelName,
				'input_tokens': event.usage.input,
				'output_tokens': event.usage.output,
				'durationMs': event.durationMs,
			});
		}
		return;
	}

	// ─── Tool call → gen_ai.execute_tool span ────────────────────────
	if (event.type === 'tool_call' && runId) {
		const agentSpan = activeAgentSpans.get(runId);

		const endTimeMs = event.timestamp ? new Date(event.timestamp).getTime() : Date.now();
		const startTimeMs = endTimeMs - event.durationMs;

		const span = Sentry.withActiveSpan(agentSpan ?? null, () => {
			return Sentry.startInactiveSpan({
				op: 'gen_ai.execute_tool',
				name: `execute_tool ${event.toolName}`,
				startTime: startTimeMs / 1000,
				attributes: {
					'gen_ai.operation.name': 'execute_tool',
					'gen_ai.tool.name': event.toolName,
				},
			});
		});
		if (event.isError) span.setStatus({ code: 2 });
		span.end(endTimeMs / 1000);
		return;
	}

	// ─── Structured logs → Sentry.logger ─────────────────────────────
	//
	// Every ctx.log.info/warn/error is forwarded to Sentry.logger so
	// they appear in the Sentry Logs view with flue correlation attrs.
	if (event.type === 'log') {
		const logAttrs: Record<string, string | number | boolean> = {};
		if (runId) logAttrs['flue.run_id'] = runId;
		if (event.operationId) logAttrs['flue.operation_id'] = event.operationId;
		const agentName = runId ? runAgentNames.get(runId) : undefined;
		if (agentName) logAttrs['flue.agent'] = agentName;

		if (event.level === 'info') {
			Sentry.logger.info(event.message, logAttrs);
		} else if (event.level === 'warn') {
			Sentry.logger.warn(event.message, logAttrs);
		} else if (event.level === 'error') {
			Sentry.logger.error(event.message, logAttrs);

			Sentry.withScope((scope) => {
				scope.setTags(tags);
				scope.setLevel('error');
				if (event.attributes) {
					scope.setContext('flue.log_attributes', event.attributes);
				}
				const errorAttr = event.attributes?.error;
				if (errorAttr) {
					Sentry.captureException(reconstructError(errorAttr));
				} else {
					Sentry.captureMessage(event.message, 'error');
				}
			});
		}
		return;
	}
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function flueCorrelationTags(
	event: FlueEvent,
	ctx: FlueContext,
): Record<string, string> {
	const tags: Record<string, string> = {
		'flue.instance_id': ctx.id,
	};
	if (event.runId) tags['flue.run_id'] = event.runId;
	if (event.harness) tags['flue.harness'] = event.harness;
	if (event.session) tags['flue.session'] = event.session;
	if (event.parentSession) tags['flue.parent_session'] = event.parentSession;
	if (event.operationId) tags['flue.operation_id'] = event.operationId;
	if (event.taskId) tags['flue.task_id'] = event.taskId;
	if (event.type === 'run_start') tags['flue.agent'] = event.agentName;
	return tags;
}

function usageAttributes(usage: PromptUsage | undefined): Record<string, number> {
	if (!usage) return {};
	return {
		'gen_ai.usage.input_tokens': usage.input,
		'gen_ai.usage.output_tokens': usage.output,
		'gen_ai.usage.input_tokens.cached': usage.cacheRead,
		'gen_ai.usage.input_tokens.cache_write': usage.cacheWrite,
		'gen_ai.usage.total_tokens': usage.totalTokens,
		'gen_ai.cost.input_tokens': usage.cost.input,
		'gen_ai.cost.output_tokens': usage.cost.output,
		'gen_ai.cost.total_tokens': usage.cost.total,
	};
}

function reconstructError(raw: unknown): Error {
	if (raw instanceof Error) return raw;
	if (raw && typeof raw === 'object') {
		const o = raw as { name?: unknown; message?: unknown; stack?: unknown };
		const message =
			typeof o.message === 'string' ? o.message : safeStringify(raw);
		const err = new Error(message);
		if (typeof o.name === 'string') err.name = o.name;
		if (typeof o.stack === 'string') err.stack = o.stack;
		return err;
	}
	return new Error(typeof raw === 'string' ? raw : safeStringify(raw));
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

// ─── 3. Mount the Flue agent route ──────────────────────────────────────────

const app = new Hono();
app.route('/', flue());

export default app;
