/**
 * Transport-free execution bootstrap for `flue run <path>`.
 *
 * IMPORTANT — this module is NOT imported by the CLI process. It is loaded
 * through the same non-listening Vite server that loads the user's agent
 * module (see run-local.ts), so that every `@flue/runtime` specifier in the
 * execution graph — this bootstrap's, the agent module's, and the db
 * module's — resolves to exactly ONE on-disk copy of the runtime (the
 * project's install). The runtime keeps module-scoped registries (providers,
 * agent registration, instrumentation), so a second copy silently splits
 * that state. The CLI ships this file as its own build entry
 * (`dist/run-bootstrap.mjs`) with `@flue/runtime/*` kept external for the
 * same reason.
 *
 * The bootstrap drives the REAL durable submission path — the shared
 * `assembleNodeAgentRuntime` assembly (registration, persistence
 * connect/migrate/validate, `createNodeAgentCoordinator`, runtime seed), a
 * durable direct admission, and settlement observed from the canonical
 * conversation stream via the runtime's observation seam. Nothing HTTP is
 * created: no Hono app, no listener, no channels.
 */

import type { Agent, DeliveredMessage } from '@flue/runtime';
import {
	AGENT_IDENTITY_PATTERN,
	type AssembledNodeAgentRuntime,
	agentStreamPath,
	assembleNodeAgentRuntime,
	type ConversationStreamChunk,
	connectPersistenceAdapter,
	createInstrumentationOwner,
	observeSubmissionSettlement,
	type PersistenceAdapter,
	readSubmissionReply,
	registerDefaultProviders,
	runWithInstrumentationOwner,
} from '@flue/runtime/internal';
import { sqlite } from '@flue/runtime/node';

export interface FlueRunSessionOptions {
	/** Absolute path of the agent module; imported via {@link loadModule}. */
	agentModulePath: string;
	/**
	 * The module's agent export names, produced by scanning its source with
	 * the build scanner's export-shape rule (run-local.ts). Only these exports
	 * are agent candidates, so `flue run` and the build can never disagree
	 * about what is an agent.
	 */
	agentExports: readonly string[];
	/**
	 * Which agent to run, by name (`--name`). Without it the module must
	 * define exactly one agent.
	 */
	agentName?: string;
	/** Absolute path of the project's db entry, when one resolved. */
	dbModulePath?: string;
	/** Display name for the db entry in diagnostics (e.g. `src/db.ts`). */
	dbSource?: string;
	/**
	 * SQLite file used when no db entry resolves. Unlike the dev server's
	 * dev.db this file is NEVER wiped — `--id` continuation across `flue run`
	 * invocations depends on it accumulating history.
	 */
	defaultSqlitePath: string;
	/** Runtime environment; defaults to `process.env`. */
	env?: Record<string, string | undefined>;
	/**
	 * Module loader used for the agent and db entries. Supplied by the CLI as
	 * `viteServer.ssrLoadModule` so user modules get the full transform
	 * pipeline (TS, markdown/skill imports) inside the single-runtime graph.
	 */
	loadModule: (path: string) => Promise<Record<string, unknown>>;
}

export interface FlueRunSubmitOptions {
	/** Receives every conversation stream chunk as it is durably recorded. */
	onEvent?: (chunk: ConversationStreamChunk) => void;
	/** Instance-creation data; the seed, consulted only when this send creates. */
	initialData?: unknown;
	/**
	 * Send condition: a string continues only the incarnation with that uid
	 * (else the run rejects); `null` creates only when no instance exists.
	 * Omit to send unconditionally.
	 */
	uid?: string | null;
	/**
	 * Abort intent (SIGINT). Aborting requests a durable instance abort and
	 * keeps draining the stream until the aborted settlement is observed.
	 */
	signal?: AbortSignal;
}

export interface FlueRunOutcome {
	submissionId: string;
	outcome: 'completed' | 'failed' | 'aborted';
	error?: unknown;
	/** Final assistant message text produced by this submission ('' if none). */
	message: string;
	/** The contacted instance's uid (minted at creation, echoed on continues). */
	uid?: string;
}

export interface FlueRunSession {
	/** The agent's name: its `agentName` static, else its exported name. */
	readonly identity: string;
	/** Submit one message to a conversation and wait for settlement. */
	submit(
		conversationId: string,
		message: DeliveredMessage,
		options?: FlueRunSubmitOptions,
	): Promise<FlueRunOutcome>;
	/** Coordinator shutdown, instrumentation dispose, adapter close. */
	close(): Promise<void>;
}

interface RunAgentCandidate {
	/** The agent's name — its durable identity, and what `--name` matches. */
	name: string;
	agent: Agent;
}

