import type * as v from 'valibot';
import type { ProxyService } from './proxies/types.ts';

export interface FlueClientOptions {
	/** OpenCode server URL (default: 'http://localhost:48765'). */
	opencodeUrl?: string;
	/** Working directory (the repo root). */
	workdir: string;
	/** Proxy configs — instructions are extracted and appended to every skill/prompt call. */
	proxies?: ProxyService[];
	/** Default model for skill/prompt invocations. */
	model?: { providerID: string; modelID: string };
	/** Fetch implementation for reaching the OpenCode server. */
	fetch: (request: Request) => Promise<Response>;
	/** Shell implementation for executing commands in the target environment. */
	shell: (command: string, options?: ShellOptions) => Promise<ShellResult>;
	/** Enable verbose debug logging (default: false). */
	debug?: boolean;
}

export interface SkillOptions<S extends v.GenericSchema | undefined = undefined> {
	/** Key-value args serialized into the prompt. */
	args?: Record<string, unknown>;
	/** Valibot schema for structured result extraction. */
	result?: S;
	/** Override model for this skill. */
	model?: { providerID: string; modelID: string };
	/** Max time to wait for the skill to complete (ms). Defaults to 60 minutes. */
	timeout?: number;
}

export interface PromptOptions<S extends v.GenericSchema | undefined = undefined> {
	/** Valibot schema for structured result extraction. */
	result?: S;
	/** Override agent for this prompt. */
	agent?: string;
	/** Override model for this prompt. */
	model?: { providerID: string; modelID: string };
	/** Max time to wait for the prompt to complete (ms). Defaults to 60 minutes. */
	timeout?: number;
}

export interface ShellOptions {
	/** Environment variables scoped to this subprocess only. */
	env?: Record<string, string>;
	/** Text to pipe to the command's stdin. */
	stdin?: string;
	/** Working directory (default: Flue's workdir). */
	cwd?: string;
	/** Timeout in milliseconds. */
	timeout?: number;
}

export interface ShellResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}
