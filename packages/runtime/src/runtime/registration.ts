/**
 * Agent identity registry and the mountable per-agent router.
 *
 * THE AGENT IS THE FUNCTION. An agent's *identity* is the slug that keys
 * durable storage: conversation streams on Node (`agentStreamPath(identity,
 * id)`) and the Durable Object class on Cloudflare. It resolves from the
 * function itself, in order:
 *
 *   1. The build-stamped binding — the `'use agent'` transform injects
 *      `__flueBindAgentModule(fn, { identity: '<literal>' })` per agent
 *      export, capturing the source-level name (or its `agentName` static
 *      override) before minification can touch identifiers.
 *   2. The `agentName` static (`fn.agentName = 'issue-triage'`).
 *   3. The function's own name (`fn.name`) — safe in plugin-less contexts
 *      (`flue run`, unit tests, `start()` scripts) where no minifier runs.
 *
 * App membership comes from {@link registerFlueAgents}, called once by the
 * generated bootstrap with the full scanned agent set (or by `start()` for
 * standalone scripts). Durability rides the function as the `durability`
 * static — read per identity through the registry via
 * {@link resolveAgentDurability}.
 *
 * {@link createAgentRouter} is a pure router factory: no side effects,
 * callable any number of times, mountable at any path. Handlers resolve the
 * runtime at request time, so mounting order relative to bootstrap
 * registration does not matter.
 */

import { Hono } from 'hono';
import type * as v from 'valibot';
import { assertDurability } from '../agent-tuning.ts';
import { MethodNotAllowedError, toHttpResponse } from '../errors.ts';
import { isValibotSchema } from '../schema.ts';
import type { Agent, DurabilityConfig } from '../types.ts';
import {
	assertAgentInstanceId,
	executeAgentAbort,
	executeAgentAttachmentRead,
	executeAgentConversationRead,
	executeAgentPrompt,
} from './agent-routes.ts';
import { getFlueRuntime } from './flue-app.ts';

/**
 * IDENTITY BINDING CONTRACT — consumed by the `@flue/vite` `'use agent'`
 * transform.
 *
 * For every agent export of a marked module (each exported function with a
 * capitalized name), the transform appends:
 *
 * ```ts
 * import { __flueBindAgentModule } from '@flue/runtime';
 * __flueBindAgentModule(<namespace>.<ExportName>, { identity: '<literal>' });
 * ```
 *
 * The identity is the function's source-level name, or its `agentName`
 * static override — resolved at build time and stamped as a string literal,
 * so bundled (minified) builds keep the durable identity intact.
 */
export interface AgentIdentityBinding {
	/** The agent's durable identity. Keys durable storage; non-empty, no `:`. */
	identity: string;
}

/** One registered agent: the function joined to its identity. */
export interface FlueAgentRegistration extends AgentIdentityBinding {
	agent: Agent;
}

/**
 * Agent identities key durable storage everywhere (Durable Object class +
 * binding names on Cloudflare, conversation storage slugs on Node), so they
 * are restricted to predictable identifier-ish shapes: PascalCase function
 * names (`IssueTriage`) and kebab-case overrides (`issue-triage`) both
 * match. Canonical copy — `@flue/vite`'s agent-scan mirrors it for
 * build-time enforcement.
 */
export const AGENT_IDENTITY_PATTERN = /^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*$/;

let identityBindings = new WeakMap<Agent, AgentIdentityBinding>();
let registeredAgents = new Map<string, FlueAgentRegistration>();

/**
 * Bind a build-derived identity to an agent function.
 *
 * Not public API — the `'use agent'` build transform injects calls to this
 * (see {@link AgentIdentityBinding} for the exact emitted shape). Idempotent
 * for the same function/identity pair: re-evaluation of a module (dev
 * reload) rebinds in place. Rebinding one function to a different identity
 * is an authoring error and throws.
 *
 * Returns the function so the transform may also use it in expression
 * position.
 */
export function __flueBindAgentModule<TAgent extends Agent>(
	agent: TAgent,
	binding: AgentIdentityBinding,
): TAgent {
	assertAgentFunction(agent, binding?.identity ?? '(unknown)');
	assertAgentIdentity(binding?.identity);
	const existing = identityBindings.get(agent);
	if (existing && existing.identity !== binding.identity) {
		throw new Error(
			`[flue] Agent function is already bound to identity "${existing.identity}" and cannot be rebound as "${binding.identity}". ` +
				'Each agent function carries exactly one durable identity.',
		);
	}
	identityBindings.set(agent, { identity: binding.identity });
	return agent;
}

/**
 * Register the application's full agent set (the scanned `'use agent'`
 * modules). Called by the generated bootstrap; replaces any previous
 * registration wholesale, so a dev-reload bootstrap simply registers again.
 *
 * Not public API — exposed via `@flue/runtime/internal` for generated code.
 */
