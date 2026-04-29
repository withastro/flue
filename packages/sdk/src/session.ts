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
import { loadSkillByPath } from './context.ts';
import type {
	AgentConfig,
	Command,
	FlueEvent,
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
	ToolDef,
} from './types.ts';

const MAX_SHELL_HISTORY_CHARS = 50 * 1024;

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

	private harness: Agent;
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
	private agentCommands: Command[];
	private deleted = false;
	private activeOperation: string | undefined;

	constructor(
		id: string,
		private storageKey: string,
		config: AgentConfig,
		env: SessionEnv,
		store: SessionStore,
		existingData: SessionData | null,
		onAgentEvent?: FlueEventCallback,
		agentCommands?: Command[],
		private onDelete?: () => void,
	) {
		this.id = id;
		this.config = config;
		this.env = env;
		this.store = store;
		this.agentCommands = agentCommands ?? [];

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

		const previousMessages = existingData?.messages ?? [];

		this.harness = new Agent({
			initialState: {
				systemPrompt,
				model: config.model,
				tools,
				messages: previousMessages,
			},
			toolExecution: 'parallel',
		});

		this.eventCallback = onAgentEvent;
		this.harness.subscribe(async (event) => {
			switch (event.type) {
				case 'agent_start':
					this.emit({ type: 'agent_start' });
					break;
				case 'message_update': {
					const aEvent = event.assistantMessageEvent;
					if (aEvent.type === 'text_delta') {
						this.emit({ type: 'text_delta', text: aEvent.delta });
					}
					break;
				}
				case 'tool_execution_start':
					this.emit({
						type: 'tool_start',
						toolName: event.toolName,
						toolCallId: event.toolCallId,
						args: event.args,
					});
					break;
				case 'tool_execution_end':
					this.emit({
						type: 'tool_end',
						toolName: event.toolName,
						toolCallId: event.toolCallId,
						isError: event.isError,
						result: event.result,
					});
					break;
				case 'turn_end':
					this.emit({ type: 'turn_end' });
					break;
				case 'agent_end': {
					const messages = this.harness.state.messages;
					const lastMsg = messages[messages.length - 1];
					if (lastMsg?.role === 'assistant') {
						await this.checkCompaction(lastMsg as AssistantMessage);
					}
					this.emit({ type: 'done' });
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
		return this.runExclusive('prompt', async () => {
			this.assertRoleExists(options?.role);
			this.resolveModelForCall(options?.model, options?.role);
			const promptWithRole = this.injectRoleInstructions(text, options?.role);

			const schema = options?.result as v.GenericSchema | undefined;
			const fullPrompt = buildPromptText(promptWithRole, schema);

			const effectiveCommands = this.mergeCommands(options?.commands);
			const customTools = this.createCustomTools(options?.tools ?? []);
			return this.withScopedTools(effectiveCommands, customTools, async () => {
				await this.harness.prompt(fullPrompt);
				await this.harness.waitForIdle();
				this.throwIfError('prompt');
				await this.save();

				if (schema) {
					return this.extractResultWithRetry(schema);
				}
				return { text: this.getAssistantText() };
			});
		});
	}

	async skill<S extends v.GenericSchema>(
		name: string,
		options: SkillOptions<S> & { result: S },
	): Promise<v.InferOutput<S>>;
	async skill(name: string, options?: SkillOptions): Promise<PromptResponse>;
	async skill(name: string, options?: SkillOptions<v.GenericSchema | undefined>): Promise<any> {
		return this.runExclusive('skill', async () => {
			this.assertRoleExists(options?.role);

			let registeredSkill = this.config.skills[name];

			// Fallback: file-path lookup under .agents/skills/. Only attempted when the
			// name looks like a path (contains `/` or ends in `.md`/`.markdown`) so that
			// typos of registered skill names still fail fast with a helpful error.
			if (!registeredSkill && (name.includes('/') || /\.(md|markdown)$/i.test(name))) {
				const loaded = await loadSkillByPath(this.env, this.env.cwd, name);
				if (loaded) registeredSkill = loaded;
			}

			if (!registeredSkill) {
				const available = Object.keys(this.config.skills).join(', ') || '(none)';
				throw new Error(
					`Skill "${name}" not registered. Available: ${available}. ` +
						`Skills can also be referenced by relative path under .agents/skills/ ` +
						`(e.g. "triage/reproduce.md").`,
				);
			}

			this.resolveModelForCall(options?.model, options?.role);

			const schema = options?.result as v.GenericSchema | undefined;
			const skillPrompt = buildSkillPrompt(registeredSkill.instructions, options?.args, schema);
			const promptWithRole = this.injectRoleInstructions(skillPrompt, options?.role);

			const effectiveCommands = this.mergeCommands(options?.commands);
			const customTools = this.createCustomTools(options?.tools ?? []);
			return this.withScopedTools(effectiveCommands, customTools, async () => {
				await this.harness.prompt(promptWithRole);
				await this.harness.waitForIdle();
				this.throwIfError(`skill("${name}")`);
				await this.save();

				if (schema) {
					return this.extractResultWithRetry(schema);
				}
				return { text: this.getAssistantText() };
			});
		});
	}

	async shell(command: string, options?: ShellOptions): Promise<ShellResult> {
		return this.runExclusive('shell', async () => {
			const effectiveCommands = this.mergeCommands(options?.commands);
			const env = await this.createScopedEnv(effectiveCommands);
			const result = await env.exec(command, {
				env: options?.env,
				cwd: options?.cwd,
			});
			const shellResult = { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
			this.recordShellMessage(command, shellResult, options);
			await this.save();
			return shellResult;
		});
	}

	abort(): void {
		this.harness.abort();
		this.compactionAbortController?.abort();
	}

	close(): void {
		if (this.deleted) return;
		this.deleted = true;
		this.abort();
		this.onDelete?.();
	}

	async delete(): Promise<void> {
		if (this.deleted) return;
		this.deleted = true;
		this.abort();
		await this.store.delete(this.storageKey);
		this.onDelete?.();
	}

	/** Precedence: prompt-level > role-level > agent-level default. */
	private resolveModelForCall(promptModel?: string, roleName?: string): void {
		let model: Model<any> | undefined = this.config.model;

		if (roleName && this.config.roles[roleName]?.model && this.config.resolveModel) {
			model = this.config.resolveModel(this.config.roles[roleName].model!);
		}

		if (promptModel && this.config.resolveModel) {
			model = this.config.resolveModel(promptModel);
		}

		this.harness.state.model = this.requireModel(model, 'this prompt()/skill() call');
	}

	/**
	 * Throws a clear, actionable error when no model is configured for a call.
	 * Use with the resolved model (post-precedence) to guarantee we never hand
	 * `undefined` to the underlying agent.
	 */
	private requireModel(model: Model<any> | undefined, callSite: string): Model<any> {
		if (model) return model;
		throw new Error(
			`[flue] No model configured for ${callSite}. ` +
				`Pass \`{ model: "provider/model-id" }\` to \`init()\` for an agent-wide default, ` +
				`or to this prompt()/skill() call for a one-off override.`,
		);
	}

	/**
	 * Throws a clear error when a caller references a role that isn't registered.
	 * Roles are loaded from `.flue/roles/` at build time. Called eagerly at the top
	 * of prompt()/skill() so typos surface before any LLM work begins.
	 */
	private assertRoleExists(roleName: string | undefined): void {
		if (!roleName) return;
		if (this.config.roles[roleName]) return;
		const available = Object.keys(this.config.roles);
		const list = available.length > 0 ? available.join(', ') : '(none defined)';
		throw new Error(
			`[flue] Role "${roleName}" not registered. Available roles: ${list}. ` +
				`Define roles as markdown files under \`.flue/roles/\`.`,
		);
	}

	private injectRoleInstructions(text: string, roleName?: string): string {
		if (!roleName) return text;
		const role = this.config.roles[roleName];
		if (!role) return text;
		return `<role>\n${role.instructions}\n</role>\n\n${text}`;
	}

	// ─── Commands ────────────────────────────────────────────────────────────

	private async createScopedEnv(commands: Command[]): Promise<SessionEnv> {
		return this.scopeEnv(this.env, commands);
	}

	private async scopeEnv(env: SessionEnv, commands: Command[]): Promise<SessionEnv> {
		if (env.scope) return env.scope({ commands });
		if (commands.length > 0) {
			throw new Error(
				'[flue] Cannot use commands: this environment does not support scoped command execution. ' +
					'Commands are only available in BashFactory sandbox mode. ' +
					'Remote sandboxes handle command execution at the platform level.',
			);
		}
		return env;
	}

	/**
	 * Merge agent-wide `commands` (from init()) with per-call commands. When
	 * both define a command with the same name, the per-call entry wins for
	 * that call.
	 */
	private mergeCommands(perCall: Command[] | undefined): Command[] {
		if (!perCall || perCall.length === 0) return this.agentCommands;
		if (this.agentCommands.length === 0) return perCall;
		const byName = new Map<string, Command>();
		for (const cmd of this.agentCommands) byName.set(cmd.name, cmd);
		for (const cmd of perCall) byName.set(cmd.name, cmd);
		return Array.from(byName.values());
	}

	// ─── Custom Tools ───────────────────────────────────────────────────────

	private createCustomTools(tools: ToolDef[]): AgentTool<any>[] {
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

		return tools.map((toolDef) => ({
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
	}

	private async withScopedTools<T>(
		commands: Command[],
		customTools: AgentTool<any>[],
		fn: () => Promise<T>,
	): Promise<T> {
		const scopedEnv = await this.createScopedEnv(commands);
		const previousTools = this.harness.state.tools;
		this.harness.state.tools = [...createTools(scopedEnv), ...customTools];
		try {
			return await fn();
		} finally {
			this.harness.state.tools = previousTools;
		}
	}

	// ─── Internal ────────────────────────────────────────────────────────────

	private async runExclusive<T>(operation: string, fn: () => Promise<T>): Promise<T> {
		this.assertActive();
		if (this.activeOperation) {
			throw new Error(
				`[flue] Session "${this.id}" is already running ${this.activeOperation}. ` +
					'Start another session for parallel conversation branches.',
			);
		}
		this.activeOperation = operation;
		try {
			return await fn();
		} finally {
			this.activeOperation = undefined;
		}
	}

	private emit(event: FlueEvent): void {
		this.eventCallback?.({ ...event, sessionId: this.id });
	}

	private assertActive(): void {
		if (this.deleted) {
			throw new Error(`[flue] Session "${this.id}" has been deleted.`);
		}
	}

	private recordShellMessage(command: string, result: ShellResult, options?: ShellOptions): void {
		const cwdLine = options?.cwd ? `\ncwd: ${options.cwd}` : '';
		const envLine = options?.env
			? `\nenv: ${Object.keys(options.env)
					.sort()
					.join(', ')}`
			: '';
		const output = formatShellHistory(command, result, cwdLine, envLine);
		this.harness.state.messages.push({
			role: 'user',
			content: [{ type: 'text', text: output }],
			timestamp: Date.now(),
		} as AgentMessage);
	}

	private async save(): Promise<void> {
		const now = new Date().toISOString();
		const data: SessionData = {
			messages: this.harness.state.messages as AgentMessage[],
			metadata: this.metadata,
			createdAt: this.createdAt ?? now,
			updatedAt: now,
			lastCompaction: this.lastCompaction,
		};
		if (!this.createdAt) this.createdAt = now;
		await this.store.save(this.storageKey, data);
	}

	// ─── Compaction ───────────────────────────────────────────────────────────

	private async checkCompaction(assistantMessage: AssistantMessage): Promise<void> {
		if (!this.compactionSettings.enabled) return;
		if (assistantMessage.stopReason === 'aborted') return;

		const model = this.harness.state.model;
		const contextWindow = model.contextWindow ?? 0;

		if (isContextOverflow(assistantMessage, contextWindow)) {
			if (this.overflowRecoveryAttempted) return;
			this.overflowRecoveryAttempted = true;

			console.error(`[flue:compaction] Overflow detected, compacting and retrying...`);

			const messages = this.harness.state.messages;
			const lastMsg = messages[messages.length - 1];
			if (lastMsg && lastMsg.role === 'assistant') {
				this.harness.state.messages = messages.slice(0, -1);
			}

			await this.runCompaction('overflow', true);
			return;
		}

		let contextTokens: number;
		if (assistantMessage.stopReason === 'error') {
			const estimate = estimateContextTokens(this.harness.state.messages);
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
		const messagesBefore = this.harness.state.messages.length;

		try {
			const model = this.harness.state.model;
			const messages = this.harness.state.messages as AgentMessage[];

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
			this.emit({ type: 'compaction_start', reason, estimatedTokens });

			const result = await compact(
				preparation,
				model,
				undefined,
				this.compactionAbortController.signal,
			);

			if (this.compactionAbortController.signal.aborted) return;

			const newMessages = buildCompactedMessages(messages, result);
			this.harness.state.messages = newMessages;

			const messagesAfter = newMessages.length;
			console.error(
				`[flue:compaction] Complete — messages: ${messagesBefore} → ${messagesAfter}, ` +
					`tokens before: ${result.tokensBefore}`,
			);

			this.emit({ type: 'compaction_end', messagesBefore, messagesAfter });

			this.lastCompaction = {
				summary: result.summary,
				firstKeptIndex: 1,
				details: result.details,
			};

			await this.save();

			if (willRetry) {
				const msgs = this.harness.state.messages;
				const lastMsg = msgs[msgs.length - 1];
				if (lastMsg?.role === 'assistant' && (lastMsg as AssistantMessage).stopReason === 'error') {
					this.harness.state.messages = msgs.slice(0, -1);
				}
				console.error(`[flue:compaction] Retrying after overflow recovery...`);
				await this.harness.continue();
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			console.error(`[flue:compaction] Failed: ${errorMessage}`);
		} finally {
			this.compactionAbortController = undefined;
		}
	}

	private throwIfError(context: string): void {
		const errorMsg = this.harness.state.errorMessage;
		if (errorMsg) {
			throw new Error(`[flue] ${context} failed: ${errorMsg}`);
		}
	}

	private getAssistantText(): string {
		const messages = this.harness.state.messages;
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
			await this.harness.prompt(followUpPrompt);
			await this.harness.waitForIdle();
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

function formatShellHistory(
	command: string,
	result: ShellResult,
	cwdLine: string,
	envLine: string,
): string {
	const sections = [
		`<shell_command>\n$ ${command}${cwdLine}${envLine}\n</shell_command>`,
		`<shell_result exitCode="${result.exitCode}">`,
	];
	if (result.stdout) sections.push(`<stdout>\n${result.stdout}\n</stdout>`);
	if (result.stderr) sections.push(`<stderr>\n${result.stderr}\n</stderr>`);
	sections.push('</shell_result>');
	return truncateShellHistory(sections.join('\n'));
}

function truncateShellHistory(text: string): string {
	if (text.length <= MAX_SHELL_HISTORY_CHARS) return text;
	const truncated = text.length - MAX_SHELL_HISTORY_CHARS;
	return (
		`[Shell output truncated: ${truncated} leading characters omitted]\n` +
		text.slice(text.length - MAX_SHELL_HISTORY_CHARS)
	);
}
