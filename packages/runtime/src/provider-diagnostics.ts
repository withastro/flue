/**
 * The structured channel from a provider boundary to turn observations.
 *
 * ──── Why this file exists ────────────────────────────────────────────────
 *
 * Providers normalize what they receive: a raw SSE `finish_reason` becomes a
 * pi-ai `stopReason`, response headers are read and dropped, provider bodies
 * are flattened into `errorMessage` prose. Every time telemetry later needed
 * one of those pre-normalization values, an ad-hoc channel appeared —
 * message-string markers for error classification, regexes over prose. This
 * module is the one sanctioned alternative for the response path:
 *
 *   At a normalization boundary, don't discard the pre-normalization value —
 *   attach it here, and project it to observations through an explicit
 *   allowlist.
 *
 * The transport is pi-ai's own extension point: `AssistantMessage.diagnostics`
 * travels on the message itself, so it survives message copying and needs no
 * side channel. The session projects ONLY the fields named in
 * {@link ProviderResponseDiagnostics} onto the `turn` observation — never
 * arbitrary headers or payloads, which may carry credentials.
 *
 * Everything here is telemetry. None of it participates in replay, execution
 * identity, or the normalized `stopReason`/`finishReason` contract.
 *
 * (The throw path — a request that dies before producing a message — cannot
 * use this channel and still relies on message markers such as
 * `RETRYABLE_INTERRUPTION_MARKER` until pi-ai grows structured error fields.)
 */

import type { AssistantMessage, AssistantMessageDiagnostic } from '@earendil-works/pi-ai';

/** Diagnostic `type` under which providers attach response metadata. */
export const PROVIDER_RESPONSE_DIAGNOSTIC = 'flue:provider_response';

/**
 * Allowlisted provider-response metadata projected onto `turn` observations.
 * Add fields here (and in `ModelResponse`) rather than inventing a new
 * channel; anything else stashed in the diagnostic's `details` is ignored by
 * the projection.
 */
export type ProviderResponseDiagnostics = {
	/**
	 * The provider's exact finish value before normalization (e.g. Workers AI
	 * `tool_calls` behind the normalized `toolUse`). Lets an observer tell a
	 * provider that said "stop" apart from one whose structured output was
	 * lost after a "tool_calls" finish.
	 */
	providerFinishReason?: string;
	/**
	 * Response-level gateway log correlation (Cloudflare `cf-aig-log-id`).
	 * Read from this response's own headers, so concurrent requests on a
	 * shared binding can never cross-attribute it — unlike
	 * `env.AI.aiGatewayLogId`, which reflects the binding's most recent
	 * request.
	 */
	gatewayLogId?: string;
};

/**
 * Attach (or update) the message's provider-response diagnostic. Values merge
 * over an existing entry so a provider can record fields as they arrive —
 * the gateway header when the response lands, the finish reason when the
 * stream delivers it — and the entry survives onto error-path messages too.
 */
export function attachProviderResponseDiagnostics(
	message: AssistantMessage,
	details: ProviderResponseDiagnostics,
): void {
	message.diagnostics ??= [];
	const diagnostics = message.diagnostics;
	const existing = diagnostics.find(
		(diagnostic) => diagnostic.type === PROVIDER_RESPONSE_DIAGNOSTIC,
	);
	if (existing) {
		existing.details = { ...existing.details, ...pickAllowlisted(details) };
		return;
	}
	diagnostics.push({
		type: PROVIDER_RESPONSE_DIAGNOSTIC,
		timestamp: Date.now(),
		details: pickAllowlisted(details),
	} satisfies AssistantMessageDiagnostic);
}

/**
 * Read the allowlisted provider-response metadata off a message. Unknown
 * fields in the diagnostic's `details` are deliberately not returned.
 */
export function readProviderResponseDiagnostics(
	message: AssistantMessage,
): ProviderResponseDiagnostics | undefined {
	const details = message.diagnostics?.findLast(
		(diagnostic) => diagnostic.type === PROVIDER_RESPONSE_DIAGNOSTIC,
	)?.details;
	if (!details) return undefined;
	const picked = pickAllowlisted(details as ProviderResponseDiagnostics);
	return Object.keys(picked).length > 0 ? picked : undefined;
}

function pickAllowlisted(details: ProviderResponseDiagnostics): ProviderResponseDiagnostics {
	return {
		...(typeof details.providerFinishReason === 'string' && details.providerFinishReason.length > 0
			? { providerFinishReason: details.providerFinishReason }
			: {}),
		...(typeof details.gatewayLogId === 'string' && details.gatewayLogId.length > 0
			? { gatewayLogId: details.gatewayLogId }
			: {}),
	};
}
