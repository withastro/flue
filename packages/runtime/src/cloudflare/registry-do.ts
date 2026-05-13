/**
 * `FlueRegistry` — singleton Durable Object holding the cross-deployment
 * run pointer index for the Cloudflare target.
 *
 * The body of the registry (SQL, REST routing, pruning) lives in
 * `./registry-ops.ts` so it can be unit-tested in Node with a fake
 * `SqlStorage`. This file is a thin DO shim: it exists to extend the
 * workerd-only `DurableObject` base class and wire `state.storage.sql`
 * into the testable `createRegistryOps` factory.
 *
 * Every agent DO writes to this single registry on run start / end via
 * the `CloudflareRunRegistry` client (`./run-registry.ts`). The main
 * worker reads from it to resolve `runId → (agentName, instanceId)`
 * before forwarding a `/runs/:runId` request to the owning agent DO.
 *
 * # Why a DO, not KV
 *
 * Strong consistency. After a run starts, the very next request can
 * legitimately be `GET /runs/<runId>`; KV's eventual-consistency
 * window makes that fragile. SQLite-backed DOs give us sub-millisecond
 * read-your-writes within a region.
 *
 * # Why a singleton (not sharded)
 *
 * Per phase 1, decision 2. A single DO serializes writes across the
 * deployment's lifecycle. Sharding is a deferred optimization; the
 * registry's interface is designed so a future shard layer can slot
 * in without breaking callers.
 *
 * # Wire shape
 *
 * Documented in `./registry-ops.ts` — the same REST surface the
 * `CloudflareRunRegistry` client speaks to.
 */
import { createRegistryOps, type RegistryOps, handleRegistryRequest } from './registry-ops.ts';

/**
 * `DurableObjectState` shape the DO actually uses. Only the bits we
 * touch are declared so this file compiles without a perfect identity
 * match against `@cloudflare/workers-types` (workerd's real
 * `DurableObjectState` carries it in full at runtime).
 */
interface DurableObjectStateLike {
	storage: { sql: import('./registry-ops.ts').SqlStorage };
}

/**
 * The base `DurableObject` class is exported by `cloudflare:workers`,
 * a virtual module that only resolves inside workerd. tsdown's bundler
 * is told to treat the specifier as external (see
 * `tsdown.config.ts`'s `external` list) so the import survives the
 * bundle as a plain ESM reference — workerd resolves it at runtime
 * when the CF entry loads.
 *
 * `@cloudflare/workers-types` declares the module ambiently (we have
 * it in `types` for this package), so this import is legal at the
 * type level too.
 */
import { DurableObject } from 'cloudflare:workers';

export class FlueRegistry extends DurableObject {
	private ops: RegistryOps;

	constructor(state: DurableObjectStateLike, env: unknown) {
		// `super` matches the real `DurableObject` constructor signature
		// `(state: DurableObjectState, env: Env)` provided by
		// `@cloudflare/workers-types`. The looser shape we accept (a
		// minimal `state` interface and `env: unknown`) lets us avoid
		// pulling in the full workers-types `Env` plumbing for what is
		// effectively an empty pass-through.
		super(state as unknown as DurableObjectState, env as never);
		this.ops = createRegistryOps(state.storage.sql);
	}

	async fetch(request: Request): Promise<Response> {
		return handleRegistryRequest(this.ops, request);
	}
}
