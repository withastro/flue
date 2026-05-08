import { discoverSessionContext } from './context.ts';
import { bashFactoryToSessionEnv, createCwdSessionEnv } from './sandbox.ts';
import { AgentClient } from './agent-client.ts';
import { assertRoleExists } from './roles.ts';
import type {
	AgentConfig,
	AgentInit,
	BashFactory,
	BashLike,
	FlueContext,
	FlueEventCallback,
	FlueAgent,
	ProvidersConfig,
	SandboxFactory,
	SessionEnv,
	SessionStore,
} from './types.ts';

export interface FlueContextConfig {
	id: string;
	payload: any;
	env: Record<string, any>;
	agentConfig: AgentConfig;
	createDefaultEnv: () => Promise<SessionEnv>;
	createLocalEnv: () => Promise<SessionEnv>;
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
	setEventCallback(callback: FlueEventCallback | undefined): void;
}

export function createFlueContext(config: FlueContextConfig): FlueContextInternal {
	let currentEventCallback: FlueEventCallback | undefined;
	const initializedAgentIds = new Set<string>();

	const ctx: FlueContextInternal = {
		get id() {
			return config.id;
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

		async init(options?: AgentInit): Promise<FlueAgent> {
			if (!options || !('model' in options)) {
				throw new Error(
					'[flue] init() requires a model. Pass { model: "provider/model-id" } or { model: false }.',
				);
			}
			if (options.model !== false && typeof options.model !== 'string') {
				throw new Error('[flue] init({ model }) must be a model string or false.');
			}

			const id = options.id ?? config.id;
			if (initializedAgentIds.has(id)) {
				throw new Error(`[flue] init() has already been called for agent "${id}" in this request.`);
			}
			initializedAgentIds.add(id);

			try {
				assertRoleExists(config.agentConfig.roles, options.role);
				const sandbox = options.sandbox;
				const baseEnv = await resolveSessionEnv(id, sandbox, config, options.cwd);
				const env = options.cwd ? createCwdSessionEnv(baseEnv, options.cwd) : baseEnv;
				const store: SessionStore = options.persist ?? config.defaultStore;
				const localContext = await discoverSessionContext(env);
				const providers = mergeProvidersConfig(config.agentConfig.providers, options.providers);

				// Agent-level model override. Per-call `model` on prompt()/skill() still wins
				// because resolveModelForCall() applies it on top of this default.
				const agentModel = config.agentConfig.resolveModel(options.model, providers);

				const agentConfig: AgentConfig = {
					...config.agentConfig,
					systemPrompt: localContext.systemPrompt,
					skills: localContext.skills,
					model: agentModel,
					role: options.role ?? config.agentConfig.role,
					providers,
					thinkingLevel: options.thinkingLevel ?? config.agentConfig.thinkingLevel,
				};

				return new AgentClient(
					id,
					agentConfig,
					env,
					store,
					currentEventCallback,
					options.commands,
					options.tools,
				);
			} catch (error) {
				initializedAgentIds.delete(id);
				throw error;
			}
		},

		setEventCallback(callback: FlueEventCallback | undefined): void {
			currentEventCallback = callback;
		},
	};

	return ctx;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Duck-type detection for just-bash Bash instances. */
function isBashLike(value: unknown): value is BashLike {
	return (
		typeof value === 'object' &&
		value !== null &&
		'exec' in value &&
		'getCwd' in value &&
		'fs' in value &&
		typeof (value as any).exec === 'function' &&
		typeof (value as any).getCwd === 'function' &&
		typeof (value as any).fs === 'object'
	);
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

/** Resolve sandbox option to SessionEnv: empty → local → BashFactory → platform hook → SandboxFactory. */
async function resolveSessionEnv(
	id: string,
	sandbox: AgentInit['sandbox'],
	config: FlueContextConfig,
	cwd: string | undefined,
): Promise<SessionEnv> {
	if (sandbox === undefined || sandbox === 'empty') {
		return config.createDefaultEnv();
	}
	if (sandbox === 'local') {
		return config.createLocalEnv();
	}
	if (isBashFactory(sandbox)) {
		return bashFactoryToSessionEnv(sandbox);
	}
	if (isBashLike(sandbox)) {
		throw new Error(
			'[flue] init({ sandbox }) no longer accepts a Bash-like object directly. ' +
				'Pass a BashFactory instead, e.g. `sandbox: () => new Bash({ fs })`.',
		);
	}
	if (config.resolveSandbox) {
		const resolved = await config.resolveSandbox(sandbox);
		if (resolved) return resolved;
	}
	if (isSandboxFactory(sandbox)) {
		return sandbox.createSessionEnv({ id, cwd });
	}
	throw new Error('[flue] Invalid sandbox option passed to init().');
}

function mergeProvidersConfig(
	base: ProvidersConfig | undefined,
	settings: ProvidersConfig | undefined,
): ProvidersConfig | undefined {
	if (!base) return settings;
	if (!settings) return base;

	const merged: ProvidersConfig = { ...base };
	for (const [provider, config] of Object.entries(settings)) {
		const previous = merged[provider];
		merged[provider] = {
			...previous,
			...config,
			headers:
				previous?.headers || config.headers
					? { ...(previous?.headers ?? {}), ...(config.headers ?? {}) }
					: undefined,
		};
	}
	return merged;
}

// ─── @flue/sdk/client public API ────────────────────────────────────────────

export { Type } from '@mariozechner/pi-ai';
export { connectMcpServer } from './mcp.ts';

export type { McpServerConnection, McpServerOptions, McpTransport } from './mcp.ts';

export type {
	FlueContext,
	FlueAgent,
	FlueSessions,
	FlueSession,
	AgentInit,
	ModelConfig,
	FlueEvent,
	FlueEventCallback,
	SessionData,
	SessionStore,
	Command,
	FileStat,
	SandboxFactory,
	BashFactory,
	BashLike,
	SessionEnv,
	SessionOptions,
	ProviderSettings,
	ProvidersConfig,
	PromptOptions,
	PromptResponse,
	PromptResultResponse,
	PromptUsage,
	PromptModel,
	SkillOptions,
	TaskOptions,
	ShellOptions,
	ShellResult,
	ToolDef,
	ToolParameters,
	ThinkingLevel,
} from './types.ts';
