/**
 * Internal runtime helpers consumed by the generated server entry point.
 *
 * This subpath is NOT part of the public API. It exists solely so the build
 * plugins (Node, Cloudflare) can emit stable bare-specifier imports that
 * resolve through normal package-exports resolution at both build time and
 * runtime, for both workspace-linked and published-npm installs.
 *
 * User agent code should never import from here.
 */
import { getModel } from '@mariozechner/pi-ai';

export { createFlueContext } from './client.ts';
export type { FlueContextConfig, FlueContextInternal } from './client.ts';
export { InMemorySessionStore } from './session.ts';
export { bashFactoryToSessionEnv } from './sandbox.ts';

export interface FlueHttpErrorBody {
	error: {
		type: string;
		message: string;
		details?: Record<string, unknown>;
	};
}

export interface FlueHttpError {
	status: number;
	body: FlueHttpErrorBody;
	headers?: Record<string, string>;
}

export type JsonRequestPayloadResult =
	| { ok: true; payload: unknown }
	| { ok: false; error: FlueHttpError };

export function flueHttpError(
	status: number,
	type: string,
	message: string,
	details?: Record<string, unknown>,
	headers?: Record<string, string>,
): FlueHttpError {
	return {
		status,
		body: {
			error: {
				type,
				message,
				...(details ? { details } : {}),
			},
		},
		...(headers ? { headers } : {}),
	};
}

export function methodNotAllowedError(allowed: string | string[] = 'POST'): FlueHttpError {
	const allow = Array.isArray(allowed) ? allowed.join(', ') : allowed;
	return flueHttpError(
		405,
		'method_not_allowed',
		`Method not allowed. Use ${allow}.`,
		{ allowed: Array.isArray(allowed) ? allowed : [allowed] },
		{ Allow: allow },
	);
}

export async function readJsonRequestPayload(request: Request): Promise<JsonRequestPayloadResult> {
	let body: string;
	try {
		body = await request.text();
	} catch (err) {
		return {
			ok: false,
			error: flueHttpError(400, 'invalid_body', 'Failed to read request body.', {
				cause: getErrorMessage(err),
			}),
		};
	}

	if (body.trim().length === 0) {
		return {
			ok: false,
			error: flueHttpError(
				400,
				'missing_body',
				'Request body is required. Send a JSON payload such as {}.',
			),
		};
	}

	const contentType = request.headers.get('content-type');
	if (!isJsonContentType(contentType)) {
		return {
			ok: false,
			error: flueHttpError(
				415,
				'unsupported_media_type',
				'Request Content-Type must be application/json.',
				{ received: contentType ?? null },
			),
		};
	}

	try {
		return { ok: true, payload: JSON.parse(body) };
	} catch (err) {
		return {
			ok: false,
			error: flueHttpError(400, 'invalid_json', 'Request body must be valid JSON.', {
				cause: getErrorMessage(err),
			}),
		};
	}
}

function isJsonContentType(contentType: string | null): boolean {
	if (!contentType) return false;
	const mediaType = contentType.split(';', 1)[0]?.trim().toLowerCase();
	return mediaType === 'application/json' || Boolean(mediaType?.endsWith('+json'));
}

function getErrorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Resolve a `provider/model-id` string into a pi-ai `Model` object.
 * Lives here (rather than in the generated entry point) so that user
 * projects don't have to declare `@mariozechner/pi-ai` as a direct
 * dependency — wrangler's bundler resolves bare specifiers from the entry
 * file's location, which on pnpm-isolated installs doesn't see Flue's
 * transitive deps. Centralizing the resolver here keeps `_entry.ts`
 * dependency-free apart from `@flue/sdk/*`.
 */
export function resolveModel(modelString: string): ReturnType<typeof getModel> {
	const slash = modelString.indexOf('/');
	if (slash === -1) {
		throw new Error(
			`[flue] Invalid model "${modelString}". ` +
				`Use the "provider/model-id" format (e.g. "anthropic/claude-haiku-4-5").`,
		);
	}
	const provider = modelString.slice(0, slash);
	const modelId = modelString.slice(slash + 1);
	// pi-ai's `getModel` is overloaded with literal-typed providers. We accept
	// arbitrary user input here, so cast to `any` — pi-ai itself returns null
	// for unknown providers, which we re-throw with a friendlier message below.
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const resolved = getModel(provider as any, modelId);
	if (!resolved) {
		throw new Error(
			`[flue] Unknown model "${modelString}". ` +
				`Provider "${provider}" / model id "${modelId}" ` +
				`is not registered with @mariozechner/pi-ai.`,
		);
	}
	return resolved;
}
