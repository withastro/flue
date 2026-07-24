/**
 * `start()` — the Node bootstrap for running Flue outside a generated server
 * entry: standalone scripts (`node ./scripts/report.ts`) and user test
 * suites. The CLI's `flue run` shares the same assembly (`./assemble.ts`)
 * with module loading layered on top.
 *
 * One process holds at most one Flue runtime (the runtime keeps module-scoped
 * registries — see `configureFlueRuntime`), so `start()` refuses to run where
 * a runtime is already configured: inside a Flue server, `init()`/`dispatch()`
 * work directly and no bootstrap is needed.
 */

import type { Provider } from '@earendil-works/pi-ai';
import type { PersistenceAdapter } from '../agent-execution-store.ts';
import { registerDefaultProviders } from '../runtime/builtin-providers.ts';
import { getFlueRuntime } from '../runtime/flue-app.ts';
import { setProvider } from '../runtime/providers.ts';
import { type FlueAgentRegistration, resolveAgentIdentity } from '../runtime/registration.ts';
import type { Agent } from '../types.ts';
import { sqlite } from './agent-execution-store.ts';
import { assembleNodeAgentRuntime, connectPersistenceAdapter } from './assemble.ts';

/**
 * A configured `start()` entry, for when the bare function isn't enough:
 * an identity override (inline/anonymous functions in tests).
 */
export interface StartAgentConfig {
	/** The agent function. */
	agent: Agent;
	/**
	 * Identity override; keys durable conversation storage. Defaults to the
	 * agent's own identity (its `agentName` static, else the function name).
	 * NEVER inferred positionally — positional names would silently reassign
	 * conversations when the agents array is reordered.
	 */
	name?: string;
}

export type StartAgentEntry = Agent | StartAgentConfig;

export interface StartOptions {
	/**
	 * The agents this runtime serves: agent functions, or `{ agent, name? }`
	 * entries when an identity override is needed.
	 */
	agents: readonly StartAgentEntry[];
	/**
	 * Persistence. Defaults to in-memory SQLite (process lifetime — nothing
	 * survives exit). Pass an adapter (e.g. `sqlite('./run.db')`) to persist
	 * conversations across runs.
	 */
	db?: PersistenceAdapter;
	/** Runtime environment. Defaults to `process.env`. */
	env?: Record<string, string | undefined>;
	/**
	 * The providers this runtime registers, replacing the default set. Pass pi
	 * Provider objects — built-in factories (`anthropicProvider()` from
	 * `@earendil-works/pi-ai/providers/anthropic`), `createProvider(...)`
	 * customs, or a faux provider's `.provider` in tests. Omitted registers
	 * every pi built-in; an empty array registers none.
	 */
	providers?: readonly Provider[];
}

/** A started Flue runtime. Stop it when the script is done. */
export interface Flue {
	/** Graceful shutdown: drain in-flight work, then disconnect persistence. */
	stop(): Promise<void>;
	[Symbol.asyncDispose](): Promise<void>;
}

/**
 * Start the Flue runtime in this process — the bootstrap for standalone
 * scripts and test suites, mirroring what a generated Flue server entry does
 * at boot (registration, persistence, the durable submission coordinator)
 * without any HTTP surface.
 *
 * After `start()` resolves, the runtime-backed APIs work exactly as they do
 * inside a Flue server: the `init()` handle to send messages and read their
 * settled replies, the top-level `dispatch()` to fire-and-forget.
 *
 * ```ts
 * import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
 * import { init } from '@flue/runtime';
 * import { sqlite, start } from '@flue/runtime/node';
 * import { Reporter } from '../src/agents/reporter.ts';
 *
 * await using flue = await start({
 *   agents: [Reporter], // the function IS the agent
 *   db: sqlite('./nightly.db'), // omit for in-memory
 *   providers: [anthropicProvider()], // omit for every pi built-in
 * });
 *
 * const agent = init(Reporter, { id: `nightly-${date}` });
 * const receipt = await agent.dispatch('You have been triggered. Produce the nightly report.');
 * const reply = await agent.read(receipt);
 * console.log(reply.text);
 * ```
 *
 * Inside a Flue server (a generated entry, `flue dev`, a deploy) the runtime
 * is already configured — call `init()`/`dispatch()` directly; `start()`
 * throws there rather than split the process's registries.
 */
export async function start(options: StartOptions): Promise<Flue> {
	if (getFlueRuntime() !== undefined) {
		throw new Error(
			'[flue] start() found an already-configured Flue runtime in this process. ' +
				'Inside a Flue server, init()/dispatch() work directly — start() is only for ' +
				'standalone scripts and tests, and one process holds one runtime.',
		);
	}
	if (!Array.isArray(options?.agents) || options.agents.length === 0) {
		throw new Error('[flue] start() requires at least one agent: start({ agents: [MyAgent] }).');
	}
	const registrations: FlueAgentRegistration[] = options.agents.map((record) =>
		normalizeStartAgentEntry(record),
	);

	// Same default provider set a generated server entry registers. Custom
	// providers registered with setProvider() before start() are preserved.
	// Passing `providers` replaces the default set entirely — even an empty
	// array skips registerDefaultProviders(), registering nothing.
	if (options.providers === undefined) {
		registerDefaultProviders();
	} else {
		for (const provider of options.providers) setProvider(provider);
	}

	const adapter = options.db ?? sqlite();
	const stores = await connectPersistenceAdapter(
		adapter,
		options.db !== undefined ? 'start({ db })' : 'the default in-memory sqlite adapter',
	);
	let assembled: Awaited<ReturnType<typeof assembleNodeAgentRuntime>>;
	try {
		assembled = await assembleNodeAgentRuntime({
			agents: registrations,
			adapter,
			stores,
			...(options.env !== undefined ? { env: options.env } : {}),
		});
	} catch (error) {
		try {
			await adapter.close?.();
		} catch {
			// Best-effort: surface the assembly failure, not the close failure.
		}
		throw error;
	}

	return {
		stop: () => assembled.close(),
		[Symbol.asyncDispose]: () => assembled.close(),
	};
}

function normalizeStartAgentEntry(record: StartAgentEntry): FlueAgentRegistration {
	if (typeof record === 'function') {
		return { identity: requireIdentity(record, undefined), agent: record };
	}
	if (!record || typeof record !== 'object' || typeof record.agent !== 'function') {
		throw new Error(
			'[flue] start() agents entries must be agent functions or { agent, name? } records.',
		);
	}
	return { identity: requireIdentity(record.agent, record.name), agent: record.agent };
}

function requireIdentity(agent: Agent, override: string | undefined): string {
	const identity = override ?? resolveAgentIdentity(agent);
	if (identity === undefined) {
		throw new Error(
			'[flue] start() could not resolve an identity for an agents entry: the function is ' +
				'anonymous and carries no agentName static. Name the function, assign ' +
				"`fn.agentName = '<identity>'`, or use the { agent, name } entry form.",
		);
	}
	return identity;
}