/**
 * The module's agents: the source scan (run-local.ts) decides which exports
 * qualify — the build scanner's export-shape rule, so classes and
 * factory-made functions never count — and each agent's name stays a runtime
 * read: the `agentName` static when set, else the exported name (the
 * function's own name for `default`, where 'default' names the slot).
 */
function listModuleAgents(
	agentModule: Record<string, unknown>,
	agentExports: readonly string[],
): RunAgentCandidate[] {
	const candidates: RunAgentCandidate[] = [];
	for (const exportName of agentExports) {
		const value = agentModule[exportName];
		// The evaluated namespace can only disagree with the source scan through
		// exotic runtime mutation; such an export is not a runnable agent.
		if (typeof value !== 'function') continue;
		const agent = value as Agent;
		const exportedName = exportName === 'default' ? (agent.name ?? '') : exportName;
		const name = typeof agent.agentName === 'string' ? agent.agentName : exportedName;
		candidates.push({ name, agent });
	}
	return candidates;
}

/**
 * Pick the agent to run: the module's single agent, or the one `--name`
 * names. Several agents without `--name` fail listing the choices — never a
 * silent guess (no default-export preference, no positional pick), because
 * the choice keys conversation storage.
 */
function selectRunAgent(
	agentModule: Record<string, unknown>,
	agentExports: readonly string[],
	agentName: string | undefined,
	modulePath: string,
): RunAgentCandidate {
	const candidates = listModuleAgents(agentModule, agentExports);
	if (candidates.length === 0) {
		throw new Error(
			`[flue] ${modulePath} exports no agents. Export a capitalized agent function, ` +
				`e.g. \`export function MyAgent() { … }\`.`,
		);
	}
	const names = candidates.map((candidate) => candidate.name).join(', ');
	if (agentName !== undefined) {
		const matches = candidates.filter((candidate) => candidate.name === agentName);
		if (matches.length === 0) {
			throw new Error(
				`[flue] --name ${JSON.stringify(agentName)} does not match an agent of ${modulePath}. ` +
					`Agents: ${names}.`,
			);
		}
		const selected = matches[0];
		if (matches.length > 1 || selected === undefined) {
			throw new Error(
				`[flue] --name ${JSON.stringify(agentName)} matches ${matches.length} agents of ${modulePath}. ` +
					`Give each a distinct \`agentName\`.`,
			);
		}
		return selected;
	}
	const only = candidates[0];
	if (candidates.length > 1 || only === undefined) {
		throw new Error(
			`[flue] ${modulePath} defines ${candidates.length} agents (${names}). ` +
				`Pick one with --name <agent>.`,
		);
	}
	return only;
}

/**
 * Validate the selected agent's name as a durable identity — it keys
 * conversation storage. Function names are trustworthy here: `flue run`
 * never minifies user modules.
 */
function assertRunIdentity(name: string, modulePath: string): string {
	if (!AGENT_IDENTITY_PATTERN.test(name)) {
		throw new Error(
			`[flue] ${JSON.stringify(name)} is not a valid agent identity (${modulePath}). ` +
				`Rename the exported function or assign \`MyAgent.agentName = '<identity>'\`; ` +
				`identities must match ${AGENT_IDENTITY_PATTERN}.`,
		);
	}
	return name;
}

