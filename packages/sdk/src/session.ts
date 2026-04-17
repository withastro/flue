/** Internal session implementation. Not exported publicly — wrapped by FlueSession. */
import { Agent } from '@mariozechner/pi-agent-core';
import type { AgentMessage, AgentTool } from '@mariozechner/pi-agent-core';
import type { AssistantMessage, Model } from '@mariozechner/pi-ai';
import type * as v from 'valibot';
import { BUILTIN_TOOL_NAMES, createTools } from './agent.ts';
import {
	buildCompactedMessages,
	calculateContextTokens,
	compact,
	DEFAULT_COMPACTION_SETTINGS,
	estimateContextTokens,
	isContextOverflow,
	prepareCompaction,
	shouldCompact,
	type CompactionSettings,
} from './compaction.ts';
import {
	buildPromptText,
	buildResultExtractionPrompt,
	buildSkillPrompt,
	extractResult,
	ResultExtractionError,
} from './result.ts';
import { discoverSessionContext } from './context.ts';
import type {
	AgentConfig,
	Command,
	FlueEventCallback,
	FlueSession,
	PromptOptions,
	PromptResponse,
	SessionData,
	SessionEnv,
	SessionStore,
	ShellOptions,
	ShellResult,
	SkillOptions,
	TaskOptions,
	ToolDef,
} from './types.ts';

/** In-memory session store. Sessions persist for the lifetime of the process. */
export class InMemorySessionStore implements SessionStore {
	private store = new Map<string, SessionData>();

	async save(id: string, data: SessionData): Promise<void> {
		this.store.set(id, data);
	}

	async load(id: string): Promise<SessionData | null> {
		return this.store.get(id) ?? null;
	}

	async delete(id: string): Promise<void> {
		this.store.delete(id);
	}
}

export class Session implements FlueSession {
	readonly id: string;
	metadata: Record<string, any>;

	private agent: Agent;
	private config: AgentConfig;
	private env: SessionEnv;
	private store: SessionStore;
	private createdAt: string | undefined;
	private compactionSettings: CompactionSettings;
	private lastCompaction:
		| {
				summary: string;
				firstKeptIndex: number;
				details?: { readFiles: string[]; modifiedFiles: string[] };
		  }
		| undefined;
	private overflowRecoveryAttempted = false;
	private compactionAbortController: AbortController | undefined;
	private eventCallback: FlueEventCallback | undefined;
	private builtinTools: AgentTool<any>[];

	constructor(
		id: string,
		config: AgentConfig,
		env: SessionEnv,
		store: SessionStore,
		existingData: SessionData | null,
		onAgentEvent?: FlueEventCallback,
	) {
		this.id = id;
		this.config = config;
		this.env = env;
		this.store = store;

		this.metadata = existingData?.metadata ?? {};
		this.createdAt = existingData?.createdAt;

		this.lastCompaction = existingData?.lastCompaction;

		const cc = config.compaction;
		this.compactionSettings = {
			enabled: cc?.enabled ?? DEFAULT_COMPACTION_SETTINGS.enabled,
			reserveTokens: cc?.reserveTokens ?? DEFAULT_COMPACTION_SETTINGS.reserveTokens,
			keepRecentTokens: cc?.keepRecentTokens ?? DEFAULT_COMPACTION_SETTINGS.keepRecentTokens,
		};

		const systemPrompt = config.systemPrompt;

		const tools = createTools(env);
		this.builtinTools = tools;

		const previousMessages = existingData?.messages ?? [];

		this.agent = new Agent({
			initialState: {
				systemPrompt,
				model: config.model,
				tools,
				messages: previousMessages,
			},
			toolExecution: 'parallel',
		});

		this.eventCallback = onAgentEvent;
		const emit = onAgentEvent;
		this.agent.subscribe(async (event) => {
			switch (event.type) {
				case 'agent_start':
					emit?.({ type: 'agent_start' });
					break;
				case 'message_update': {
					const aEvent = event.assistantMessageEvent;
					if (aEvent.type === 'text_delta') {
						emit?.({ type: 'text_delta', text: aEvent.delta });
					}
					break;
				}
				case 'tool_execution_start':
					emit?.({
						type: 'tool_start',
						toolName: event.toolName,
						toolCallId: event.toolCallId,
						args: event.args,
					});
					break;
				case 'tool_execution_end':
					emit?.({
						type: 'tool_end',
						toolName: event.toolName,
						toolCallId: event.toolCallId,
						isError: event.isError,
						result: event.result,
					});
					break;
				case 'turn_end':
					emit?.({ type: 'turn_end' });
					break;
				case 'agent_end': {
					const messages = this.agent.state.messages;
					const lastMsg = messages[messages.length - 1];
					if (lastMsg?.role === 'assistant') {
						await this.checkCompaction(lastMsg as AssistantMessage);
					}
					emit?.({ type: 'done' });
					break;
				}
			}
		});
	}

