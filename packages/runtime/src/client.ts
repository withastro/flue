import {
	composeAgentSystemPrompt,
	discoverSandboxSkills,
	joinWorkspaceContext,
	readAgentsMd,
	readSandboxContextFile,
	skillsDirIn,
} from './context.ts';
import { normalizeAgentDefinition } from './definition.ts';
import { Harness } from './harness.ts';
import { dispatchGlobalEvent } from './runtime/events.ts';
import { bashFactoryToSessionEnv, createCwdSessionEnv, isBashLike } from './sandbox.ts';
import type {
	AgentConfig,
	AgentInit,
	BashFactory,
	FlueContext,
	FlueEvent,
	FlueEventCallback,
	FlueHarness,
	SandboxFactory,
	SessionEnv,
	SessionStore,
	SkillDefinition,
	SessionToolFactory,
} from './types.ts';

export interface FlueContextConfig {
	actionName: string;
	id: string;
	runId: string;
	payload: any;
	env: Record<string, any>;
	agentConfig: AgentConfig;
	createDefaultEnv: () => Promise<SessionEnv>;
	defaultStore: SessionStore;
	/**
	 * Platform-specific sandbox resolver hook. Called before default resolution.
	 * Returns SessionEnv to use, or null to fall through to default logic.
	 */
	resolveSandbox?: (sandbox: unknown) => Promise<SessionEnv> | null;
	/**
	 * The current HTTP request, if any. Surfaced to handlers as `ctx.req`.
	 * Build plugins pass the standard Fetch `Request` through; non-HTTP entry
	 * points (e.g. future cron triggers) leave it undefined.
	 */
	req?: Request;
}

/** Extends FlueContext with server-only methods. Agent handlers only see FlueContext. */
export interface FlueContextInternal extends FlueContext {
	/** Decorate and dispatch an event, returning the decorated event. */
	emitEvent(event: FlueEvent): FlueEvent;
	subscribeEvent(callback: FlueEventCallback): () => void;
	setEventCallback(callback: FlueEventCallback | undefined): void;
}

