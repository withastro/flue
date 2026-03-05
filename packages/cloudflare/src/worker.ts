import { getSandbox } from '@cloudflare/sandbox';
import { evaluatePolicy, type ProxyPolicy } from '@flue/client/proxies';
import { Hono } from 'hono';
import { createFlueEventTransform } from './events.ts';
import type { KV } from './types.ts';

export interface FlueWorkerOptions {
	/** Name of the Sandbox binding in env (default: 'Sandbox'). */
	sandboxBinding?: string;
	/** Name of the KV binding used for gateway proxy config storage (default: 'GATEWAY_KV'). */
	gatewayKVBinding?: string;
	/** Name of the env var/secret holding the gateway HMAC secret (default: 'GATEWAY_SECRET'). */
	gatewaySecretBinding?: string;
}

/**
 * Serialized proxy config stored in KV. Contains only JSON-safe fields —
 * no functions (transform, body validators, denyResponse).
 */
export interface SerializedProxyConfig {
	name: string;
	target: string;
	headers: Record<string, string>;
	policy: SerializedPolicy | null;
	/** Whether to strip the /api/v3 prefix (gh CLI enterprise mode). */
	stripApiV3Prefix?: boolean;
}

/**
 * Serialized policy — same as ProxyPolicy but without function fields
 * (body validators on rules are stripped).
 */
interface SerializedPolicy {
	base: string;
	allow?: SerializedPolicyRule[];
	deny?: SerializedPolicyRule[];
}

interface SerializedPolicyRule {
	method: string | string[];
	path: string;
	limit?: number;
	// body validators are not serializable — omitted on CF v1
}

/**
 * Cloudflare Worker with built-in Flue infrastructure routes.
 *
 * Extends Hono — add your own routes on top of the built-in ones:
 *
 * - `GET  /health`               — `{ ok: true }`
 * - `POST /kill/:sessionId`      — Destroy a sandbox instance
 * - `ALL  /opencode/:sessionId/*` — Proxy to OpenCode server inside a container
 * - `ALL  /proxy/:sessionId/:proxyName/*` — Credential-injecting reverse proxy
 * - `ALL  /api/v3/*`             — gh CLI enterprise mode proxy
 * - `ALL  /api/graphql`          — gh CLI GraphQL proxy
 */