export function registerFlueAgents(records: readonly FlueAgentRegistration[]): void {
	const next = new Map<string, FlueAgentRegistration>();
	for (const record of records) {
		const identity = record?.identity ?? '(unknown)';
		assertAgentFunction(record?.agent, identity);
		assertAgentIdentity(record?.identity);
		const duplicateIdentity = next.get(record.identity);
		if (duplicateIdentity) {
			throw new Error(
				`[flue] Duplicate agent identity "${record.identity}". ` +
					'Agent identities derive from function names (or their `agentName` static override) and must be unique.',
			);
		}
		const duplicateAgent = [...next.values()].find((existing) => existing.agent === record.agent);
		if (duplicateAgent) {
			throw new Error(
				`[flue] Agents "${duplicateAgent.identity}" and "${record.identity}" are the same function value. ` +
					'Each registered agent must be a distinct function.',
			);
		}
		const bound = identityBindings.get(record.agent);
		if (bound && bound.identity !== record.identity) {
			throw new Error(
				`[flue] Agent function is already bound to identity "${bound.identity}" and cannot be registered as "${record.identity}".`,
			);
		}
		next.set(record.identity, { identity: record.identity, agent: record.agent });
	}
	registeredAgents = next;
	// Registration also binds, so identity resolution works for functions
	// registered without the build transform (tests, `start()` scripts).
	for (const record of next.values()) {
		identityBindings.set(record.agent, { identity: record.identity });
	}
}

/** The currently registered agent set, in registration order. */
export function getRegisteredFlueAgents(): readonly FlueAgentRegistration[] {
	return [...registeredAgents.values()];
}

/**
 * The identity under which this exact function value is registered with the
 * app, or `undefined` when it is not part of the registered set. Registration
 * rejects a function whose binding names a different identity, so resolving
 * the identity and re-checking membership is exact function-value lookup.
 */
export function getRegisteredAgentIdentity(agent: Agent): string | undefined {
	const identity = resolveAgentIdentity(agent);
	if (identity === undefined) return undefined;
	return registeredAgents.get(identity)?.agent === agent ? identity : undefined;
}

/** Whether an identity names an agent registered with the app. */
export function isRegisteredAgentIdentity(identity: string): boolean {
	return registeredAgents.has(identity);
}

/**
 * Resolve an agent function's durable identity: the build-stamped binding,
 * else the `agentName` static, else the function's own name. Returns
 * `undefined` for an anonymous, unbound function.
 */
export function resolveAgentIdentity(agent: Agent): string | undefined {
	const bound = identityBindings.get(agent)?.identity;
	if (bound !== undefined) return bound;
	if (agent.agentName !== undefined) {
		if (typeof agent.agentName !== 'string' || !AGENT_IDENTITY_PATTERN.test(agent.agentName)) {
			throw new Error(
				`[flue] Agent "${agent.name || '(anonymous)'}" has an invalid agentName static ` +
					`("${String(agent.agentName)}"). Agent identities must match ${AGENT_IDENTITY_PATTERN}.`,
			);
		}
		return agent.agentName;
	}
	return agent.name === '' ? undefined : agent.name;
}

/**
 * The submission retry policy for an agent identity, read from the agent's
 * `durability` static (validated). Like `agentName` and `initialData`, the
 * static is contract the platform reads WITHOUT running the function, so the
 * policy stays readable when a render crashes — and an environment-dependent
 * policy is expressed in the assigned value (`Fn.durability = flag ? x : y`),
 * not by where the assignment lives. Returns `undefined` (store defaults
 * apply) for an unregistered identity or an agent carrying no static.
 */
export function resolveAgentDurability(identity: string | undefined): DurabilityConfig | undefined {
	if (identity === undefined) return undefined;
	const durability = registeredAgents.get(identity)?.agent.durability;
	if (durability === undefined) return undefined;
	assertDurability(durability, `[agent "${identity}"]`);
	return durability;
}

/**
 * The agent's `initialData` contract static, shape-checked. Read directly
 * off the function — the schema is intrinsic contract, so it needs no
 * binding or registration to apply.
 */
export function resolveAgentInitialDataSchema(agent: Agent): v.GenericSchema | undefined {
	if (agent.initialData === undefined) return undefined;
	if (!isValibotSchema(agent.initialData)) {
		throw new Error(
			`[flue] Agent "${resolveAgentIdentity(agent) ?? agent.name}" has an invalid initialData static: ` +
				'it must be a Valibot schema for the instance creation data.',
		);
	}
	return agent.initialData;
}

export function resetFlueAgentRegistrationForTests(): void {
	identityBindings = new WeakMap();
	registeredAgents = new Map();
}

// ─── The mountable per-agent router ─────────────────────────────────────────

