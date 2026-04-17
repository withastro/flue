import { discoverSessionContext } from './context.ts';
import { bashToSessionEnv } from './sandbox.ts';
import { Session } from './session.ts';
import type {
	AgentConfig,
	BashLike,
	Command,
	FlueContext,
	FlueEventCallback,
	FlueSession,
	PromptOptions,
	PromptResponse,
	SandboxFactory,
	SessionEnv,
	SessionInit,
	SessionStore,
	ShellOptions,
	ShellResult,
	SkillOptions,
	TaskOptions,
} from './types.ts';

export interface FlueContextConfig {
	sessionId: string;
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
	let initialized = false;
	let currentEventCallback: FlueEventCallback | undefined;

	const ctx: FlueContextInternal = {
		get sessionId() {
			return config.sessionId;
		},

		get payload() {
			return config.payload;
		},

		get env() {
			return config.env;
		},

		async init(options?: SessionInit): Promise<FlueSession> {
			if (initialized) {
				throw new Error('[flue] init() can only be called once per request.');
			}
			initialized = true;

			const sandbox = options?.sandbox;
			const env = await resolveSessionEnv(config.sessionId, sandbox, config);
			const store: SessionStore = options?.persist ?? config.defaultStore;
			const savedData = await store.load(config.sessionId);
			const localContext = await discoverSessionContext(env);

			const sessionConfig: AgentConfig = {
				...config.agentConfig,
				systemPrompt: localContext.systemPrompt,
				skills: localContext.skills,
			};

			return new Session(
				config.sessionId,
				sessionConfig,
				env,
				store,
				savedData,
				currentEventCallback,
			);
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

/** Resolve sandbox option to SessionEnv: empty → local → BashLike → platform hook → SandboxFactory. */
async function resolveSessionEnv(
	sessionId: string,
	sandbox: SessionInit['sandbox'],
	config: FlueContextConfig,
): Promise<SessionEnv> {
	if (sandbox === undefined || sandbox === 'empty') {
		return config.createDefaultEnv();
	}
	if (sandbox === 'local') {
		return config.createLocalEnv();
	}
	if (isBashLike(sandbox)) {
		return bashToSessionEnv(sandbox);
	}
	if (config.resolveSandbox) {
		const resolved = await config.resolveSandbox(sandbox);
		if (resolved) return resolved;
	}
	return (sandbox as SandboxFactory).createSessionEnv({ sessionId });
}

// ─── @flue/sdk/client public API ────────────────────────────────────────────

export { Type } from '@mariozechner/pi-ai';

export type {
	FlueContext,
	FlueSession,
	SessionInit,
	FlueEvent,
	FlueEventCallback,
	SessionData,
	SessionStore,
	Command,
	CommandSupport,
	FileStat,
	SandboxFactory,
	BashLike,
	SessionEnv,
	PromptOptions,
	PromptResponse,
	SkillOptions,
	ShellOptions,
	ShellResult,
	TaskOptions,
	ToolDef,
} from './types.ts';

export function defineCommand(
	name: string,
	execute: (args: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>,
): Command {
	return { name, execute };
}