// biome-ignore lint/suspicious/noExplicitAny: env bindings are inherently dynamic
export class FlueWorker<E extends Record<string, any>> extends Hono<{ Bindings: E }> {
	constructor(options?: FlueWorkerOptions) {
		super();
		const bindingName = options?.sandboxBinding ?? 'Sandbox';
		const kvBindingName = options?.gatewayKVBinding ?? 'GATEWAY_KV';
		const secretBindingName = options?.gatewaySecretBinding ?? 'GATEWAY_SECRET';

		this.get('/health', (c) => c.json({ ok: true }));

		this.post('/kill/:sessionId', async (c) => {
			const sessionId = c.req.param('sessionId');
			try {
				const sandbox = getSandbox(c.env[bindingName], sessionId);
				await sandbox.destroy();
				return c.json({ ok: true, destroyed: sessionId });
			} catch (e) {
				return c.json({ error: String(e) }, 500);
			}
		});

		// Proxy to OpenCode server running inside the container on port 48765.
		// Usage: opencode attach https://<worker>/opencode/<sandboxSessionId>
		// Matches both /opencode/<sessionId> and /opencode/<sessionId>/sub/path
		this.all('/opencode/*', async (c) => {
			const url = new URL(c.req.url);
			const rest = url.pathname.slice('/opencode/'.length);
			const slashIdx = rest.indexOf('/');
			const sessionId = slashIdx === -1 ? rest : rest.slice(0, slashIdx);
			const forwardPath = slashIdx === -1 ? '/' : rest.slice(slashIdx);
			if (!sessionId) return c.json({ error: 'missing sandbox session id' }, 400);
			try {
				const sandbox = getSandbox(c.env[bindingName], sessionId);
				const target = new URL(forwardPath + url.search, 'http://container');
				const proxyReq = new Request(target.toString(), c.req.raw);
				return await sandbox.containerFetch(proxyReq, 48765);
			} catch (e) {
				return c.json({ error: String(e) }, 502);
			}
		});

		// Stream structured log events from the OpenCode server.
		// Connects to the container's SSE event stream and transforms raw
		// OpenCode events into a stable Flue event format.
		// Usage: curl -N https://<worker>/logs/<sandboxSessionId>
		this.get('/logs/:sessionId', async (c) => {
			const sessionId = c.req.param('sessionId');
			try {
				const sandbox = getSandbox(c.env[bindingName], sessionId);
				const target = new URL('/event', 'http://container');
				const response = await sandbox.containerFetch(new Request(target.toString()), 48765);
				if (!response.body) {
					return c.json({ error: 'no event stream available' }, 502);
				}
				const transformed = response.body.pipeThrough(createFlueEventTransform());
				return new Response(transformed, {
					headers: {
						'Content-Type': 'text/event-stream',
						'Cache-Control': 'no-cache',
						Connection: 'keep-alive',
					},
				});
			} catch (e) {
				return c.json({ error: String(e) }, 502);
			}
		});

		// -- Credential-injecting proxy routes --------------------------------

		// Generic proxy: /proxy/<sessionId>/<proxyName>/<rest>
		this.all('/proxy/:sessionId/:proxyName/*', async (c) => {
			const sessionId = c.req.param('sessionId');
			const proxyName = c.req.param('proxyName');
			const kv = c.env[kvBindingName] as KV | undefined;
			const secret = c.env[secretBindingName] as string | undefined;
			if (!kv || !secret) {
				return c.json({ error: 'proxy not configured' }, 500);
			}

			const token = extractBearerToken(c.req.header('Authorization')) ?? c.req.header('x-api-key') ?? null;
			if (!token || !(await validateProxyToken(secret, sessionId, token))) {
				return c.json({ error: 'invalid proxy token' }, 401);
			}

			const config = await kv.get<SerializedProxyConfig>(`proxy:${sessionId}:${proxyName}`, 'json');
			if (!config) {
				return c.json({ error: 'unknown proxy' }, 404);
			}

			const url = new URL(c.req.url);
			const prefix = `/proxy/${sessionId}/${proxyName}`;
			const forwardPath = url.pathname.slice(prefix.length) || '/';

			return handleProxyRequest(c.req, config, forwardPath, url.search);
		});

		// gh CLI enterprise mode: sends REST requests to /api/v3/<path>
		this.all('/api/v3/*', async (c) => {
			const kv = c.env[kvBindingName] as KV | undefined;
			const secret = c.env[secretBindingName] as string | undefined;
			if (!kv || !secret) {
				return c.json({ error: 'proxy not configured' }, 500);
			}

			const parsed = extractCompoundToken(c.req.header('Authorization'));
			if (!parsed) return c.json({ error: 'invalid auth' }, 401);

			const { sessionId, proxyToken } = parsed;
			if (!(await validateProxyToken(secret, sessionId, proxyToken))) {
				return c.json({ error: 'invalid proxy token' }, 401);
			}

			const config = await kv.get<SerializedProxyConfig>(`proxy:${sessionId}:github-api`, 'json');
			if (!config) {
				return c.json({ error: 'unknown proxy' }, 404);
			}

			const url = new URL(c.req.url);
			// Strip the /api/v3 prefix that gh CLI prepends for enterprise hosts
			const forwardPath = url.pathname.slice('/api/v3'.length) || '/';

			return handleProxyRequest(c.req, config, forwardPath, url.search);
		});

		// gh CLI enterprise mode: sends GraphQL requests to /api/graphql
		this.all('/api/graphql', async (c) => {
			const kv = c.env[kvBindingName] as KV | undefined;
			const secret = c.env[secretBindingName] as string | undefined;
			if (!kv || !secret) {
				return c.json({ error: 'proxy not configured' }, 500);
			}

			const parsed = extractCompoundToken(c.req.header('Authorization'));
			if (!parsed) return c.json({ error: 'invalid auth' }, 401);

			const { sessionId, proxyToken } = parsed;
			if (!(await validateProxyToken(secret, sessionId, proxyToken))) {
				return c.json({ error: 'invalid proxy token' }, 401);
			}

			const config = await kv.get<SerializedProxyConfig>(`proxy:${sessionId}:github-api`, 'json');
			if (!config) {
				return c.json({ error: 'unknown proxy' }, 404);
			}

			// gh CLI sends GraphQL to /api/graphql, forward to /graphql on api.github.com
			return handleProxyRequest(c.req, config, '/graphql', '');
		});
	}
}