export function createFlueContext(config: FlueContextConfig): FlueContextInternal {
	const subscribers = new Set<FlueEventCallback>();
	let handlerUnsubscribe: (() => void) | undefined;
	let eventIndex = 0;
	const initializedHarnessNames = new Set<string>();

	const emitEvent = (event: FlueEvent): FlueEvent => {
		const decorated: FlueEvent = {
			...event,
			runId: config.runId,
			eventIndex: eventIndex++,
			timestamp: new Date().toISOString(),
		};
		for (const subscriber of subscribers) {
			try {
				Promise.resolve(subscriber(decorated)).catch((error) => {
					console.error('[flue:subscriber] Event subscriber failed:', error);
				});
			} catch (error) {
				console.error('[flue:subscriber] Event subscriber failed:', error);
			}
		}
		// Fan out to module-scoped subscribers registered via
		// `observe()` from `@flue/runtime/app`. These run after the
		// per-context subscribers and receive the originating `ctx` as
		// a second argument so cross-cutting code (error reporting,
		// log forwarding) can read `ctx.id`, `ctx.runId`, etc.
		dispatchGlobalEvent(decorated, ctx);
		return decorated;
	};

	const ctx: FlueContextInternal = {
		get id() {
			return config.id;
		},

		get runId() {
			return config.runId;
		},

		get payload() {
			return config.payload;
		},

		get env() {
			return config.env;
		},

		get req() {
			return config.req;
		},

		log: {
			info(message, attributes) {
				emitEvent({ type: 'log', level: 'info', message, attributes: normalizeLogAttributes(attributes) });
			},
			warn(message, attributes) {
				emitEvent({ type: 'log', level: 'warn', message, attributes: normalizeLogAttributes(attributes) });
			},
			error(message, attributes) {
				emitEvent({ type: 'log', level: 'error', message, attributes: normalizeLogAttributes(attributes) });
			},
		},

		async init(options?: AgentInit): Promise<FlueHarness> {
			if (!options) {
				throw new Error('[flue] init() requires an options object. Pass { agent } or inline resources.');
			}
			if (options.model !== undefined && options.model !== false && typeof options.model !== 'string') {
				throw new Error('[flue] init({ model }) must be a model string or false.');
			}

			const name = options.name ?? 'default';
			if (initializedHarnessNames.has(name)) {
				throw new Error(`[flue] init() has already been called with name "${name}" in this request.`);
			}
			initializedHarnessNames.add(name);

			try {
				const normalizedAgent = normalizeAgentDefinition(options);
				const sandbox = options.sandbox;
				const { env: baseEnv, toolFactory } = await resolveSessionEnv(
					config.id,
					sandbox,
					config,
					options.cwd,
				);
				// Resolve `init({ cwd })` against the sandbox's own cwd so that
				// relative paths target the sandbox/session filesystem, not the
				// agent process cwd or `/`. Mirrors the same pattern used for
				// task sessions in harness.ts.
				const env = options.cwd
					? createCwdSessionEnv(baseEnv, baseEnv.resolvePath(options.cwd))
					: baseEnv;
				const store: SessionStore = options.persist ?? config.defaultStore;
				const sandboxDiscovery = await loadSandboxDiscovery(env, options.loadFromSandbox);
				const workspaceContext = joinWorkspaceContext(sandboxDiscovery.context, options.context);
				const effectiveSkills = mergeDiscoveredSkills(normalizedAgent.skills ?? [], sandboxDiscovery.skills);
				const skills = Object.fromEntries(effectiveSkills.map((skill) => [skill.name, skill]));
				const sandboxSkills = Object.fromEntries(sandboxDiscovery.skills.map((skill) => [skill.name, skill]));
				const subagents = Object.fromEntries(
					(normalizedAgent.subagents ?? []).map((agent) => [agent.name, agent]),
				);
				const agentModel = config.agentConfig.resolveModel(
					options.model === false ? false : (options.model ?? normalizedAgent.model),
				);
				const sandboxAttached = sandbox !== undefined && sandbox !== false;
				const sandboxSkillDiscoveryHint = sandboxAttached && sandboxDiscovery.skillsEnabled === false;
				if (sandboxAttached && sandboxDiscovery.skillsEnabled === false) {
					const conventionalSkills = skillsDirIn(env.cwd);
					if (await env.exists(conventionalSkills)) {
						ctx.log.warn(
							`[flue] Found sandbox skills at ${conventionalSkills}, but init() did not enable loadFromSandbox. Pass loadFromSandbox: true to discover them.`,
						);
					}
				}

				const agentConfig: AgentConfig = {
					...config.agentConfig,
					systemPrompt: composeAgentSystemPrompt(normalizedAgent, { context: workspaceContext, skills: effectiveSkills }),
					workspaceContext,
					skills,
					sandboxSkills,
					sandboxSkillDiscoveryHint,
					subagents,
					model: agentModel,
					thinkingLevel: options.thinkingLevel ?? config.agentConfig.thinkingLevel,
					compaction: options.compaction ?? config.agentConfig.compaction,
				};

				return new Harness(
					config.actionName,
					config.id,
					name,
					agentConfig,
					env,
					store,
					(event) => {
						emitEvent(event);
					},
					[...(normalizedAgent.tools ?? [])],
					toolFactory,
				);
			} catch (error) {
				initializedHarnessNames.delete(name);
				throw error;
			}
		},

		emitEvent,

		subscribeEvent(callback: FlueEventCallback): () => void {
			subscribers.add(callback);
			return () => subscribers.delete(callback);
		},

		setEventCallback(callback: FlueEventCallback | undefined): void {
			handlerUnsubscribe?.();
			handlerUnsubscribe = callback ? ctx.subscribeEvent(callback) : undefined;
		},
	};

	return ctx;
}

function normalizeLogAttributes(
	attributes: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	if (!attributes) return undefined;
	if (!(attributes.error instanceof Error)) return attributes;
	return {
		...attributes,
		error: serializeLogError(attributes.error),
	};
}