	async prompt<S extends v.GenericSchema>(
		text: string,
		options: PromptOptions<S> & { result: S },
	): Promise<v.InferOutput<S>>;
	async prompt(text: string, options?: PromptOptions): Promise<PromptResponse>;
	async prompt(text: string, options?: PromptOptions<v.GenericSchema | undefined>): Promise<any> {
		this.resolveModelForCall(options?.model, options?.role);
		const promptWithRole = this.injectRoleInstructions(text, options?.role);

		const schema = options?.result as v.GenericSchema | undefined;
		const fullPrompt = buildPromptText(promptWithRole, schema);

		if (options?.commands) {
			this.assertCommandSupport(options.commands);
		}
		const registeredCommandNames = options?.commands ? this.registerCommands(options.commands) : [];
		const registeredToolNames = options?.tools ? this.registerCustomTools(options.tools) : [];
		try {
			await this.agent.prompt(fullPrompt);
			await this.agent.waitForIdle();
			this.throwIfError('prompt');
			await this.save();

			if (schema) {
				return this.extractResultWithRetry(schema);
			}
			return { text: this.getAssistantText() };
		} finally {
			this.unregisterCommands(registeredCommandNames);
			if (registeredToolNames.length > 0) {
				this.unregisterCustomTools();
			}
		}
	}

	async skill<S extends v.GenericSchema>(
		name: string,
		options: SkillOptions<S> & { result: S },
	): Promise<v.InferOutput<S>>;
	async skill(name: string, options?: SkillOptions): Promise<PromptResponse>;
	async skill(name: string, options?: SkillOptions<v.GenericSchema | undefined>): Promise<any> {
		const registeredSkill = this.config.skills[name];
		if (!registeredSkill) {
			throw new Error(
				`Skill "${name}" not registered. Available: ${Object.keys(this.config.skills).join(', ') || '(none)'}`,
			);
		}

		this.resolveModelForCall(options?.model, options?.role);

		const schema = options?.result as v.GenericSchema | undefined;
		const skillPrompt = buildSkillPrompt(registeredSkill.instructions, options?.args, schema);
		const promptWithRole = this.injectRoleInstructions(skillPrompt, options?.role);

		if (options?.commands) {
			this.assertCommandSupport(options.commands);
		}
		const registeredCommandNames = options?.commands ? this.registerCommands(options.commands) : [];
		const registeredToolNames = options?.tools ? this.registerCustomTools(options.tools) : [];
		try {
			await this.agent.prompt(promptWithRole);
			await this.agent.waitForIdle();
			this.throwIfError(`skill("${name}")`);
			await this.save();

			if (schema) {
				return this.extractResultWithRetry(schema);
			}
			return { text: this.getAssistantText() };
		} finally {
			this.unregisterCommands(registeredCommandNames);
			if (registeredToolNames.length > 0) {
				this.unregisterCustomTools();
			}
		}
	}

	async shell(command: string, options?: ShellOptions): Promise<ShellResult> {
		if (options?.commands) {
			this.assertCommandSupport(options.commands);
		}
		const registeredNames = options?.commands ? this.registerCommands(options.commands) : [];
		try {
			const result = await this.env.exec(command, {
				env: options?.env,
				cwd: options?.cwd,
			});
			return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
		} finally {
			this.unregisterCommands(registeredNames);
		}
	}

