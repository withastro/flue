/**
 * Request preparation for the Anthropic binding client — the stand-in for the
 * Anthropic SDK client that pi-ai's `anthropic-messages` protocol drives.
 *
 * The stable `messages` namespace forwards params and headers verbatim. The
 * `beta` namespace mirrors the SDK's beta client: `params.betas` is not a body
 * field (Anthropic rejects it: "betas: Extra inputs are not permitted"); it is
 * removed from the body and, whenever non-null, serialized with
 * `String(betas)` into an `anthropic-beta` request header that replaces any
 * configured one — including an explicit empty value for `betas: []`.
 */
export function prepareAnthropicBindingRequest(
	namespace: 'messages' | 'beta',
	params: Record<string, unknown>,
	headers: Record<string, string>,
): { body: Record<string, unknown>; extraHeaders: Record<string, string> } {
	if (namespace === 'messages') return { body: params, extraHeaders: { ...headers } };

	const { betas, ...body } = params;
	const extraHeaders = { ...headers };
	if (betas !== undefined && betas !== null) {
		// pi derives `betas` from any configured `anthropic-beta` header, so the
		// per-request value wins (the SDK's precedence), in whatever casing.
		for (const name of Object.keys(extraHeaders)) {
			if (name.toLowerCase() === 'anthropic-beta') delete extraHeaders[name];
		}
		extraHeaders['anthropic-beta'] = String(betas);
	}
	return { body, extraHeaders };
}
