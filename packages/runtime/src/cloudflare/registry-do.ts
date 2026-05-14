/** Singleton run-pointer index for the Cloudflare target. */
import { createRegistryOps, handleRegistryRequest, type RegistryOps } from './registry-ops.ts';

interface DurableObjectStateLike {
	storage: { sql: import('./registry-ops.ts').SqlStorage };
}

import { DurableObject } from 'cloudflare:workers';

export class FlueRegistry extends DurableObject {
	private ops: RegistryOps;

	constructor(state: DurableObjectStateLike, env: unknown) {
		super(state as unknown as DurableObjectState, env as never);
		this.ops = createRegistryOps(state.storage.sql);
	}

	async fetch(request: Request): Promise<Response> {
		return handleRegistryRequest(this.ops, request);
	}
}
