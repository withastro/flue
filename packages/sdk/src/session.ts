/** Internal session implementation. Not exported publicly — wrapped by FlueSession. */
import { Agent } from '@mariozechner/pi-agent-core';
import type { AgentMessage, AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type { AssistantMessage, Model, ToolResultMessage, UserMessage } from '@mariozechner/pi-ai';
import type * as v from 'valibot';
import { abortErrorFor, createCallHandle } from './abort.ts';
import {
	BUILTIN_TOOL_NAMES,
	createTools,
	formatBashResult,
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
	buildResultFollowUpPrompt,
	buildSkillByNamePrompt,
	buildSkillByPathPrompt,
	createResultTools,
	ResultUnavailableError,
	type ResultToolBundle,
} from './result.ts';
import { addUsage, emptyUsage, fromProviderUsage } from './usage.ts';
import { resolveSkillFilePath, skillsDirIn } from './context.ts';
import { createScopedEnv as scopeSessionEnv, mergeCommands } from './env-utils.ts';
import {
	assertRoleExists,
	resolveEffectiveRole as resolveEffectiveRoleName,
	resolveRoleModel,
	resolveRoleThinkingLevel,
} from './roles.ts';
import { SessionHistory, type ContextEntry, type MessageSource } from './session-history.ts';
import type {
	AgentConfig,
	CallHandle,
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
	ThinkingLevel,
	ToolDef,
} from './types.ts';

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
	thinkingLevel?: ThinkingLevel;
	callSite: string;
	/**
	 * SDK-injected pi-agent-core tools spliced in alongside builtins and custom
	 * tools for the duration of this call. Used by the schema'd-result flow to
	 * inject `finish` and `give_up`.
	 */
	extraTools?: AgentTool<any>[];
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
	inheritedThinkingLevel?: ThinkingLevel;
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
				thinkingLevel: this.config.thinkingLevel ?? 'off',
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

	prompt<S extends v.GenericSchema>(
		text: string,
		options: PromptOptions<S> & { result: S },
	): CallHandle<PromptResultResponse<v.InferOutput<S>>>;
	prompt(text: string, options?: PromptOptions): CallHandle<PromptResponse>;
	prompt(text: string, options?: PromptOptions<v.GenericSchema | undefined>): CallHandle<any> {
		return createCallHandle(options?.signal, (signal) =>
			this.runOperation('prompt', signal, async () => {
				const schema = options?.result as v.GenericSchema | undefined;
				return this.runPromptCall({
					promptText: buildPromptText(text, schema),
					schema,
					tools: options?.tools,
					commands: options?.commands,
					role: options?.role,
					model: options?.model,
					thinkingLevel: options?.thinkingLevel,
					source: 'prompt',
					errorLabel: 'prompt',
					callSite: 'this prompt() call',
					signal,
				});
			}),
		);
	}

	skill<S extends v.GenericSchema>(
		name: string,
		options: SkillOptions<S> & { result: S },
	): CallHandle<PromptResultResponse<v.InferOutput<S>>>;
	skill(name: string, options?: SkillOptions): CallHandle<PromptResponse>;
	skill(name: string, options?: SkillOptions<v.GenericSchema | undefined>): CallHandle<any> {
		return createCallHandle(options?.signal, (signal) =>
			this.runOperation('skill', signal, async () => {
				// Skills can be referenced two ways. The shape determines the
				// per-call user-message format; the model reads the file
				// itself in both cases.
				//
				//   1. By registered name. Looked up in `this.config.skills`,
				//      populated at init time from `.agents/skills/*/SKILL.md`
				//      frontmatter. The system prompt's "Available Skills"
				//      list tells the model name + description + convention,
				//      so the per-call message just identifies the skill.
				//
				//   2. By relative path under `.agents/skills/` (e.g.
				//      `'triage/reproduce.md'`). The skill isn't in the
				//      registry, so we hand the model the resolved absolute
				//      path explicitly. Triggered only when `name` looks
				//      like a path (contains `/` or ends in `.md`/`.markdown`)
				//      — otherwise typos of registered names fail fast with
				//      a helpful error rather than silently fall through to
				//      a path lookup that's also going to miss.
				const looksLikePath = name.includes('/') || /\.(md|markdown)$/i.test(name);
				const schema = options?.result as v.GenericSchema | undefined;

				let promptText: string;
				if (looksLikePath) {
					const resolvedPath = await resolveSkillFilePath(this.env, this.env.cwd, name);
					if (!resolvedPath) {
						throw new Error(
							`[flue] Skill file "${name}" not found at ${skillsDirIn(this.env.cwd)}/${name} ` +
								`inside the session's sandbox. Make sure the file exists at that path.`,
						);
					}
					promptText = buildSkillByPathPrompt(name, resolvedPath, options?.args, schema);
				} else {
					if (!this.config.skills[name]) {
						const available = Object.keys(this.config.skills).join(', ') || '(none)';
						throw new Error(
							`[flue] Skill "${name}" not registered. Available: ${available}.\n\n` +
								`Skills are discovered at init() time from ${skillsDirIn(this.env.cwd)}/<name>/SKILL.md ` +
								`inside the session's sandbox. If you expected "${name}" to be there, make sure ` +
								`the SKILL.md file exists at that path before calling init() — the default ` +
								`empty sandbox starts with no files, so it has no skills unless you put them there.\n\n` +
								`Skills can also be referenced by relative path under .agents/skills/ ` +
								`(e.g. "triage/reproduce.md").`,
						);
					}
					promptText = buildSkillByNamePrompt(name, options?.args, schema);
				}

				return this.runPromptCall({
					promptText,
					schema,
					tools: options?.tools,
					commands: options?.commands,
					role: options?.role,
					model: options?.model,
					thinkingLevel: options?.thinkingLevel,
					source: 'skill',
					errorLabel: `skill("${name}")`,
					callSite: `this skill("${name}") call`,
					signal,
				});
			}),
		);
	}

	task<S extends v.GenericSchema>(
		text: string,
		options: TaskOptions<S> & { result: S },
	): CallHandle<PromptResultResponse<v.InferOutput<S>>>;
	task(text: string, options?: TaskOptions): CallHandle<PromptResponse>;
	task(text: string, options?: TaskOptions<v.GenericSchema | undefined>): CallHandle<any> {
		return createCallHandle(options?.signal, async (signal) => {
			const result = await this.runTask(text, options, signal);
			return result.output;
		});
	}

	shell(command: string, options?: ShellOptions): CallHandle<ShellResult> {
		return createCallHandle(options?.signal, (signal) =>
			this.runOperation('shell', signal, async () => {
				// session.shell() is an out-of-band tool invocation: the caller
				// (agent code) decides to run a bash command, but it should
				// appear in the message history as if the model itself had
				// called the bash tool. That keeps the transcript readable for
				// later turns, lets compaction handle it via the same path as
				// real tool calls, and removes the synthetic-user-message
				// shape that earlier versions of this method produced.
				//
				// Concretely we emit the same tool_start/tool_end events the
				// harness emits for LLM-driven tool calls, and we append a
				// (user request, assistant tool_use, toolResult) message
				// triple to history. The toolCallId we generate here matches
				// the one referenced by the toolResult, just like a real
				// tool-use round.
				const toolCallId = crypto.randomUUID();

				// Per-call cwd/env, when set, are part of the call's identity
				// and need to be visible in the transcript. Without them the
				// model can't tell on a later turn that a command ran with
				// overrides — making questions like "what cwd was that run
				// from?" unanswerable from history. The bash tool's own
				// schema (BashParams) doesn't formally declare these, but
				// pi-ai's ToolCall.arguments is `Record<string, any>` and
				// providers forward arguments opaquely, so extending the
				// shape here is safe.
				const args: Record<string, unknown> = { command };
				if (options?.cwd !== undefined) args.cwd = options.cwd;
				if (options?.env !== undefined) args.env = options.env;

				this.emit({ type: 'tool_start', toolName: 'bash', toolCallId, args });

				const effectiveCommands = mergeCommands(this.agentCommands, options?.commands);
				const env = await scopeSessionEnv(this.env, effectiveCommands);

				try {
					const result = await env.exec(command, {
						env: options?.env,
						cwd: options?.cwd,
						signal,
					});
					const shellResult: ShellResult = {
						stdout: result.stdout,
						stderr: result.stderr,
						exitCode: result.exitCode,
					};
					const toolResult = formatBashResult(shellResult, command);
					await this.appendShellTriple(toolCallId, args, toolResult, false);
					this.emit({
						type: 'tool_end',
						toolName: 'bash',
						toolCallId,
						isError: false,
						result: toolResult,
					});
					return shellResult;
				} catch (error) {
					// Aligns with formatBashResult's `details: { command, exitCode }`
					// shape so consumers reading event.result.details.exitCode see a
					// number on both branches. -1 is the conventional sentinel for
					// "no exit recorded" (the same one env.exec uses internally for
					// sandbox-level failures — see sandbox.ts).
					const errResult: AgentToolResult<any> = {
						content: [{ type: 'text', text: getErrorMessage(error) }],
						details: { command, exitCode: -1 },
					};
					await this.appendShellTriple(toolCallId, args, errResult, true);
					this.emit({
						type: 'tool_end',
						toolName: 'bash',
						toolCallId,
						isError: true,
						result: errResult,
					});
					throw error;
				}
			}),
		);
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

	/** Precedence: call-level > role-level > agent-level default > 'off'. */
	private resolveThinkingLevelForCall(
		callValue: ThinkingLevel | undefined,
		roleName: string | undefined,
	): ThinkingLevel {
		if (callValue !== undefined) return callValue;
		const roleLevel = resolveRoleThinkingLevel(this.config.roles, roleName);
		if (roleLevel !== undefined) return roleLevel;
		return this.config.thinkingLevel ?? 'off';
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

		return tools.map(
			(toolDef): AgentTool<any> => ({
				name: toolDef.name,
				label: toolDef.name,
				description: toolDef.description,
				parameters: toolDef.parameters as any,
				async execute(_toolCallId: string, params: unknown, signal?: AbortSignal) {
					if (signal?.aborted) throw new Error('Operation aborted');
					const resultText = await toolDef.execute(params as Record<string, any>, signal);
					return {
						content: [{ type: 'text' as const, text: resultText }],
						details: { customTool: toolDef.name },
					};
				},
			}),
		);
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
		thinkingLevel?: ThinkingLevel,
	): AgentTool<any>[] {
		return createTools(env, {
			roles: this.config.roles,
			task: (params, signal) =>
				this.runTaskForTool(params, commands, tools, role, model, thinkingLevel, signal),
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
		const previousThinkingLevel = this.harness.state.thinkingLevel;

		const resolvedModel = this.resolveModelForCall(
			options.model,
			options.role,
			options.callSite,
		);
		this.harness.state.model = resolvedModel;
		this.harness.state.systemPrompt = this.buildSystemPrompt(options.role);
		this.harness.state.thinkingLevel = this.resolveThinkingLevelForCall(
			options.thinkingLevel,
			options.role,
		);
		this.harness.state.tools = [
			...this.createBuiltinTools(
				scopedEnv,
				options.commands,
				options.tools,
				options.role,
				options.model,
				options.thinkingLevel,
			),
			...customTools,
			...(options.extraTools ?? []),
		];
		try {
			return await fn({ resolvedModel });
		} finally {
			this.harness.state.tools = previousTools;
			this.harness.state.model = previousModel;
			this.harness.state.systemPrompt = previousSystemPrompt;
			this.harness.state.thinkingLevel = previousThinkingLevel;
		}
	}

	// ─── Tasks ────────────────────────────────────────────────────────────────

	private async runTaskForTool(
		params: TaskToolParams,
		commands: Command[],
		tools: ToolDef[],
		inheritedRole: string | undefined,
		inheritedModel: string | undefined,
		inheritedThinkingLevel: ThinkingLevel | undefined,
		signal?: AbortSignal,
	): Promise<AgentToolResult<TaskToolResultDetails>> {
		const result = await this.runTask(
			params.prompt,
			{
				role: params.role ?? inheritedRole,
				inheritedModel,
				inheritedThinkingLevel,
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
		if (signal?.aborted) throw abortErrorFor(signal);

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

			// Aborts during sandbox bring-up — child.prompt's own
			// runOperation handles the in-flight case.
			if (signal) {
				abortListener = () => child?.abort();
				signal.addEventListener('abort', abortListener, { once: true });
			}

			const schema = options?.result as v.GenericSchema | undefined;
			const roleModel = resolveRoleModel(this.config.roles, role);
			const roleThinkingLevel = resolveRoleThinkingLevel(this.config.roles, role);
			const childOptions: PromptOptions<v.GenericSchema | undefined> = {
				model: options?.model ?? (roleModel ? undefined : options?.inheritedModel),
				thinkingLevel:
					options?.thinkingLevel ??
					(roleThinkingLevel !== undefined ? undefined : options?.inheritedThinkingLevel),
				tools: options?.tools,
				signal,
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

	private async runOperation<T>(
		operation: string,
		signal: AbortSignal | undefined,
		fn: () => Promise<T>,
	): Promise<T> {
		return this.runExclusive(operation, async () => {
			if (signal?.aborted) throw abortErrorFor(signal);

			// Mirror Session.abort() for the duration of this call.
			// shell() doesn't use the harness/compaction/tasks — these
			// hooks are inert there.
			const onAbort = () => {
				this.harness.abort();
				this.compactionAbortController?.abort(signal?.reason);
				for (const task of this.activeTasks) task.abort();
			};
			signal?.addEventListener('abort', onAbort, { once: true });

			try {
				return await fn();
			} catch (error) {
				// After the signal aborts, anything thrown downstream is
				// post-abort fallout (harness, tools, compaction). Surface
				// a single AbortError shape to callers. Failures propagate
				// to the caller via throw — operation-end events
				// (task_end isError, tool_end isError) carry the same
				// information for in-process observers, so we don't emit a
				// separate 'error' event here.
				const surfaced = signal?.aborted ? abortErrorFor(signal) : error;
				throw surfaced;
			} finally {
				signal?.removeEventListener('abort', onAbort);
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

	/**
	 * Append the three-message conversational triple that represents a
	 * `session.shell()` call in the message history:
	 *
	 *   1. user        — out-of-band request to run the command
	 *   2. assistant   — synthetic turn whose content is a single bash
	 *                    tool_use block (matching the shape pi-ai's
	 *                    providers produce when the LLM itself calls bash)
	 *   3. toolResult  — the bash output, keyed to the same toolCallId
	 *
	 * This makes a session.shell() call indistinguishable from an
	 * LLM-issued bash tool call when later turns read the transcript.
	 */
	private async appendShellTriple(
		toolCallId: string,
		args: Record<string, unknown>,
		toolResult: AgentToolResult<any>,
		isError: boolean,
	): Promise<void> {
		const timestamp = Date.now();
		const command = args.command as string;
		const userMessage: UserMessage = {
			role: 'user',
			content: `Run this shell command:\n\n\`\`\`bash\n${command}\n\`\`\``,
			timestamp,
		};
		const assistantMessage: AssistantMessage = {
			role: 'assistant',
			content: [
				{
					type: 'toolCall',
					id: toolCallId,
					name: 'bash',
					arguments: args as Record<string, any>,
				},
			],
			// Synthetic provider-bookkeeping fields. No real provider was
			// involved in producing this turn; we use sentinel values that
			// don't pretend otherwise. pi-ai's providers don't read these
			// fields when transforming history for the next turn — they
			// only inspect content and stopReason.
			api: 'flue-shell',
			provider: 'flue',
			model: '',
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: 'toolUse',
			timestamp,
		};
		const toolResultMessage: ToolResultMessage = {
			role: 'toolResult',
			toolCallId,
			toolName: 'bash',
			content: toolResult.content as ToolResultMessage['content'],
			details: toolResult.details,
			isError,
			timestamp,
		};
		this.history.appendMessages(
			[userMessage, assistantMessage, toolResultMessage],
			'shell',
		);
		this.harness.state.messages = this.history.buildContext();
		await this.save();
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

	/**
	 * Shared body of `prompt()` and `skill()`: scope the runtime, optionally
	 * inject the result-tool pair, drive the harness, and aggregate usage.
	 *
	 * Returns `PromptResultResponse<T>` when `schema` is set, else `PromptResponse`.
	 */
	private async runPromptCall(args: {
		promptText: string;
		schema: v.GenericSchema | undefined;
		tools: ToolDef[] | undefined;
		commands: Command[] | undefined;
		role: string | undefined;
		model: string | undefined;
		thinkingLevel: ThinkingLevel | undefined;
		source: MessageSource;
		errorLabel: string;
		callSite: string;
		signal: AbortSignal;
	}): Promise<PromptResponse | PromptResultResponse<unknown>> {
		const role = this.resolveEffectiveRole(args.role);
		const resultBundle = args.schema ? createResultTools(args.schema) : undefined;
		const effectiveCommands = mergeCommands(this.agentCommands, args.commands);

		return this.withScopedRuntime(
			{
				commands: effectiveCommands,
				tools: args.tools ?? [],
				role,
				model: args.model,
				thinkingLevel: args.thinkingLevel,
				callSite: args.callSite,
				extraTools: resultBundle?.tools,
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
				const model: PromptModel = { id: resolvedModel.id };

				if (resultBundle) {
					const result = await this.runWithResultTools(
						args.promptText,
						resultBundle,
						beforeLength,
						args.source,
						args.errorLabel,
						args.signal,
					);
					return {
						result,
						usage: this.aggregateUsageSince(beforeLeafId),
						model,
					};
				}

				await this.harness.prompt(args.promptText);
				await this.harness.waitForIdle();
				await this.syncHarnessMessagesSince(beforeLength, args.source);
				await this.checkLatestAssistantForCompaction();
				this.throwIfError(args.errorLabel);

				return {
					text: this.getAssistantText(),
					usage: this.aggregateUsageSince(beforeLeafId),
					model,
				};
			},
		);
	}

	/**
	 * Drive the harness through one or more turns until the LLM either calls
	 * the `finish` tool (success) or the `give_up` tool (typed error).
	 *
	 * If a turn ends with neither tool called, we send a brief reminder and
	 * loop. There is no retry cap from the SDK's perspective: the model has a
	 * clear escape hatch via `give_up`, the user has cancellation via `signal`,
	 * and pi-agent-core has its own iteration limits as the final ceiling.
	 * `MAX_FOLLOWUPS` is a defense-in-depth ceiling against pathological loops.
	 *
	 * `beforeLength` is the harness-message-array length sampled by the caller
	 * *before* the very first prompt; we keep advancing it across iterations so
	 * `syncHarnessMessagesSince` only copies newly-produced messages each turn.
	 */
	private async runWithResultTools<T>(
		initialPrompt: string,
		bundle: ResultToolBundle<T>,
		beforeLength: number,
		source: MessageSource,
		errorLabel: string,
		signal: AbortSignal,
	): Promise<T> {
		let nextPrompt: string = initialPrompt;
		let cursor = beforeLength;
		const MAX_FOLLOWUPS = 32;
		for (let attempt = 0; attempt <= MAX_FOLLOWUPS; attempt++) {
			if (signal.aborted) throw abortErrorFor(signal);
			await this.harness.prompt(nextPrompt);
			await this.harness.waitForIdle();
			await this.syncHarnessMessagesSince(cursor, source);
			cursor = this.harness.state.messages.length;
			await this.checkLatestAssistantForCompaction();
			this.throwIfError(errorLabel);

			const outcome = bundle.getOutcome();
			if (outcome.type === 'finished') {
				return outcome.value;
			}
			if (outcome.type === 'gave_up') {
				throw new ResultUnavailableError(outcome.reason, this.getAssistantText());
			}
			// outcome.type === 'pending' → nudge the model and try again.
			nextPrompt = buildResultFollowUpPrompt();
			source = 'retry';
		}
		throw new ResultUnavailableError(
			`Agent did not call \`finish\` or \`give_up\` after ${MAX_FOLLOWUPS + 1} attempts.`,
			this.getAssistantText(),
		);
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

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
