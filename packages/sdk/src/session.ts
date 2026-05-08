/** Internal session implementation. Not exported publicly — wrapped by FlueSession. */
import { Agent } from '@mariozechner/pi-agent-core';
import type { AgentMessage, AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type { AssistantMessage, Model } from '@mariozechner/pi-ai';
import type * as v from 'valibot';
import {
	BUILTIN_TOOL_NAMES,
	createTools,
	type TaskToolParams,
	type TaskToolResultDetails,
} from './agent.ts';
import {
	calculateContextTokens,
	compact,
	DEFAULT_COMPACTION_SETTINGS,
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
import { addUsage, emptyUsage, fromProviderUsage } from './usage.ts';
import { loadSkillByPath } from './context.ts';
import { createScopedEnv as scopeSessionEnv, mergeCommands } from './env-utils.ts';
import {
	assertRoleExists,
	resolveEffectiveRole as resolveEffectiveRoleName,
	resolveRoleModel,
} from './roles.ts';
import { SessionHistory, type ContextEntry, type MessageSource } from './session-history.ts';
import type {
	AgentConfig,
	Command,
	FlueEvent,
	FlueEventCallback,
	FlueSession,
	PromptModel,
	PromptOptions,
	PromptResponse,
	PromptResultResponse,
	PromptUsage,
	SessionData,
	SessionEnv,
	SessionStore,
	ShellOptions,
	ShellResult,
	SkillOptions,
	TaskOptions,
	ToolDef,
} from './types.ts';

const MAX_SHELL_HISTORY_CHARS = 50 * 1024;
const MAX_TASK_DEPTH = 4;

export interface CreateTaskSessionOptions {
	parentSessionId: string;
	taskId: string;
	parentEnv: SessionEnv;
	cwd?: string;
	role?: string;
	commands: Command[];
	depth: number;
}

export type CreateTaskSession = (options: CreateTaskSessionOptions) => Promise<Session>;

interface SessionInitOptions {
	id: string;
	storageKey: string;
	config: AgentConfig;
	env: SessionEnv;
	store: SessionStore;
	existingData: SessionData | null;
	onAgentEvent?: FlueEventCallback;
	agentCommands?: Command[];
	agentTools?: ToolDef[];
	sessionRole?: string;
	taskDepth?: number;
	createTaskSession?: CreateTaskSession;
	onDelete?: () => void;
}

interface RuntimeScopeOptions {
	commands: Command[];
	tools: ToolDef[];
	role?: string;
	model?: string;
	callSite: string;
}

interface InternalTaskResult<T> {
	output: T;
	text: string;
	taskId: string;
	sessionId: string;
	messageId?: string;
	role?: string;
	cwd?: string;
}

interface InternalTaskOptions<S extends v.GenericSchema | undefined> extends TaskOptions<S> {
	inheritedModel?: string;
}

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
	get role(): string | undefined {
		return this.sessionRole;
	}

	private harness: Agent;
	private storageKey: string;
	private config: AgentConfig;
	private env: SessionEnv;
	private store: SessionStore;
	private history: SessionHistory;
	private createdAt: string | undefined;
	private compactionSettings: CompactionSettings;
	private overflowRecoveryAttempted = false;
	private compactionAbortController: AbortController | undefined;
	private eventCallback: FlueEventCallback | undefined;
	private agentCommands: Command[];
	private agentTools: ToolDef[];
	private deleted = false;
	private activeOperation: string | undefined;
	private activeTasks = new Set<Session>();
	private sessionRole: string | undefined;
	private taskDepth: number;
	private createTaskSession: CreateTaskSession | undefined;
	private onDelete: (() => void) | undefined;

	constructor(options: SessionInitOptions) {
		this.id = options.id;
		this.storageKey = options.storageKey;
		this.config = options.config;
		this.env = options.env;
		this.store = options.store;
		this.agentCommands = options.agentCommands ?? [];
		this.agentTools = options.agentTools ?? [];
		this.sessionRole = options.sessionRole;
		this.taskDepth = options.taskDepth ?? 0;
		this.createTaskSession = options.createTaskSession;
		this.onDelete = options.onDelete;

		this.metadata = options.existingData?.metadata ?? {};
		this.createdAt = options.existingData?.createdAt;

		this.history = SessionHistory.fromData(options.existingData);

		const cc = this.config.compaction;
		this.compactionSettings = {
			enabled: cc?.enabled ?? DEFAULT_COMPACTION_SETTINGS.enabled,
			reserveTokens: cc?.reserveTokens ?? DEFAULT_COMPACTION_SETTINGS.reserveTokens,
			keepRecentTokens: cc?.keepRecentTokens ?? DEFAULT_COMPACTION_SETTINGS.keepRecentTokens,
		};

		const systemPrompt = this.config.systemPrompt;

		assertRoleExists(this.config.roles, this.config.role);
		assertRoleExists(this.config.roles, this.sessionRole);

		const tools = [
			...this.createBuiltinTools(this.env, this.agentCommands, []),
			...this.createCustomTools(this.agentTools),
		];

		const previousMessages = this.history.buildContext();

		this.harness = new Agent({
			initialState: {
				systemPrompt,
				model: this.config.model,
				tools,
				messages: previousMessages,
			},
			getApiKey: (provider) => this.getProviderApiKey(provider),
			toolExecution: 'parallel',
		});

		this.eventCallback = options.onAgentEvent;
		this.harness.subscribe(async (event) => {
			switch (event.type) {
				case 'agent_start':
					this.emit({ type: 'agent_start' });
					break;
				case 'message_update': {
					const aEvent = event.assistantMessageEvent;
					if (aEvent.type === 'text_delta') {
						this.emit({ type: 'text_delta', text: aEvent.delta });
					} else if (aEvent.type === 'thinking_start') {
						this.emit({ type: 'thinking_start' });
					} else if (aEvent.type === 'thinking_delta') {
						this.emit({ type: 'thinking_delta', delta: aEvent.delta });
					} else if (aEvent.type === 'thinking_end') {
						this.emit({ type: 'thinking_end', content: aEvent.content });
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
				case 'agent_end':
					break;
			}
		});
	}

	async prompt<S extends v.GenericSchema>(
		text: string,
		options: PromptOptions<S> & { result: S },
	): Promise<PromptResultResponse<v.InferOutput<S>>>;
	async prompt(text: string, options?: PromptOptions): Promise<PromptResponse>;
	async prompt(text: string, options?: PromptOptions<v.GenericSchema | undefined>): Promise<any> {
		return this.runOperation('prompt', async () => {
			const role = this.resolveEffectiveRole(options?.role);

			const schema = options?.result as v.GenericSchema | undefined;
			const fullPrompt = buildPromptText(text, schema);

			const effectiveCommands = mergeCommands(this.agentCommands, options?.commands);
			return this.withScopedRuntime(
				{
					commands: effectiveCommands,
					tools: options?.tools ?? [],
					role,
					model: options?.model,
					callSite: 'this prompt() call',
				},
				async ({ resolvedModel }) => {
					// Two snapshots, two purposes:
					//   - `beforeLength` indexes the volatile flat-message array and is
					//     used by `syncHarnessMessagesSince` to copy newly produced
					//     harness messages into the durable history tree.
					//   - `beforeLeafId` anchors a window in that durable tree and is
					//     used by `aggregateUsageSince` to sum usage across exactly the
					//     entries this call appended (including any compaction entry).
					const beforeLength = this.harness.state.messages.length;
					const beforeLeafId = this.history.getLeafId();
					await this.harness.prompt(fullPrompt);
					await this.harness.waitForIdle();
					await this.syncHarnessMessagesSince(beforeLength, 'prompt');
					await this.checkLatestAssistantForCompaction();
					this.throwIfError('prompt');

					const model: PromptModel = { id: resolvedModel.id };
					if (schema) {
						const result = await this.extractResultWithRetry(schema);
						return {
							result,
							usage: this.aggregateUsageSince(beforeLeafId),
							model,
						};
					}
					return {
						text: this.getAssistantText(),
						usage: this.aggregateUsageSince(beforeLeafId),
						model,
					};
				},
			);
		});
	}

	async skill<S extends v.GenericSchema>(
		name: string,
		options: SkillOptions<S> & { result: S },
	): Promise<PromptResultResponse<v.InferOutput<S>>>;
	async skill(name: string, options?: SkillOptions): Promise<PromptResponse>;
	async skill(name: string, options?: SkillOptions<v.GenericSchema | undefined>): Promise<any> {
		return this.runOperation('skill', async () => {
			const role = this.resolveEffectiveRole(options?.role);

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
				const cwd = this.env.cwd;
				throw new Error(
					`Skill "${name}" not registered. Available: ${available}.\n\n` +
						`Skills are loaded at init() time from ${cwd}/.agents/skills/<name>/SKILL.md ` +
						`inside the session's sandbox. If you expected "${name}" to be there, make sure ` +
						`the file exists in your sandbox at that path before calling init() — the default ` +
						`empty sandbox starts with no files, so it has no skills unless you put them there.\n\n` +
						`Skills can also be referenced by relative path under .agents/skills/ ` +
						`(e.g. "triage/reproduce.md").`,
				);
			}

			const schema = options?.result as v.GenericSchema | undefined;
			const skillPrompt = buildSkillPrompt(registeredSkill.instructions, options?.args, schema);

			const effectiveCommands = mergeCommands(this.agentCommands, options?.commands);
			return this.withScopedRuntime(
				{
					commands: effectiveCommands,
					tools: options?.tools ?? [],
					role,
					model: options?.model,
					callSite: `this skill("${name}") call`,
				},
				async ({ resolvedModel }) => {
					const beforeLength = this.harness.state.messages.length;
					const beforeLeafId = this.history.getLeafId();
					await this.harness.prompt(skillPrompt);
					await this.harness.waitForIdle();
					await this.syncHarnessMessagesSince(beforeLength, 'skill');
					await this.checkLatestAssistantForCompaction();
					this.throwIfError(`skill("${name}")`);

					const model: PromptModel = { id: resolvedModel.id };
					if (schema) {
						const result = await this.extractResultWithRetry(schema);
						return {
							result,
							usage: this.aggregateUsageSince(beforeLeafId),
							model,
						};
					}
					return {
						text: this.getAssistantText(),
						usage: this.aggregateUsageSince(beforeLeafId),
						model,
					};
				},
			);
		});
	}

	async task<S extends v.GenericSchema>(
		text: string,
		options: TaskOptions<S> & { result: S },
	): Promise<PromptResultResponse<v.InferOutput<S>>>;
	async task(text: string, options?: TaskOptions): Promise<PromptResponse>;
	async task(text: string, options?: TaskOptions<v.GenericSchema | undefined>): Promise<any> {
		const result = await this.runTask(text, options, undefined);
		return result.output;
	}

	async shell(command: string, options?: ShellOptions): Promise<ShellResult> {
		return this.runOperation('shell', async () => {
			const effectiveCommands = mergeCommands(this.agentCommands, options?.commands);
			const env = await scopeSessionEnv(this.env, effectiveCommands);
			const result = await env.exec(command, {
				env: options?.env,
				cwd: options?.cwd,
				timeout: options?.timeout,
			});
			const shellResult = {
				stdout: result.stdout,
				stderr: result.stderr,
				exitCode: result.exitCode,
			};
			const message = this.createShellMessage(command, shellResult, options);
			this.history.appendMessage(message, 'shell');
			this.harness.state.messages = this.history.buildContext();
			await this.save();
			return shellResult;
		});
	}

	abort(): void {
		this.harness.abort();
		this.compactionAbortController?.abort();
		for (const task of this.activeTasks) task.abort();
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
		await deleteSessionTree(this.store, this.storageKey);
		this.onDelete?.();
	}

	private resolveEffectiveRole(callRole?: string): string | undefined {
		return resolveEffectiveRoleName({
			roles: this.config.roles,
			agentRole: this.config.role,
			sessionRole: this.sessionRole,
			callRole,
		});
	}

	/** Precedence: call-level > role-level > agent-level default. */
	private resolveModelForCall(
		promptModel: string | undefined,
		roleName: string | undefined,
		callSite: string,
	): Model<any> {
		let model: Model<any> | undefined = this.config.model;

		const roleModel = resolveRoleModel(this.config.roles, roleName);
		if (roleModel) {
			model = this.config.resolveModel(roleModel, this.config.providers);
		}

		if (promptModel) {
			model = this.config.resolveModel(promptModel, this.config.providers);
		}

		return this.requireModel(model, callSite);
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
				`Pass \`{ model: "provider/model-id" }\` to this call or configure a role model.`,
		);
	}

	private getProviderApiKey(provider: string): string | undefined {
		return this.config.providers?.[provider]?.apiKey;
	}

	private buildSystemPrompt(roleName?: string): string {
		const parts = [this.config.systemPrompt];
		if (!roleName) return parts.join('\n\n');
		const role = this.config.roles[roleName];
		if (!role) return parts.join('\n\n');
		parts.push(`<role name="${role.name}">\n${role.instructions}\n</role>`);
		return parts.filter(Boolean).join('\n\n');
	}

	// ─── Custom Tools ───────────────────────────────────────────────────────

	private createCustomTools(tools: ToolDef[]): AgentTool<any>[] {
		this.validateCustomToolNames(tools);

		return tools.map((toolDef) => ({
			name: toolDef.name,
			label: toolDef.name,
			description: toolDef.description,
			parameters: toolDef.parameters,
			async execute(_toolCallId: string, params: Record<string, any>, signal?: AbortSignal) {
				if (signal?.aborted) throw new Error('Operation aborted');
				const resultText = await toolDef.execute(params, signal);
				return {
					content: [{ type: 'text' as const, text: resultText }],
					details: { customTool: toolDef.name },
				};
			},
		}));
	}

	private validateCustomToolNames(tools: ToolDef[]): void {
		const names = new Set<string>();
		for (const toolDef of tools) {
			if (BUILTIN_TOOL_NAMES.has(toolDef.name)) {
				throw new Error(
					`[flue] Custom tool "${toolDef.name}" conflicts with a built-in tool. ` +
						`Built-in tools: ${[...BUILTIN_TOOL_NAMES].join(', ')}`,
				);
			}
			if (names.has(toolDef.name)) {
				throw new Error(
					`[flue] Duplicate custom tool name "${toolDef.name}". Tool names must be unique.`,
				);
			}
			names.add(toolDef.name);
		}
	}

	private createBuiltinTools(
		env: SessionEnv,
		commands: Command[],
		tools: ToolDef[],
		role?: string,
		model?: string,
	): AgentTool<any>[] {
		return createTools(env, {
			roles: this.config.roles,
			task: (params, signal) => this.runTaskForTool(params, commands, tools, role, model, signal),
		});
	}

	private async withScopedRuntime<T>(
		options: RuntimeScopeOptions,
		fn: (ctx: { resolvedModel: Model<any> }) => Promise<T>,
	): Promise<T> {
		const customTools = this.createCustomTools([...this.agentTools, ...options.tools]);
		const scopedEnv = await scopeSessionEnv(this.env, options.commands);
		const previousTools = this.harness.state.tools;
		const previousModel = this.harness.state.model;
		const previousSystemPrompt = this.harness.state.systemPrompt;

		const resolvedModel = this.resolveModelForCall(
			options.model,
			options.role,
			options.callSite,
		);
		this.harness.state.model = resolvedModel;
		this.harness.state.systemPrompt = this.buildSystemPrompt(options.role);
		this.harness.state.tools = [
			...this.createBuiltinTools(
				scopedEnv,
				options.commands,
				options.tools,
				options.role,
				options.model,
			),
			...customTools,
		];
		try {
			return await fn({ resolvedModel });
		} finally {
			this.harness.state.tools = previousTools;
			this.harness.state.model = previousModel;
			this.harness.state.systemPrompt = previousSystemPrompt;
		}
	}

	// ─── Tasks ────────────────────────────────────────────────────────────────

	private async runTaskForTool(
		params: TaskToolParams,
		commands: Command[],
		tools: ToolDef[],
		inheritedRole: string | undefined,
		inheritedModel: string | undefined,
		signal?: AbortSignal,
	): Promise<AgentToolResult<TaskToolResultDetails>> {
		const result = await this.runTask(
			params.prompt,
			{
				role: params.role ?? inheritedRole,
				inheritedModel,
				cwd: params.cwd,
				commands,
				tools,
			},
			signal,
		);

		return {
			content: [{ type: 'text', text: result.text || '(task completed with no text)' }],
			details: {
				taskId: result.taskId,
				sessionId: result.sessionId,
				messageId: result.messageId,
				role: result.role,
				cwd: result.cwd,
			},
		};
	}

	private async runTask<S extends v.GenericSchema | undefined>(
		text: string,
		options: InternalTaskOptions<S> | undefined,
		signal: AbortSignal | undefined,
	): Promise<
		InternalTaskResult<
			S extends v.GenericSchema ? PromptResultResponse<v.InferOutput<S>> : PromptResponse
		>
	> {
		this.assertActive();
		if (!this.createTaskSession) {
			throw new Error('[flue] This session cannot create task sessions.');
		}
		if (this.taskDepth >= MAX_TASK_DEPTH) {
			throw new Error(`[flue] Maximum task depth (${MAX_TASK_DEPTH}) exceeded.`);
		}
		if (signal?.aborted) throw new Error('Operation aborted');

		const taskId = crypto.randomUUID();
		const requestedRole = options?.role ?? this.sessionRole ?? this.config.role;
		let child: Session | undefined;
		let abortListener: (() => void) | undefined;

		this.emit({
			type: 'task_start',
			taskId,
			prompt: text,
			role: requestedRole,
			cwd: options?.cwd,
			parentSessionId: this.id,
		});

		try {
			const role = this.resolveEffectiveRole(options?.role);
			const commands = mergeCommands(this.agentCommands, options?.commands);

			child = await this.createTaskSession({
				parentSessionId: this.id,
				taskId,
				parentEnv: this.env,
				cwd: options?.cwd,
				role,
				commands,
				depth: this.taskDepth + 1,
			});
			await this.recordTaskSession(child.id, child.storageKey, taskId);
			this.activeTasks.add(child);

			if (signal) {
				abortListener = () => child?.abort();
				signal.addEventListener('abort', abortListener, { once: true });
				if (signal.aborted) throw new Error('Operation aborted');
			}

			const schema = options?.result as v.GenericSchema | undefined;
			const roleModel = resolveRoleModel(this.config.roles, role);
			const childOptions: PromptOptions<v.GenericSchema | undefined> = {
				model: options?.model ?? (roleModel ? undefined : options?.inheritedModel),
				tools: options?.tools,
			};
			if (schema) childOptions.result = schema;

			const output: any = await child.prompt(text, childOptions as any);
			const taskResult: InternalTaskResult<any> = {
				output,
				text: typeof output?.text === 'string' ? output.text : child.getAssistantText(),
				taskId,
				sessionId: child.id,
				messageId: child.getLatestAssistantMessageId(),
				role,
				cwd: options?.cwd,
			};
			this.emit({
				type: 'task_end',
				taskId,
				isError: false,
				result: taskResult.text,
				parentSessionId: this.id,
			});
			return taskResult;
		} catch (error) {
			this.emit({
				type: 'task_end',
				taskId,
				isError: true,
				result: getErrorMessage(error),
				parentSessionId: this.id,
			});
			this.emit({ type: 'error', error: getErrorMessage(error) });
			throw error;
		} finally {
			if (signal && abortListener) signal.removeEventListener('abort', abortListener);
			if (child) {
				this.activeTasks.delete(child);
				child.close();
			}
		}
	}

	// ─── Internal ────────────────────────────────────────────────────────────

	private async runOperation<T>(operation: string, fn: () => Promise<T>): Promise<T> {
		return this.runExclusive(operation, async () => {
			try {
				return await fn();
			} catch (error) {
				this.emit({ type: 'error', error: getErrorMessage(error) });
				throw error;
			} finally {
				this.emit({ type: 'idle' });
			}
		});
	}

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

	private createShellMessage(
		command: string,
		result: ShellResult,
		options?: ShellOptions,
	): AgentMessage {
		const cwdLine = options?.cwd ? `\ncwd: ${options.cwd}` : '';
		const envLine = options?.env ? `\nenv: ${Object.keys(options.env).sort().join(', ')}` : '';
		const output = formatShellHistory(command, result, cwdLine, envLine);
		return {
			role: 'user',
			content: [{ type: 'text', text: output }],
			timestamp: Date.now(),
		} as AgentMessage;
	}

	private async syncHarnessMessagesSince(index: number, source: MessageSource): Promise<void> {
		const messages = this.harness.state.messages.slice(index) as AgentMessage[];
		if (messages.length === 0) return;
		this.history.appendMessages(messages, source);
		await this.save();
	}

	private async save(): Promise<void> {
		const now = new Date().toISOString();
		const data = this.history.toData(this.metadata, this.createdAt ?? now, now);
		if (!this.createdAt) this.createdAt = now;
		await this.store.save(this.storageKey, data);
	}

	private async recordTaskSession(
		sessionId: string,
		storageKey: string,
		taskId: string,
	): Promise<void> {
		const taskSessions = Array.isArray(this.metadata.taskSessions)
			? this.metadata.taskSessions
			: [];
		if (!taskSessions.some((task) => task?.sessionId === sessionId)) {
			taskSessions.push({ sessionId, taskId, storageKey });
			this.metadata.taskSessions = taskSessions;
			await this.save();
		}
	}

	// ─── Compaction ───────────────────────────────────────────────────────────

	private async checkLatestAssistantForCompaction(): Promise<void> {
		const messages = this.harness.state.messages;
		const lastMsg = messages[messages.length - 1];
		if (lastMsg?.role === 'assistant') {
			await this.checkCompaction(lastMsg as AssistantMessage);
		}
	}

	private async checkCompaction(assistantMessage: AssistantMessage): Promise<void> {
		if (!this.compactionSettings.enabled) return;
		if (assistantMessage.stopReason === 'aborted') return;

		const model = this.harness.state.model;
		const contextWindow = model.contextWindow ?? 0;
		const overflow = isContextOverflow(assistantMessage, contextWindow);

		if (overflow) {
			if (this.overflowRecoveryAttempted) return;
			this.overflowRecoveryAttempted = true;

			console.error(`[flue:compaction] Overflow detected, compacting and retrying...`);

			const messages = this.harness.state.messages;
			const lastMsg = messages[messages.length - 1];
			if (lastMsg && lastMsg.role === 'assistant') {
				this.harness.state.messages = messages.slice(0, -1);
				this.history.removeLeafMessage(lastMsg as AgentMessage);
				await this.save();
			}

			try {
				await this.runCompaction('overflow', true);
			} finally {
				this.overflowRecoveryAttempted = false;
			}
			return;
		}
		if (assistantMessage.stopReason === 'error') return;

		const contextTokens = calculateContextTokens(assistantMessage.usage);

		if (shouldCompact(contextTokens, contextWindow, this.compactionSettings)) {
			console.error(
				`[flue:compaction] Threshold reached — ${contextTokens} tokens used, ` +
					`window ${contextWindow}, reserve ${this.compactionSettings.reserveTokens}, ` +
					`triggering compaction`,
			);
			await this.runCompaction('threshold', false);
		}
	}

	/**
	 * Runs a compaction pass. The summarization cost (1–2 internal LLM
	 * calls) is persisted on the resulting `CompactionEntry.usage`, which
	 * `aggregateUsageSince` later folds into the surrounding call's
	 * `response.usage` — so users see the true cost of the call that
	 * triggered compaction.
	 */
	private async runCompaction(reason: 'threshold' | 'overflow', willRetry: boolean): Promise<void> {
		this.compactionAbortController = new AbortController();
		const messagesBefore = this.harness.state.messages.length;

		try {
			const model = this.harness.state.model;
			const contextEntries = this.history.buildContextEntries();
			const messages = contextEntries.map((entry) => entry.message);
			const latestCompaction = this.history.getLatestCompaction();

			const preparation = prepareCompaction(
				messages,
				this.compactionSettings,
				latestCompaction
					? {
							summary: latestCompaction.summary,
							firstKeptIndex: 1,
							details: latestCompaction.details,
						}
					: undefined,
			);
			if (!preparation) {
				console.error(`[flue:compaction] Nothing to compact (no valid cut point found)`);
				return;
			}
			const firstKeptEntry = contextEntries[preparation.firstKeptIndex]?.entry;
			if (!firstKeptEntry || firstKeptEntry.type !== 'message') {
				console.error(`[flue:compaction] Nothing to compact (first kept message has no entry)`);
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
				this.getProviderApiKey(model.provider),
				this.compactionAbortController.signal,
			);

			if (this.compactionAbortController.signal.aborted) return;

			this.history.appendCompaction({
				summary: result.summary,
				firstKeptEntryId: firstKeptEntry.id,
				tokensBefore: result.tokensBefore,
				details: result.details,
				usage: result.usage,
			});
			this.harness.state.messages = this.history.buildContext();

			const messagesAfter = this.harness.state.messages.length;
			console.error(
				`[flue:compaction] Complete — messages: ${messagesBefore} → ${messagesAfter}, ` +
					`tokens before: ${result.tokensBefore}`,
			);

			this.emit({ type: 'compaction_end', messagesBefore, messagesAfter });

			await this.save();

			if (willRetry) {
				const msgs = this.harness.state.messages;
				const lastMsg = msgs[msgs.length - 1];
				if (lastMsg?.role === 'assistant' && (lastMsg as AssistantMessage).stopReason === 'error') {
					this.harness.state.messages = msgs.slice(0, -1);
				}
				console.error(`[flue:compaction] Retrying after overflow recovery...`);
				const beforeRetry = this.harness.state.messages.length;
				await this.harness.continue();
				await this.harness.waitForIdle();
				await this.syncHarnessMessagesSince(beforeRetry, 'retry');
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

	/**
	 * Sum the usage of every entry the call appended to the active path
	 * after `beforeLeafId`: assistant messages contribute their per-turn
	 * `usage` (provider-reported, normalized through `fromProviderUsage`),
	 * and compaction entries contribute the aggregated cost of the
	 * summarization call(s) they dispatched. Returns zeros when nothing
	 * was appended (defensive — `throwIfError` normally fires first).
	 *
	 * Walks the durable, parent-linked active path rather than the volatile
	 * flat `harness.state.messages` array, so the result is robust to
	 * mid-call mutations (e.g. overflow recovery removing a failed
	 * assistant turn before retry).
	 */
	private aggregateUsageSince(beforeLeafId: string | null): PromptUsage {
		let totals = emptyUsage();
		for (const entry of this.history.getActivePathSince(beforeLeafId)) {
			if (entry.type === 'message' && entry.message.role === 'assistant') {
				const usage = fromProviderUsage((entry.message as AssistantMessage).usage);
				if (usage) totals = addUsage(totals, usage);
			} else if (entry.type === 'compaction' && entry.usage) {
				totals = addUsage(totals, entry.usage);
			}
		}
		return totals;
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

	private getLatestAssistantMessageId(): string | undefined {
		const path = this.history.getActivePath();
		for (let i = path.length - 1; i >= 0; i--) {
			const entry = path[i]!;
			if (entry.type === 'message' && entry.message.role === 'assistant') {
				return entry.id;
			}
		}
		return undefined;
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
			const beforeRetry = this.harness.state.messages.length;
			await this.harness.prompt(followUpPrompt);
			await this.harness.waitForIdle();
			await this.syncHarnessMessagesSince(beforeRetry, 'retry');
			await this.checkLatestAssistantForCompaction();

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

export async function deleteSessionTree(
	store: SessionStore,
	storageKey: string,
	seen = new Set<string>(),
): Promise<void> {
	if (seen.has(storageKey)) return;
	seen.add(storageKey);
	const data = await store.load(storageKey);
	const taskSessions = Array.isArray(data?.metadata?.taskSessions)
		? data.metadata.taskSessions
		: [];
	for (const task of taskSessions) {
		if (typeof task?.storageKey === 'string') {
			await deleteSessionTree(store, task.storageKey, seen);
		}
	}
	await store.delete(storageKey);
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

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