	async task<S extends v.GenericSchema>(
		prompt: string,
		options: TaskOptions<S> & { result: S },
	): Promise<v.InferOutput<S>>;
	async task(prompt: string, options?: TaskOptions): Promise<PromptResponse>;
	async task(prompt: string, options?: TaskOptions<v.GenericSchema | undefined>): Promise<any> {
		if (!options?.workspace) {
			throw new Error('[flue] task() requires a workspace option.');
		}

		const taskCwd = options.workspace.startsWith('/')
			? options.workspace
			: normalizePath(this.env.cwd + '/' + options.workspace);

		function taskResolvePath(p: string): string {
			if (p.startsWith('/')) return normalizePath(p);
			if (taskCwd === '/') return normalizePath('/' + p);
			return normalizePath(taskCwd + '/' + p);
		}

		const parentEnv = this.env;
		const taskEnv: SessionEnv = {
			exec: (cmd, opts) => parentEnv.exec(cmd, { cwd: opts?.cwd ?? taskCwd, env: opts?.env }),
			readFile: (p) => parentEnv.readFile(taskResolvePath(p)),
			readFileBuffer: (p) => parentEnv.readFileBuffer(taskResolvePath(p)),
			writeFile: (p, c) => parentEnv.writeFile(taskResolvePath(p), c),
			stat: (p) => parentEnv.stat(taskResolvePath(p)),
			readdir: (p) => parentEnv.readdir(taskResolvePath(p)),
			exists: (p) => parentEnv.exists(taskResolvePath(p)),
			mkdir: (p, o) => parentEnv.mkdir(taskResolvePath(p), o),
			rm: (p, o) => parentEnv.rm(taskResolvePath(p), o),
			cwd: taskCwd,
			resolvePath: taskResolvePath,
			commandSupport: parentEnv.commandSupport,
			cleanup: async () => {},
		};

		const localContext = await discoverSessionContext(taskEnv);

		let taskModel = this.config.model;
		const taskRole = options?.role ? this.config.roles[options.role] : undefined;
		if (taskRole?.model && this.config.resolveModel) {
			taskModel = this.config.resolveModel(taskRole.model);
		}
		if (options?.model && this.config.resolveModel) {
			taskModel = this.config.resolveModel(options.model);
		}

		const taskConfig: AgentConfig = {
			systemPrompt: localContext.systemPrompt,
			skills: localContext.skills,
			roles: this.config.roles,
			model: taskModel,
			resolveModel: this.config.resolveModel,
			compaction: this.config.compaction,
		};

		this.eventCallback?.({ type: 'task_start', workspace: taskCwd });

		const taskStore = new InMemorySessionStore();
		const taskSession = new Session(
			`${this.id}:task:${Date.now()}`,
			taskConfig,
			taskEnv,
			taskStore,
			null,
			this.eventCallback,
		);

		try {
			const promptOpts: PromptOptions<any> = { role: options?.role };
			if (options?.result) promptOpts.result = options.result;
			return await taskSession.prompt(prompt, promptOpts);
		} finally {
			this.eventCallback?.({ type: 'task_end' });
			await taskSession.destroy();
		}
	}

	abort(): void {
		this.agent.abort();
	}

	async destroy(): Promise<void> {
		this.agent.abort();
		await this.store.delete(this.id);
		await this.env.cleanup();
	}

	/** Precedence: prompt-level > role-level > agent-level default. */
	private resolveModelForCall(promptModel?: string, roleName?: string): void {
		let model: Model<any> = this.config.model;

		if (roleName && this.config.roles[roleName]?.model && this.config.resolveModel) {
			model = this.config.resolveModel(this.config.roles[roleName].model!);
		}

		if (promptModel && this.config.resolveModel) {
			model = this.config.resolveModel(promptModel);
		}

		this.agent.state.model = model;
	}

	private injectRoleInstructions(text: string, roleName?: string): string {
		if (!roleName) return text;
		const role = this.config.roles[roleName];
		if (!role) return text;
		return `<role>\n${role.instructions}\n</role>\n\n${text}`;
	}

	// ─── Commands ────────────────────────────────────────────────────────────

