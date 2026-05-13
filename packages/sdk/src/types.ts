export type Json = unknown;

export interface FlueContext {
	id: string;
	runId: string;
	payload: unknown;
	env: Record<string, unknown>;
	req?: Request;
	log: {
		info(message: string, attributes?: Record<string, unknown>): void;
		warn(message: string, attributes?: Record<string, unknown>): void;
		error(message: string, attributes?: Record<string, unknown>): void;
	};
	init(options?: AgentInit): Promise<FlueHarness>;
}

export interface FlueHarness {
	name: string;
	readonly fs: FlueFs;
	session(name?: string, options?: SessionOptions): FlueSession;
}

export interface FlueSessions {
	session(name?: string, options?: SessionOptions): FlueSession;
}

export interface FlueSession {
	readonly fs: FlueFs;
	prompt(prompt: string, options?: PromptOptions): Promise<PromptResponse>;
	skill(name: string, input?: string, options?: SkillOptions): Promise<PromptResponse>;
	task(prompt: string, options?: TaskOptions): Promise<PromptResponse>;
	shell(command: string, options?: ShellOptions): Promise<ShellResult>;
}

export interface FlueFs {
	readFile(path: string): Promise<Uint8Array>;
	writeFile(path: string, data: string | Uint8Array): Promise<void>;
	readdir(path: string): Promise<string[]>;
	mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
	rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
	stat(path: string): Promise<FileStat>;
	exists(path: string): Promise<boolean>;
}

export interface AgentInit {
	name?: string;
	model?: ModelConfig;
	role?: string;
	sandbox?: unknown;
	cwd?: string;
	persist?: SessionStore;
	tools?: ToolDef[];
	thinkingLevel?: ThinkingLevel;
}

export type FlueEvent = Record<string, unknown> & { type: string };
export type FlueEventCallback = (event: FlueEvent) => void | Promise<void>;

export interface SessionData {
	messages?: unknown[];
	[key: string]: unknown;
}

export interface SessionStore {
	get(id: string): Promise<SessionData | undefined>;
	set(id: string, data: SessionData): Promise<void>;
}

export interface SessionEnv {
	cwd?: string;
	resolvePath?(path: string): string;
	fs?: unknown;
	exec(command: string, options?: { timeout?: number; signal?: AbortSignal }): Promise<ShellResult>;
}

export interface FileStat {
	type?: 'file' | 'directory' | 'symlink' | 'other';
	size?: number;
	mtime?: number | Date;
	isFile?: boolean;
	isDirectory?: boolean;
	isSymbolicLink?: boolean;
}

export interface SandboxFactory {
	createSessionEnv(options: { id: string; cwd?: string }): Promise<SessionEnv>;
}

export type BashFactory = () => BashLike;

export interface BashLike {
	exec(command: string, options?: unknown): Promise<ShellResult>;
	getCwd(): string;
	fs: unknown;
}

export interface SessionOptions {
	cwd?: string;
	parentEnv?: SessionEnv;
}

export interface PromptOptions {
	model?: PromptModel;
	tools?: ToolDef[];
	signal?: AbortSignal;
	thinkingLevel?: ThinkingLevel;
}

export interface SkillOptions extends PromptOptions {}
export interface TaskOptions extends PromptOptions {}

export interface CallHandle<T = unknown> extends Promise<T> {}

export interface PromptResponse {
	text?: string;
	result?: unknown;
	usage?: PromptUsage;
}

export interface PromptResultResponse<T = unknown> extends PromptResponse {
	result: T;
}

export interface PromptUsage {
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
	cost?: number;
}

export type PromptModel = string;

export interface ShellOptions {
	timeout?: number;
	signal?: AbortSignal;
}

export interface ShellResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export interface Skill {
	name: string;
	description: string;
}

export interface Role {
	name: string;
	prompt?: string;
	model?: ModelConfig;
	thinkingLevel?: ThinkingLevel;
}

export interface AgentConfig {
	systemPrompt?: string;
	model?: ModelConfig;
	role?: Role | string;
	roles?: Record<string, Role>;
	tools?: ToolDef[];
	thinkingLevel?: ThinkingLevel;
}

export type ModelConfig = string | false;

export interface BuildOptions {
	root: string;
	output?: string;
	target?: 'node' | 'cloudflare';
	plugin?: BuildPlugin;
}

export interface DevOptions {
	root: string;
	output?: string;
	target: 'node' | 'cloudflare';
	port?: number;
	envFiles?: string[];
}

export interface BuildPlugin {
	name: string;
	bundle?: 'esbuild' | 'none';
	entryFilename?: string;
	generateEntryPoint(ctx: BuildContext): string | Promise<string>;
	esbuildOptions?(ctx: BuildContext): Record<string, unknown>;
	additionalOutputs?(ctx: BuildContext): Record<string, string> | Promise<Record<string, string>>;
}

export interface BuildContext {
	agents: AgentInfo[];
	roles: Record<string, Role>;
	root: string;
	output: string;
	appEntry?: string;
	options: BuildOptions;
}

export interface AgentInfo {
	name: string;
	filePath: string;
	triggers: { webhook?: boolean };
}

export interface ToolDef<TParams = unknown> {
	name: string;
	description?: string;
	parameters?: TParams;
	execute?: (params: unknown) => unknown | Promise<unknown>;
}

export type ToolParameters = unknown;
export type ThinkingLevel = string;
export interface ProviderSettings {
	baseUrl?: string;
	apiKey?: string;
	headers?: Record<string, string>;
	storeResponses?: boolean;
}
