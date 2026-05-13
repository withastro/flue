/**
 * `RunRegistry` client for the Cloudflare target.
 *
 * Each method fetches the singleton `FlueRegistry` DO via the
 * `FLUE_REGISTRY` binding the build plugin injects into the user's
 * wrangler.jsonc. The DO's wire shape is documented in `./registry-do.ts`.
 *
 * Construction is per-request (the binding is only available inside a
 * request scope), mirroring `createRunStoreForRequest(doInstance)` in the
 * generated CF entry. The returned object is a thin transport wrapper —
 * the actual SQL lives in the DO.
 */
import type {
	InstancePointer,
	ListInstancesOpts,
	ListInstancesResponse,
	ListRunsOpts,
	ListRunsResponse,
	RecordRunEndInput,
	RecordRunStartInput,
	RunPointer,
	RunRegistry,
} from '../runtime/run-registry.ts';

/**
 * Subset of `DurableObjectNamespace` the client uses. Loose-typed for
 * the same reason `SqlStorage` is in `./registry-do.ts`: the file
 * compiles even when the full workerd typings aren't perfectly aligned
 * with the host project's `@cloudflare/workers-types` version.
 */
interface FlueRegistryNamespace {
	idFromName(name: string): { toString(): string } & object;
	get(id: { toString(): string } & object): { fetch(input: Request | string): Promise<Response> };
}

/**
 * Construct a registry client bound to the given DO namespace. The
 * namespace is what the CF entry pulls from `env.FLUE_REGISTRY`; if the
 * binding is missing (an older deployment that hasn't yet picked up the
 * build's new wrangler entry, or a sufficiently broken local config),
 * the client returns a "no-op + structured failure" surface so the run
 * lifecycle doesn't crash mid-request — the `safeRegistry` helper on
 * the call site logs the failure and the run completes.
 */
export function createCloudflareRunRegistry(
	namespace: FlueRegistryNamespace | undefined,
): RunRegistry {
	if (!namespace) {
		return missingBindingRegistry();
	}
	return new CloudflareRunRegistry(namespace);
}

const FLUE_REGISTRY_INSTANCE_NAME = 'default';
// Synthetic base for the DO-internal URL. workerd ignores host/port on
// DO `fetch()` calls — only path + query + headers matter — but a
// fully-qualified URL is required by the WHATWG `URL` constructor.
const SYNTHETIC_BASE = 'https://flue-registry.local';

class CloudflareRunRegistry implements RunRegistry {
	constructor(private namespace: FlueRegistryNamespace) {}

	async recordRunStart(input: RecordRunStartInput): Promise<void> {
		const { runId, ...body } = input;
		await this.callExpectingNoContent(
			`/pointers/${encodeURIComponent(runId)}/start`,
			'POST',
			body,
		);
	}

	async recordRunEnd(input: RecordRunEndInput): Promise<void> {
		const { runId, ...body } = input;
		await this.callExpectingNoContent(
			`/pointers/${encodeURIComponent(runId)}/end`,
			'POST',
			body,
		);
	}

	async lookupRun(runId: string): Promise<RunPointer | null> {
		const stub = this.stub();
		const url = `${SYNTHETIC_BASE}/pointers/${encodeURIComponent(runId)}`;
		const response = await stub.fetch(new Request(url, { method: 'GET' }));
		if (response.status === 404) return null;
		if (!response.ok) {
			throw new Error(
				`[flue] FlueRegistry lookupRun(${runId}) failed: ${response.status} ${await response.text()}`,
			);
		}
		return (await response.json()) as RunPointer;
	}

	async listRuns(opts: ListRunsOpts = {}): Promise<ListRunsResponse> {
		const params = new URLSearchParams();
		if (opts.status) params.set('status', opts.status);
		if (opts.agentName) params.set('agent', opts.agentName);
		if (opts.instanceId) params.set('instance', opts.instanceId);
		if (opts.limit !== undefined) params.set('limit', String(opts.limit));
		if (opts.cursor) params.set('cursor', opts.cursor);
		const qs = params.toString();
		const url = `${SYNTHETIC_BASE}/pointers${qs ? `?${qs}` : ''}`;
		const response = await this.stub().fetch(new Request(url, { method: 'GET' }));
		if (!response.ok) {
			throw new Error(
				`[flue] FlueRegistry listRuns failed: ${response.status} ${await response.text()}`,
			);
		}
		return (await response.json()) as ListRunsResponse;
	}

	async listInstances(opts: ListInstancesOpts = {}): Promise<ListInstancesResponse> {
		const params = new URLSearchParams();
		if (opts.agentName) params.set('agent', opts.agentName);
		if (opts.limit !== undefined) params.set('limit', String(opts.limit));
		if (opts.cursor) params.set('cursor', opts.cursor);
		const qs = params.toString();
		const url = `${SYNTHETIC_BASE}/instances${qs ? `?${qs}` : ''}`;
		const response = await this.stub().fetch(new Request(url, { method: 'GET' }));
		if (!response.ok) {
			throw new Error(
				`[flue] FlueRegistry listInstances failed: ${response.status} ${await response.text()}`,
			);
		}
		return (await response.json()) as ListInstancesResponse;
	}

	private stub() {
		return this.namespace.get(this.namespace.idFromName(FLUE_REGISTRY_INSTANCE_NAME));
	}

	private async callExpectingNoContent(
		path: string,
		method: 'POST' | 'GET',
		body: unknown,
	): Promise<void> {
		const stub = this.stub();
		const url = `${SYNTHETIC_BASE}${path}`;
		const response = await stub.fetch(
			new Request(url, {
				method,
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body),
			}),
		);
		if (!response.ok) {
			throw new Error(
				`[flue] FlueRegistry ${method} ${path} failed: ${response.status} ${await response.text()}`,
			);
		}
	}
}

/**
 * Fallback registry returned when `env.FLUE_REGISTRY` is absent — most
 * likely a deployment whose `dist/wrangler.jsonc` predates this Flue
 * version's build. Writes are dropped silently (via `safeRegistry` at
 * the call site); reads throw a clear error so the bare-`/runs/:runId`
 * handler can surface a structured 5xx rather than a stub crash.
 */
function missingBindingRegistry(): RunRegistry {
	const missingError = () =>
		new Error(
			'[flue] env.FLUE_REGISTRY binding is missing. ' +
				'Re-run `flue build` to regenerate `dist/wrangler.jsonc` with the registry binding.',
		);
	return {
		async recordRunStart(): Promise<void> {
			throw missingError();
		},
		async recordRunEnd(): Promise<void> {
			throw missingError();
		},
		async lookupRun(): Promise<RunPointer | null> {
			throw missingError();
		},
		async listRuns(): Promise<ListRunsResponse> {
			throw missingError();
		},
		async listInstances(): Promise<ListInstancesResponse> {
			throw missingError();
		},
	};
}

// Re-export pointer types so consumers of the CF subpath don't have to
// reach into `../runtime/run-registry.ts`.
export type {
	InstancePointer,
	ListInstancesOpts,
	ListInstancesResponse,
	ListRunsOpts,
	ListRunsResponse,
	RecordRunEndInput,
	RecordRunStartInput,
	RunPointer,
	RunRegistry,
};
