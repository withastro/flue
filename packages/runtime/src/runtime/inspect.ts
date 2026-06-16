/**
 * Server-side deployment-inspection primitives.
 *
 * These free functions read the ambient generated runtime (the same pattern
 * as `dispatch()`) and are the building blocks for application-owned
 * inspection endpoints: mount your own route, apply your own authorization,
 * and serve whatever shape your operators need. Flue does not ship an
 * inspection HTTP surface of its own.
 */
import { RunStoreUnavailableError } from '../errors.ts';
import {
	type AgentManifestEntry,
	type FlueRuntime,
	getFlueRuntime,
	type RunListing,
} from './flue-app.ts';
import type { ListRunsOpts, ListRunsResponse, RunRecord } from './run-store.ts';

/**
 * Lists workflow-run summaries (`RunPointer`s) newest-first, filtered by
 * `status`/`workflowName` and paginated via the opaque `cursor` returned in
 * {@link ListRunsResponse.nextCursor}.
 */
export async function listRuns(options?: ListRunsOpts): Promise<ListRunsResponse> {
	const rt = requireInspectRuntime('listRuns');
	return requireRunListing(rt).listRuns(options);
}

/**
 * Retrieves one workflow-run record, or `null` when no run with this id is
 * recorded.
 */
export async function getRun(runId: string): Promise<RunRecord | null> {
	const rt = requireInspectRuntime('getRun');

	if (rt.target === 'node') {
		if (!rt.runStore) throw new RunStoreUnavailableError();
		return rt.runStore.getRun(runId);
	}

	// Cloudflare: full records live in the owning per-workflow Durable
	// Object; resolve the pointer from the index DO, then read the record
	// through the DO's `?meta` view.
	const pointer = await requireRunListing(rt).lookupRun(runId);
	if (!pointer) return null;
	if (!rt.routeRunRequest) throw new RunStoreUnavailableError();
	const response = await rt.routeRunRequest(
		new Request(`https://flue.invalid/runs/${encodeURIComponent(runId)}?meta`),
		undefined,
		{ workflowName: pointer.workflowName, runId },
	);
	if (!response || response.status === 404) return null;
	if (!response.ok) {
		throw new Error(`[flue] getRun("${runId}") failed with status ${response.status}.`);
	}
	return (await response.json()) as RunRecord;
}

/** Lists the agents built into this deployment. */
export async function listAgents(): Promise<AgentManifestEntry[]> {
	const rt = requireInspectRuntime('listAgents');
	return (rt.manifest?.agents ?? []).map((agent) => ({
		...agent,
		transports: { ...agent.transports },
	}));
}

function requireInspectRuntime(label: string): FlueRuntime {
	const rt = getFlueRuntime();
	if (!rt) {
		throw new Error(
			`[flue] ${label}() called before runtime was configured. ` +
				'This usually means it was used outside a Flue-built server entry.',
		);
	}
	return rt;
}

function requireRunListing(rt: FlueRuntime): RunListing {
	if (rt.target === 'cloudflare') {
		const index = rt.createRunIndexForRequest?.(undefined);
		if (!index) throw new RunStoreUnavailableError();
		return index;
	}
	if (!rt.runStore) throw new RunStoreUnavailableError();
	return rt.runStore;
}
