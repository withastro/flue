/**
 * Worker-side Flue runtime seams for the generated Cloudflare entry.
 *
 * The entry installs these via `configureFlueRuntime`: the dispatch queue
 * (durable admission against the target agent's Durable Object), the DO
 * request router, and instance lookup. Building them here keeps the logic
 * tested TypeScript instead of generated string code; the entry injects only
 * what the runtime's import graph must not contain — the module-scope `env`
 * from `cloudflare:workers` and a `fetchAgent` capability built on the
 * `agents` package.
 */

import {
	AgentInstanceExistsError,
	AgentInstanceNotFoundError,
	InvalidRequestError,
} from '../errors.ts';
import type { DispatchInput, DispatchQueue } from '../runtime/dispatch-queue.ts';
import type { CloudflareRuntime } from '../runtime/flue-app.ts';
import type { DispatchReceipt } from '../types.ts';
import {
	CLOUDFLARE_AGENT_INTERNAL_DISPATCH_PATH,
	CLOUDFLARE_AGENT_INTERNAL_INSTANCE_INFO_PATH,
} from './agent-coordinator.ts';

/** How the generated entry addresses one scanned agent's Durable Object. */
export interface CloudflareAgentIdentity {
	readonly bindingName: string;
	readonly className: string;
}

export interface CreateCloudflareWorkerConfigOptions {
	/**
	 * Module-scope `env` from `cloudflare:workers` — the binding source for
	 * calls that carry no per-request env (cron callbacks, queue consumers,
	 * Workflow steps, and the programmatic agent client).
	 */
	env: unknown;
	/** Agent identity → Durable Object binding, from the build-time scan. */
	agentIdentities: Record<string, CloudflareAgentIdentity>;
	/** Route one request to the named instance of an agent DO binding. */
	fetchAgent: (binding: unknown, instanceId: string, request: Request) => Promise<Response>;
}

/** The Cloudflare-target seams the generated entry passes to `configureFlueRuntime`. */
export type CloudflareWorkerConfig = Pick<
	CloudflareRuntime,
	'dispatchQueue' | 'routeAgentRequest' | 'instanceInfo'
>;

export function createCloudflareWorkerConfig(
	options: CreateCloudflareWorkerConfigOptions,
): CloudflareWorkerConfig {
	const { env, agentIdentities, fetchAgent } = options;

	const lookupBinding = (agentName: string, bindingEnv: unknown): unknown => {
		const identity = agentIdentities[agentName];
		if (!identity) return undefined;
		return (bindingEnv as Record<string, unknown> | null | undefined)?.[identity.bindingName];
	};

	const dispatchQueue: DispatchQueue = {
		async enqueue(input: DispatchInput): Promise<DispatchReceipt> {
			const binding = lookupBinding(input.agent, env);
			if (!binding) {
				throw new Error(
					`[flue] dispatch() target agent "${input.agent}" Durable Object binding is unavailable.`,
				);
			}
			const response = await fetchAgent(
				binding,
				input.id,
				new Request(`https://flue.invalid${CLOUDFLARE_AGENT_INTERNAL_DISPATCH_PATH}`, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(input),
				}),
			);
			if (!response.ok) {
				let rejection: unknown;
				try {
					rejection = await response.json();
				} catch {}
				throw dispatchAdmissionError(input, response.status, rejection);
			}
			return response.json() as Promise<DispatchReceipt>;
		},
	};

	const routeAgentRequest: CloudflareRuntime['routeAgentRequest'] = async (
		request,
		reqEnv,
		target,
	) => {
		// Handler-context callers forward their per-request env; contexts with
		// none (cron, queues, Workflow steps, the agent client) fall back to
		// the worker's module-scope env.
		const binding = lookupBinding(target.agentName, reqEnv ?? env);
		if (!binding) return null;
		return fetchAgent(binding, target.instanceId, request);
	};

	const instanceInfo: CloudflareRuntime['instanceInfo'] = async (agentName, instanceId) => {
		const binding = lookupBinding(agentName, env);
		if (!binding) {
			throw new Error(
				`[flue] getAgentInstance() target agent "${agentName}" Durable Object binding is unavailable.`,
			);
		}
		const response = await fetchAgent(
			binding,
			instanceId,
			new Request(`https://flue.invalid${CLOUDFLARE_AGENT_INTERNAL_INSTANCE_INFO_PATH}`, {
				method: 'GET',
			}),
		);
		if (!response.ok) {
			throw new Error(
				`[flue] getAgentInstance() lookup for agent "${agentName}" failed with status ${response.status}.`,
			);
		}
		const info = (await response.json()) as { exists?: unknown; uid?: unknown } | null;
		if (!info || info.exists !== true) return null;
		return { id: instanceId, ...(typeof info.uid === 'string' ? { uid: info.uid } : {}) };
	};

	return { dispatchQueue, routeAgentRequest, instanceInfo };
}

/**
 * Rehydrate a DO admission rejection into the typed error the node target
 * throws in-process, so uid conditions behave identically on both targets.
 * The structured body is produced by the coordinator's `admitDispatch`
 * (`type` selects the class, `uid` restores the 409's existing-incarnation
 * field); unrecognized bodies degrade to the generic dispatch error.
 */
function dispatchAdmissionError(input: DispatchInput, status: number, rejection: unknown): Error {
	const body =
		typeof rejection === 'object' && rejection !== null
			? (rejection as { type?: unknown; error?: unknown; details?: unknown; uid?: unknown })
			: undefined;
	switch (body?.type) {
		case 'agent_instance_exists':
			// A missing uid on this body would violate the invariant that an
			// existing instance's birth record always carries one — degrade to
			// the generic dispatch error below rather than construct with undefined.
			if (typeof body.uid === 'string') {
				return new AgentInstanceExistsError({ id: input.id, uid: body.uid });
			}
			break;
		case 'agent_instance_not_found':
			return new AgentInstanceNotFoundError({ id: input.id });
		case 'invalid_request':
			return new InvalidRequestError({
				reason:
					typeof body.details === 'string' && body.details !== ''
						? body.details
						: typeof body.error === 'string'
							? body.error
							: 'Dispatch admission was rejected.',
			});
	}
	if (typeof body?.error === 'string') {
		const details = typeof body.details === 'string' ? ` ${body.details}` : '';
		return Object.assign(
			new Error(
				`[flue] dispatch() target agent "${input.agent}" rejected admission: ${body.error}${details}`,
			),
			{ status, details: body.details },
		);
	}
	return new Error(
		`[flue] dispatch() target agent "${input.agent}" rejected durable admission with status ${status}.`,
	);
}