// -- Proxy helpers -----------------------------------------------------------

/**
 * Handle a proxied request: evaluate policy, inject headers, forward to target.
 */
async function handleProxyRequest(
	req: { raw: Request; method: string; header: (name: string) => string | undefined },
	config: SerializedProxyConfig,
	forwardPath: string,
	search: string,
): Promise<Response> {
	// Read body for policy evaluation
	const bodyBuffer = await req.raw.arrayBuffer();
	const contentType = req.header('content-type') ?? '';
	let parsedBody: unknown = null;
	if (contentType.includes('json') && bodyBuffer.byteLength > 0) {
		try {
			parsedBody = JSON.parse(new TextDecoder().decode(bodyBuffer));
		} catch {
			// not valid JSON, leave as null
		}
	}

	// Evaluate policy (without body validators or rate limits on CF v1)
	const policy = config.policy as ProxyPolicy | null;
	const { allowed, reason } = evaluatePolicy(req.method, forwardPath, parsedBody, policy);

	if (!allowed) {
		console.log(`[proxy:${config.name}] DENIED: ${req.method} ${forwardPath} — ${reason}`);
		return new Response(
			JSON.stringify({ error: 'proxy_policy_denied', message: `Blocked: ${reason}` }),
			{ status: 403, headers: { 'Content-Type': 'application/json' } },
		);
	}

	// Build forwarded headers
	const headers: Record<string, string> = {};
	for (const [key, value] of req.raw.headers.entries()) {
		if (key === 'host' || key === 'connection') continue;
		headers[key] = value;
	}

	// Apply credential headers from config (overwrites matching keys)
	for (const [key, value] of Object.entries(config.headers)) {
		headers[key.toLowerCase()] = value;
	}

	// Forward to upstream
	const targetUrl = new URL(forwardPath + search, config.target);
	const proxyResponse = await fetch(targetUrl.toString(), {
		method: req.method,
		headers,
		body: bodyBuffer.byteLength > 0 ? bodyBuffer : undefined,
	});

	return new Response(proxyResponse.body, {
		status: proxyResponse.status,
		headers: proxyResponse.headers,
	});
}

/**
 * Extract a Bearer token from an Authorization header.
 * Handles both "Bearer <token>" and "token <token>" formats.
 */
function extractBearerToken(header: string | undefined): string | null {
	if (!header) return null;
	if (header.startsWith('Bearer ')) return header.slice(7);
	if (header.startsWith('token ')) return header.slice(6);
	return null;
}

/**
 * Extract session ID and proxy token from a compound token.
 * gh CLI sends: Authorization: token <sessionId>:<proxyToken>
 */
function extractCompoundToken(
	header: string | undefined,
): { sessionId: string; proxyToken: string } | null {
	const raw = extractBearerToken(header);
	if (!raw || !raw.includes(':')) return null;
	const colonIdx = raw.indexOf(':');
	return {
		sessionId: raw.slice(0, colonIdx),
		proxyToken: raw.slice(colonIdx + 1),
	};
}

// -- Proxy token auth --------------------------------------------------------

export async function generateProxyToken(secret: string, sessionId: string): Promise<string> {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(sessionId));
	return Array.from(new Uint8Array(signature))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

async function validateProxyToken(
	secret: string,
	sessionId: string,
	token: string,
): Promise<boolean> {
	const expected = await generateProxyToken(secret, sessionId);
	if (expected.length !== token.length) return false;
	// Constant-time comparison
	let result = 0;
	for (let i = 0; i < expected.length; i++) {
		result |= expected.charCodeAt(i) ^ token.charCodeAt(i);
	}
	return result === 0;
}
