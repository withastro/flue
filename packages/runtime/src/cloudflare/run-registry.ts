/** `RunRegistry` client for workflow runs on the Cloudflare target. */
import type {
	ListRunsOpts,
	ListRunsResponse,
	RecordRunEndInput,
	RecordRunStartInput,
	RunPointer,
	RunRegistry,
} from '../runtime/run-registry.ts';

interface FlueRegistryNamespace {
	idFromName(name: string): { toString(): string } & object;
	get(id: { toString(): string } & object): { fetch(input: Request | string): Promise<Response> };
}

export function createCloudflareRunRegistry(
	namespace: FlueRegistryNamespace | undefined,
): RunRegistry | undefined {
	if (!namespace) return undefined;
	return new CloudflareRunRegistry(namespace);
}

const FLUE_REGISTRY_INSTANCE_NAME = 'default';
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
		const response = await this.stub().fetch(new Request(`${SYNTHETIC_BASE}/pointers/${encodeURIComponent(runId)}`, { method: 'GET' }));
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
		if (opts.workflowName) params.set('workflow', opts.workflowName);
		if (opts.limit !== undefined) params.set('limit', String(opts.limit));
		if (opts.cursor) params.set('cursor', opts.cursor);
		const qs = params.toString();
		const response = await this.stub().fetch(new Request(`${SYNTHETIC_BASE}/pointers${qs ? `?${qs}` : ''}`, { method: 'GET' }));
		if (!response.ok) {
			throw new Error(
				`[flue] FlueRegistry listRuns failed: ${response.status} ${await response.text()}`,
			);
		}
		return (await response.json()) as ListRunsResponse;
	}

	private stub() {
		return this.namespace.get(this.namespace.idFromName(FLUE_REGISTRY_INSTANCE_NAME));
	}

	private async callExpectingNoContent(
		path: string,
		method: 'POST' | 'GET',
		body: unknown,
	): Promise<void> {
		const response = await this.stub().fetch(
			new Request(`${SYNTHETIC_BASE}${path}`, {
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