	private assertCommandSupport(commands: Command[]): void {
		if (commands.length === 0) return;
		if (!this.env.commandSupport) {
			throw new Error(
				'[flue] Cannot use commands: this environment does not support command registration. ' +
					'Commands are only available in isolate sandbox mode. ' +
					'Remote sandboxes handle command execution at the platform level.',
			);
		}
	}

	private registerCommands(commands: Command[]): string[] {
		if (!this.env.commandSupport || commands.length === 0) return [];

		const names: string[] = [];
		for (const cmd of commands) {
			this.env.commandSupport.register(cmd);
			names.push(cmd.name);
		}
		return names;
	}

	private unregisterCommands(names: string[]): void {
		if (!this.env.commandSupport || names.length === 0) return;
		for (const name of names) {
			this.env.commandSupport.unregister(name);
		}
	}

	// ─── Custom Tools ───────────────────────────────────────────────────────

	private registerCustomTools(tools: ToolDef[]): string[] {
		const names: string[] = [];

		for (const toolDef of tools) {
			if (BUILTIN_TOOL_NAMES.has(toolDef.name)) {
				throw new Error(
					`[flue] Custom tool "${toolDef.name}" conflicts with a built-in tool. ` +
						`Built-in tools: ${[...BUILTIN_TOOL_NAMES].join(', ')}`,
				);
			}
			if (names.includes(toolDef.name)) {
				throw new Error(
					`[flue] Duplicate custom tool name "${toolDef.name}". Tool names must be unique.`,
				);
			}
			names.push(toolDef.name);
		}

		const agentTools: AgentTool<any>[] = tools.map((toolDef) => ({
			name: toolDef.name,
			label: toolDef.name,
			description: toolDef.description,
			parameters: toolDef.parameters,
			async execute(_toolCallId: string, params: Record<string, any>, signal?: AbortSignal) {
				if (signal?.aborted) throw new Error('Operation aborted');
				const resultText = await toolDef.execute(params);
				return {
					content: [{ type: 'text' as const, text: resultText }],
					details: { customTool: toolDef.name },
				};
			},
		}));

		this.agent.state.tools = [...this.agent.state.tools, ...agentTools];
		return names;
	}

	private unregisterCustomTools(): void {
		this.agent.state.tools = [...this.builtinTools];
	}

	// ─── Internal ────────────────────────────────────────────────────────────

	private async save(): Promise<void> {
		const now = new Date().toISOString();
		const data: SessionData = {
			messages: this.agent.state.messages as AgentMessage[],
			metadata: this.metadata,
			createdAt: this.createdAt ?? now,
			updatedAt: now,
			lastCompaction: this.lastCompaction,
		};
		if (!this.createdAt) this.createdAt = now;
		await this.store.save(this.id, data);
	}

	// ─── Compaction ───────────────────────────────────────────────────────────

	private async checkCompaction(assistantMessage: AssistantMessage): Promise<void> {
		if (!this.compactionSettings.enabled) return;
		if (assistantMessage.stopReason === 'aborted') return;

		const model = this.agent.state.model;
		const contextWindow = model.contextWindow ?? 0;

		if (isContextOverflow(assistantMessage, contextWindow)) {
			if (this.overflowRecoveryAttempted) return;
			this.overflowRecoveryAttempted = true;

			console.error(`[flue:compaction] Overflow detected, compacting and retrying...`);

			const messages = this.agent.state.messages;
			const lastMsg = messages[messages.length - 1];
			if (lastMsg && lastMsg.role === 'assistant') {
				this.agent.state.messages = messages.slice(0, -1);
			}

			await this.runCompaction('overflow', true);
			return;
		}

		let contextTokens: number;
		if (assistantMessage.stopReason === 'error') {
			const estimate = estimateContextTokens(this.agent.state.messages);
			if (estimate.lastUsageIndex === null) return;
			contextTokens = estimate.tokens;
		} else {
			contextTokens = calculateContextTokens(assistantMessage.usage);
		}

		if (shouldCompact(contextTokens, contextWindow, this.compactionSettings)) {
			console.error(
				`[flue:compaction] Threshold reached — ${contextTokens} tokens used, ` +
					`window ${contextWindow}, reserve ${this.compactionSettings.reserveTokens}, ` +
					`triggering compaction`,
			);
			await this.runCompaction('threshold', false);
		}
	}