export async function createFlueRunSession(
	options: FlueRunSessionOptions,
): Promise<FlueRunSession> {
	const runtimeEnv = options.env ?? process.env;
	const instrumentationOwner = createInstrumentationOwner();
	let persistenceAdapter: PersistenceAdapter | undefined;
	let assembled: AssembledNodeAgentRuntime | undefined;

	try {
		// User modules evaluate inside the instrumentation owner so that any
		// `instrument(...)` calls made at module scope are disposed by close(),
		// mirroring the generated Node entry's startup.
		return await runWithInstrumentationOwner(instrumentationOwner, async () => {
			const agentModule = await options.loadModule(options.agentModulePath);
			const selected = selectRunAgent(
				agentModule,
				options.agentExports,
				options.agentName,
				options.agentModulePath,
			);
			const identity = assertRunIdentity(selected.name, options.agentModulePath);
			const agent = selected.agent;

			const dbSource = options.dbSource ?? 'db.ts';
			let adapter: PersistenceAdapter;
			let adapterSource: string;
			if (options.dbModulePath !== undefined) {
				const dbModule = await options.loadModule(options.dbModulePath);
				adapter = dbModule.default as PersistenceAdapter;
				adapterSource = dbSource;
			} else {
				// The default run.db is NEVER wiped — `--id` continuation across
				// `flue run` invocations depends on it accumulating history.
				adapter = sqlite(options.defaultSqlitePath);
				adapterSource = 'the default sqlite adapter';
			}
			// connect() is awaited once at startup so an unreachable or
			// misconfigured database fails at boot, not mid-conversation.
			const stores = await connectPersistenceAdapter(adapter, adapterSource);
			persistenceAdapter = adapter;

			// `flue run` always carries the full built-in provider catalog: it
			// loads only the agent module (never app.ts), and the `providers`
			// config narrowing is a server-build concern. Agent-module
			// setProvider() calls ran at import above and win by ID.
			registerDefaultProviders();

			// The shared runtime assembly the generated Node entry and `start()`
			// use: registration, coordinator, dispatch queue, runtime seed, and
			// startup reconciliation (the run.db persists across invocations).
			const runtime = await assembleNodeAgentRuntime({
				agents: [{ identity, agent }],
				adapter,
				stores,
				env: runtimeEnv,
			});
			assembled = runtime;

			let closing: Promise<void> | undefined;
			return {
				identity,
				submit: (conversationId, message, submitOptions = {}) =>
					submitAndSettle({
						coordinator: runtime.coordinator,
						conversationStreamStore: runtime.conversationStreamStore,
						identity,
						conversationId,
						message,
						...submitOptions,
					}),
				close() {
					closing ??= (async () => {
						const errors: unknown[] = [];
						try {
							await runtime.close();
						} catch (error) {
							errors.push(error);
						}
						try {
							await instrumentationOwner.dispose();
						} catch (error) {
							errors.push(error);
						}
						if (errors.length === 1) throw errors[0];
						if (errors.length > 1) {
							throw new AggregateError(errors, '[flue] flue run shutdown failed.');
						}
					})();
					return closing;
				},
			};
		});
	} catch (error) {
		// Startup failed part-way: unwind whatever was created, then rethrow.
		const cleanupErrors: unknown[] = [];
		try {
			if (assembled) await assembled.close();
			else if (persistenceAdapter?.close) await persistenceAdapter.close();
		} catch (cleanupError) {
			cleanupErrors.push(cleanupError);
		}
		try {
			await instrumentationOwner.dispose();
		} catch (cleanupError) {
			cleanupErrors.push(cleanupError);
		}
		if (cleanupErrors.length) {
			throw new AggregateError([error, ...cleanupErrors], '[flue] flue run startup failed.');
		}
		throw error;
	}
}

// ─── Submission + settlement observation ────────────────────────────────────

interface SubmitAndSettleOptions extends FlueRunSubmitOptions {
	coordinator: AssembledNodeAgentRuntime['coordinator'];
	conversationStreamStore: NonNullable<
		Awaited<ReturnType<PersistenceAdapter['connect']>>['conversationStreamStore']
	>;
	identity: string;
	conversationId: string;
	message: DeliveredMessage;
}

/**
 * Admit one durable direct submission (the same admission
 * `POST /agents/.../:id` uses) and observe its settlement from the canonical
 * conversation stream via the runtime's observation seam — no transport.
 * This is `invokeDirectAttached` semantics without HTTP.
 */
async function submitAndSettle(options: SubmitAndSettleOptions): Promise<FlueRunOutcome> {
	const { coordinator, conversationStreamStore, identity, conversationId, message } = options;
	throwIfAborted(options.signal);

	const admit = coordinator.createAdmission(identity, conversationId);
	const receipt = await admit(message, {
		...(options.initialData !== undefined ? { initialData: options.initialData } : {}),
		...(options.uid !== undefined ? { uid: options.uid } : {}),
	});
	const streamPath = agentStreamPath(identity, conversationId);

	let abortRequested = false;
	const requestAbort = () => {
		if (abortRequested) return;
		abortRequested = true;
		// Durable abort intent; settlement (outcome 'aborted') arrives
		// asynchronously on the conversation stream, which we keep observing.
		void coordinator.abortInstance(identity, conversationId).catch((error) => {
			console.error('[flue] Abort request failed:', error);
		});
	};
	if (options.signal?.aborted) requestAbort();
	options.signal?.addEventListener('abort', requestAbort, { once: true });

	try {
		const settlement = await observeSubmissionSettlement({
			store: conversationStreamStore,
			path: streamPath,
			submissionId: receipt.submissionId,
			offset: receipt.offset,
			...(options.onEvent !== undefined ? { onEvent: options.onEvent } : {}),
		});
		const reply = await readSubmissionReply({
			store: conversationStreamStore,
			path: streamPath,
			submissionId: receipt.submissionId,
		});

		return {
			submissionId: receipt.submissionId,
			outcome: settlement.outcome,
			...(settlement.error === undefined ? {} : { error: settlement.error }),
			message: reply.text,
			...(receipt.uid !== undefined ? { uid: receipt.uid } : {}),
		};
	} finally {
		options.signal?.removeEventListener('abort', requestAbort);
	}
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
}
