import { createAdaptorServer } from '@hono/node-server';
import { RuntimeUnavailableError, toHttpResponse } from '@flue/runtime/internal';

type NodeRuntimeStatus = 'loading' | 'ready' | 'draining' | 'failed' | 'closed';

export interface LoadedNodeApplication {
	fetch(request: Request, env?: unknown): Response | Promise<Response>;
	enterActivity(): { release(): void };
	pauseAdmissions(): void;
	waitForIdle(): Promise<void>;
	stop(timeoutMs?: number): Promise<void>;
	closeSync(): void;
}

export interface StableNodeListener {
	readonly port: number;
	readonly url: string;
	listen(): Promise<void>;
	install(application: LoadedNodeApplication): void;
	setUnavailable(status: Exclude<NodeRuntimeStatus, 'ready' | 'closed'>): void;
	stop(): Promise<void>;
	closeSync(): void;
}

/**
 * Permissive, credential-safe CORS for the local dev server only. Reflects the
 * request `Origin` (never `*`-with-credentials) so a separate-origin SPA — the
 * common dev setup — can call `flue dev` without extra configuration. Production
 * deployments are unaffected; CORS there is the application's responsibility.
 */
function corsPreflightResponse(request: Request, origin: string): Response {
	return new Response(null, {
		status: 204,
		headers: {
			'access-control-allow-origin': origin,
			'access-control-allow-credentials': 'true',
			'access-control-allow-methods': 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS',
			'access-control-allow-headers':
				request.headers.get('access-control-request-headers') ?? '*',
			'access-control-max-age': '86400',
			vary: 'Origin',
		},
	});
}

function withCorsHeaders(response: Response, origin: string): Response {
	response.headers.set('access-control-allow-origin', origin);
	response.headers.set('access-control-allow-credentials', 'true');
	// Durable-stream consumers (the SDK conversation/run observers) resume from
	// the `Stream-Next-Offset` response header and read `Stream-Up-To-Date`.
	// Cross-origin JS can only see response headers listed here, so without this
	// a separate-origin SPA can't advance its offset and re-applies the same
	// batch forever. Expose the stream coordination headers (and the admission
	// `Location`) to the browser.
	response.headers.set(
		'access-control-expose-headers',
		'Stream-Next-Offset, Stream-Up-To-Date, Location',
	);
	response.headers.append('vary', 'Origin');
	return response;
}

function isObservationRequest(request: Request): boolean {
	if (request.method !== 'GET' && request.method !== 'HEAD') return false;
	const pathname = new URL(request.url).pathname;
	return (
		/\/(?:healthz?|readyz?|livez?)$/.test(pathname) ||
		/\/(?:agents\/[^/]+\/[^/]+|runs\/[^/]+)$/.test(pathname)
	);
}

function retainLeaseForResponse(
	response: Response,
	lease: { release(): void },
): Response {
	if (!response.body) {
		lease.release();
		return response;
	}
	const reader = response.body.getReader();
	return new Response(
		new ReadableStream<Uint8Array>({
			async pull(controller) {
				try {
					const result = await reader.read();
					if (result.done) {
						lease.release();
						controller.close();
						return;
					}
					controller.enqueue(result.value);
				} catch (error) {
					lease.release();
					controller.error(error);
				}
			},
			async cancel(reason) {
				try {
					await reader.cancel(reason);
				} finally {
					lease.release();
				}
			},
		}),
		{
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		},
	);
}

export function createStableNodeListener(options: {
	port: number;
	hostname?: string;
	/** Dev-only: reflect the request Origin so a separate-origin SPA can connect. */
	cors?: boolean;
}): StableNodeListener {
	let status: NodeRuntimeStatus = 'loading';
	let application: LoadedNodeApplication | undefined;
	let server: ReturnType<typeof createAdaptorServer> | undefined;
	let listening: Promise<void> | undefined;
	let stopping: Promise<void> | undefined;

	async function handle(request: Request, env: unknown): Promise<Response> {
		if (status !== 'ready' || !application) {
			const state = status === 'closed' ? 'failed' : status;
			return toHttpResponse(
				new RuntimeUnavailableError({ state: state === 'ready' ? 'failed' : state }),
			);
		}
		if (isObservationRequest(request)) return application.fetch(request, env);
		const lease = application.enterActivity();
		try {
			const response = await application.fetch(request, env);
			return retainLeaseForResponse(response, lease);
		} catch (error) {
			lease.release();
			throw error;
		}
	}

	return {
		get port() {
			const address = server?.address();
			return address && typeof address === 'object' ? address.port : options.port;
		},
		get url() {
			const address = server?.address();
			const port = address && typeof address === 'object' ? address.port : options.port;
			return `http://${options.hostname ?? 'localhost'}:${port}`;
		},
		listen() {
			if (listening) return listening;
			listening = new Promise<void>((resolve, reject) => {
				let settled = false;
				const onError = (error: Error) => {
					if (settled) return;
					settled = true;
					reject(error);
				};
				server = createAdaptorServer({
					async fetch(request, env) {
						const corsOrigin = options.cors ? request.headers.get('origin') : null;
						if (corsOrigin && request.method === 'OPTIONS') {
							return corsPreflightResponse(request, corsOrigin);
						}
						const response = await handle(request, env);
						return corsOrigin ? withCorsHeaders(response, corsOrigin) : response;
					},
					serverOptions: { requestTimeout: 0 },
				});
				server.once('error', onError);
				const onListening = () => {
					if (settled) return;
					settled = true;
					server?.off('error', onError);
					resolve();
				};
				if (options.hostname) server.listen(options.port, options.hostname, onListening);
				else server.listen(options.port, onListening);
			});
			return listening;
		},
		install(next) {
			application = next;
			status = 'ready';
		},
		setUnavailable(nextStatus) {
			status = nextStatus;
			application = undefined;
		},
		stop() {
			if (stopping) return stopping;
			status = 'closed';
			stopping = new Promise<void>((resolve, reject) => {
				if (!server) {
					resolve();
					return;
				}
				server.close((error) => {
					if (error) reject(error);
					else resolve();
				});
				if ('closeAllConnections' in server) server.closeAllConnections();
			});
			return stopping;
		},
		closeSync() {
			status = 'closed';
			if (server && 'closeAllConnections' in server) server.closeAllConnections();
			server?.close();
		},
	};
}