	private async runCompaction(reason: 'threshold' | 'overflow', willRetry: boolean): Promise<void> {
		this.compactionAbortController = new AbortController();
		const messagesBefore = this.agent.state.messages.length;

		try {
			const model = this.agent.state.model;
			const messages = this.agent.state.messages as AgentMessage[];

			const preparation = prepareCompaction(messages, this.compactionSettings, this.lastCompaction);
			if (!preparation) {
				console.error(`[flue:compaction] Nothing to compact (no valid cut point found)`);
				return;
			}

			console.error(
				`[flue:compaction] Summarizing ${preparation.messagesToSummarize.length} messages` +
					(preparation.isSplitTurn
						? ` (split turn: ${preparation.turnPrefixMessages.length} prefix messages)`
						: '') +
					`, keeping messages from index ${preparation.firstKeptIndex}`,
			);

			const estimatedTokens = preparation.tokensBefore;
			this.eventCallback?.({ type: 'compaction_start', reason, estimatedTokens });

			const result = await compact(
				preparation,
				model,
				undefined,
				this.compactionAbortController.signal,
			);

			if (this.compactionAbortController.signal.aborted) return;

			const newMessages = buildCompactedMessages(messages, result);
			this.agent.state.messages = newMessages;

			const messagesAfter = newMessages.length;
			console.error(
				`[flue:compaction] Complete — messages: ${messagesBefore} → ${messagesAfter}, ` +
					`tokens before: ${result.tokensBefore}`,
			);

			this.eventCallback?.({ type: 'compaction_end', messagesBefore, messagesAfter });

			this.lastCompaction = {
				summary: result.summary,
				firstKeptIndex: 1,
				details: result.details,
			};

			await this.save();

			if (willRetry) {
				const msgs = this.agent.state.messages;
				const lastMsg = msgs[msgs.length - 1];
				if (lastMsg?.role === 'assistant' && (lastMsg as AssistantMessage).stopReason === 'error') {
					this.agent.state.messages = msgs.slice(0, -1);
				}
				console.error(`[flue:compaction] Retrying after overflow recovery...`);
				await this.agent.continue();
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			console.error(`[flue:compaction] Failed: ${errorMessage}`);
		} finally {
			this.compactionAbortController = undefined;
		}
	}

	private throwIfError(context: string): void {
		const errorMsg = this.agent.state.errorMessage;
		if (errorMsg) {
			throw new Error(`[flue] ${context} failed: ${errorMsg}`);
		}
	}

	private getAssistantText(): string {
		const messages = this.agent.state.messages;
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i]!;
			if (msg.role !== 'assistant') continue;
			const content = (msg as AssistantMessage).content;
			if (!Array.isArray(content)) continue;
			const textParts: string[] = [];
			for (const block of content) {
				if (block.type === 'text') {
					textParts.push(block.text);
				}
			}
			return textParts.join('\n');
		}
		return '';
	}

	private async extractResultWithRetry<S extends v.GenericSchema>(
		schema: S,
	): Promise<v.InferOutput<S>> {
		const text = this.getAssistantText();
		try {
			return extractResult(text, schema);
		} catch (err) {
			if (!(err instanceof ResultExtractionError)) throw err;
			if (!err.message.includes('RESULT_START')) throw err;

			const followUpPrompt = buildResultExtractionPrompt(schema);
			await this.agent.prompt(followUpPrompt);
			await this.agent.waitForIdle();
			await this.save();

			const retryText = this.getAssistantText();
			return extractResult(retryText, schema);
		}
	}
}

// ─── Helpers ────────────────────────────────────────────────────────────────

export function normalizePath(p: string): string {
	const parts = p.split('/');
	const result: string[] = [];
	for (const part of parts) {
		if (part === '.' || part === '') continue;
		if (part === '..') {
			result.pop();
		} else {
			result.push(part);
		}
	}
	return '/' + result.join('/');
}