/**
 * Build the mountable Hono sub-app serving one agent's HTTP surface.
 *
 * Routes, relative to wherever the caller mounts the sub-app:
 *
 * - `POST /:id` — send a prompt (202 admission)
 * - `GET|HEAD /:id` — DS conversation stream read
 * - `POST /:id/abort` — abort in-flight/queued work
 * - `ALL /:id/attachments/:attachmentId` — attachment byte download
 *
 * Mounting is the exposure decision; auth and other middleware compose in
 * the host app (`app.use('/agents/triage/*', auth)`). The returned Hono app
 * has `.fetch`, so it also mounts in any fetch-based server framework.
 * Handlers resolve the runtime at request time, so creating the router
 * before the bootstrap registers the scanned set is fine.
 */
export function createAgentRouter(agent: Agent): Hono {
	assertAgentFunction(agent, '(unresolved)');
	const identity = resolveAgentIdentity(agent);
	if (identity === undefined) {
		throw new Error(
			'[flue] createAgentRouter() could not resolve an identity for this agent: the function is ' +
				'anonymous and carries no agentName static. Name the function (or assign ' +
				"`fn.agentName = '<identity>'`).",
		);
	}
	assertAgentIdentity(identity);

	const app = new Hono();

	app.post('/:id', async (c) => {
		const rt = requireRuntime();
		const id = c.req.param('id') ?? '';
		assertAgentInstanceId(id);
		return executeAgentPrompt(rt, {
			agentName: identity,
			instanceId: id,
			request: c.req.raw.clone(),
			env: c.env,
		});
	});

	// Abort all in-flight/queued work for an agent instance. A distinct
	// (longer) path, so it never collides with the prompt/stream routes.
	app.all('/:id/abort', async (c) => {
		const rt = requireRuntime();
		if (c.req.method !== 'POST') {
			throw new MethodNotAllowedError({ method: c.req.method, allowed: ['POST'] });
		}
		const id = c.req.param('id') ?? '';
		assertAgentInstanceId(id);
		return executeAgentAbort(rt, {
			agentName: identity,
			instanceId: id,
			request: c.req.raw.clone(),
			env: c.env,
		});
	});

	// Attachment byte download. A distinct (longer) path, so it never
	// collides with the prompt/stream routes.
	app.all('/:id/attachments/:attachmentId', async (c) => {
		const rt = requireRuntime();
		if (c.req.method !== 'GET') {
			throw new MethodNotAllowedError({ method: c.req.method, allowed: ['GET'] });
		}
		return executeAgentAttachmentRead(rt, {
			agentName: identity,
			instanceId: c.req.param('id') ?? '',
			attachmentId: c.req.param('attachmentId') ?? '',
			request: c.req.raw.clone(),
			env: c.env,
		});
	});

	// GET/HEAD stream reads, and the canonical 405 envelope for any other
	// unmatched method (instead of Hono's default 404).
	app.all('/:id', async (c) => {
		const rt = requireRuntime();
		if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && c.req.method !== 'POST') {
			throw new MethodNotAllowedError({
				method: c.req.method,
				allowed: ['GET', 'HEAD', 'POST'],
			});
		}
		const id = c.req.param('id') ?? '';
		assertAgentInstanceId(id);
		return executeAgentConversationRead(rt, {
			agentName: identity,
			instanceId: id,
			request: c.req.raw,
			env: c.env,
		});
	});

	app.onError((err) => toHttpResponse(err));

	return app;
}

function requireRuntime() {
	const rt = getFlueRuntime();
	if (!rt) {
		throw new Error(
			'[flue] Agent route invoked before the runtime was configured. ' +
				'This usually means the mounted app is served outside a Flue-built server entry.',
		);
	}
	return rt;
}

function assertAgentFunction(value: unknown, identity: string): asserts value is Agent {
	// Twin: `isAgentFunction` in flue-app.ts — keep in sync.
	if (typeof value !== 'function') {
		throw new Error(
			`[flue] Agent "${identity}" must be a function — the agent IS the function. ` +
				"Export a capitalized function from a 'use agent' module (there is no wrapper to call).",
		);
	}
}

/**
 * Identity charset: must match {@link AGENT_IDENTITY_PATTERN} — non-empty,
 * identifier-ish (PascalCase function names and kebab-case overrides), and
 * in particular no `:` (URL addressing reserves a single namespace segment).
 */
function assertAgentIdentity(identity: unknown): asserts identity is string {
	if (typeof identity !== 'string' || !AGENT_IDENTITY_PATTERN.test(identity)) {
		throw new Error(
			`[flue] Agent identity "${String(identity)}" is invalid. Agent identities must match ${AGENT_IDENTITY_PATTERN} ` +
				'(a function name like "IssueTriage", or a kebab-case override like "issue-triage").',
		);
	}
}
