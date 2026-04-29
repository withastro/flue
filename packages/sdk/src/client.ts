import { discoverSessionContext } from './context.ts';
import { bashFactoryToSessionEnv, createCwdSessionEnv } from './sandbox.ts';
import { AgentClient } from './agent-client.ts';
import type {
	AgentConfig,
	AgentInit,
	BashFactory,
	BashLike,
	FlueContext,
	FlueEventCallback,
	FlueAgent,
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

		async init(options?: AgentInit): Promise<FlueAgent> {
			const id = options?.id ?? config.id;
			if (initializedAgentIds.has(id)) {
				throw new Error(`[flue] init() has already been called for agent "${id}" in this request.`);
			}
			initializedAgentIds.add(id);

			try {
				const sandbox = options?.sandbox;
				const baseEnv = await resolveSessionEnv(id, sandbox, config, options?.cwd);
				const env = options?.cwd ? createCwdSessionEnv(baseEnv, options.cwd) : baseEnv;
				const store: SessionStore = options?.persist ?? config.defaultStore;
				const localContext = await discoverSessionContext(env);

				// Agent-level model override. Per-call `model` on prompt()/skill() still wins
				// because resolveModelForCall() applies it on top of this default.
				const agentModel =
					options?.model && config.agentConfig.resolveModel
						? config.agentConfig.resolveModel(options.model)
						: config.agentConfig.model;

				const agentConfig: AgentConfig = {
					...config.agentConfig,
					systemPrompt: localContext.systemPrompt,
					skills: localContext.skills,
					model: agentModel,
				};

				return new AgentClient(
					id,
					agentConfig,
					env,
					store,
					currentEventCallback,
					options?.commands,
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

// ─── @flue/sdk/client public API ────────────────────────────────────────────

export { Type } from '@mariozechner/pi-ai';

export type {
	FlueContext,
	FlueAgent,
	FlueSessions,
	FlueSession,
	AgentInit,
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
	PromptOptions,
	PromptResponse,
	SkillOptions,
	ShellOptions,
	ShellResult,
	ToolDef,
} from './types.ts';
