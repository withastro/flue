/** Run-history HTTP endpoints shared by the Node and Cloudflare targets. */

import { InvalidRequestError, RunNotFoundError, RunStoreUnavailableError } from '../errors.ts';
import type { RunOwner } from './run-registry.ts';
import type { RunRecord, RunStore } from './run-store.ts';

export interface HandleRunRouteOptions {
	request: Request;
	runStore?: RunStore;
	owner: RunOwner;
	runId?: string;
	action: 'get';
}

export async function handleRunRouteRequest(opts: HandleRunRouteOptions): Promise<Response> {
	const store = opts.runStore;
	if (!store) throw new RunStoreUnavailableError();
	return getRun(store, requireRunId(opts.runId), opts.owner);
}

async function getRun(store: RunStore, runId: string, owner: RunOwner): Promise<Response> {
	const run = await getRunForOwner(store, runId, owner);
	return json(run);
}

async function getRunForOwner(store: RunStore, runId: string, owner: RunOwner): Promise<RunRecord> {
	const run = await store.getRun(runId);
	if (!run) throw new RunNotFoundError({ runId });
	if (!sameOwner(run.owner, owner)) throw new RunNotFoundError({ runId });
	return run;
}

function sameOwner(left: RunOwner, right: RunOwner): boolean {
	return left.workflowName === right.workflowName && left.instanceId === right.instanceId;
}

function requireRunId(runId: string | undefined): string {
	if (!runId) {
		throw new InvalidRequestError({ reason: 'Run id is required for this endpoint.' });
	}
	return runId;
}

function json(data: unknown): Response {
	return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
}