function serializeLogError(error: Error): Record<string, unknown> {
	return {
		name: error.name,
		message: error.message,
		stack: error.stack,
	};
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function loadSandboxDiscovery(
	env: SessionEnv,
	option: AgentInit['loadFromSandbox'],
): Promise<{ context: string; skills: SkillDefinition[]; skillsEnabled: boolean }> {
	if (option === true) {
		return {
			context: await readAgentsMd(env, env.cwd),
			skills: await discoverSandboxSkills(env, skillsDirIn(env.cwd)),
			skillsEnabled: true,
		};
	}
	if (!option || typeof option !== 'object') return { context: '', skills: [], skillsEnabled: false };
	if (option.context !== undefined && (typeof option.context !== 'string' || option.context.trim().length === 0)) {
		throw new Error('[flue] loadFromSandbox.context must be a non-empty path string.');
	}
	if (option.skills !== undefined && (typeof option.skills !== 'string' || option.skills.trim().length === 0)) {
		throw new Error('[flue] loadFromSandbox.skills must be a non-empty path string.');
	}
	return {
		context: option.context ? await readSandboxContextFile(env, option.context) : '',
		skills: option.skills ? await discoverSandboxSkills(env, option.skills) : [],
		skillsEnabled: option.skills !== undefined,
	};
}

function mergeDiscoveredSkills(
	declared: readonly SkillDefinition[],
	discovered: readonly SkillDefinition[],
): SkillDefinition[] {
	const merged = [...declared];
	const seen = new Map(declared.map((skill) => [skill.name, skill]));
	for (const skill of discovered) {
		const previous = seen.get(skill.name);
		if (previous) {
			throw new Error(
				`[flue] Skill name "${skill.name}" appears in init() configuration and sandbox discovery. ` +
					`Configured source: ${formatSkillSource(previous)}. Sandbox source: ${formatSkillSource(skill)}.`,
			);
		}
		seen.set(skill.name, skill);
		merged.push(skill);
	}
	return merged;
}

function formatSkillSource(skill: SkillDefinition): string {
	return skill.source.kind === 'sandbox'
		? `${skill.source.cwd}/${skill.source.relativePath}`
		: skill.source.path;
}

function isBashFactory(value: unknown): value is BashFactory {
	return typeof value === 'function';
}

function isSandboxFactory(value: unknown): value is SandboxFactory {
	return (
		typeof value === 'object' &&
		value !== null &&
		'createSessionEnv' in value &&
		typeof (value as any).createSessionEnv === 'function'
	);
}

/** Resolve sandbox option to its session environment and optional tool factory. */
async function resolveSessionEnv(
	id: string,
	sandbox: AgentInit['sandbox'],
	config: FlueContextConfig,
	cwd: string | undefined,
): Promise<{ env: SessionEnv; toolFactory?: SessionToolFactory }> {
	if (sandbox === undefined || sandbox === false) {
		return { env: await config.createDefaultEnv() };
	}
	// JS-caller / `any`-input fallback for the removed `'empty'` and
	// `'local'` magic strings. TS callers get compile errors from the
	// `AgentInit['sandbox']` union. The `as unknown` cast keeps `tsc`
	// from flagging these branches as dead under the narrowed type.
	if ((sandbox as unknown) === 'empty') {
		throw new Error(
			"[flue] init({ sandbox: 'empty' }) is no longer supported because the in-memory sandbox is already the default. " +
				'Write `await init({ model: "provider/model" })` or `await init({ sandbox: false, model: "provider/model" })` instead.',
		);
	}
	if ((sandbox as unknown) === 'local') {
		throw new Error(
			"[flue] init({ sandbox: 'local' }) is no longer supported. " +
				'Write `import { local } from "@flue/runtime/node"; await init({ sandbox: local(), model: "provider/model" })`. ' +
				"Pass `local({ env: { TOKEN: process.env.TOKEN } })` to opt host env vars in.",
		);
	}
	if (isBashFactory(sandbox)) {
		return { env: await bashFactoryToSessionEnv(sandbox) };
	}
	if (isBashLike(sandbox)) {
		throw new Error(
			'[flue] init({ sandbox }) received a Bash-like object, but direct Bash instances are no longer accepted. ' +
				'Write `await init({ sandbox: () => new Bash({ fs }), model: "provider/model" })` so Flue can construct the sandbox per harness.',
		);
	}
	if (config.resolveSandbox) {
		const resolved = await config.resolveSandbox(sandbox);
		if (resolved) return { env: resolved };
	}
	if (isSandboxFactory(sandbox)) {
		const env = await sandbox.createSessionEnv({ id, cwd });
		return { env, toolFactory: sandbox.tools };
	}
	throw new Error('[flue] init({ sandbox }) received an unsupported value. Omit `sandbox`, pass `false`, use `local()` from `@flue/runtime/node`, pass a BashFactory such as `() => new Bash({ fs })`, or pass a connector SandboxFactory installed by `flue add`.');
}
