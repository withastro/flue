/** Internal session implementation. Not exported publicly — wrapped by FlueSession. */

import type { AgentMessage, AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { Agent } from '@mariozechner/pi-agent-core';
import type {
	AssistantMessage,
	ImageContent,
	Model,
	ToolResultMessage,
	UserMessage,
} from '@mariozechner/pi-ai';
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
	type CompactionSettings,
	calculateContextTokens,
	compact,
	DEFAULT_COMPACTION_SETTINGS,
	deriveCompactionDefaults,
	isContextOverflow,
	prepareCompaction,
	shouldCompact,
} from './compaction.ts';
import { resolveSkillFilePath, skillsDirIn } from './context.ts';
import {
	buildPromptText,
	buildResultFollowUpPrompt,
	buildSkillByNamePrompt,
	buildSkillByPathPrompt,
	createResultTools,
	type ResultToolBundle,
	ResultUnavailableError,
} from './result.ts';
import {
	assertRoleExists,
	resolveEffectiveRole as resolveEffectiveRoleName,
	resolveRoleModel,
	resolveRoleThinkingLevel,
} from './roles.ts';
import { generateOperationId } from './runtime/ids.ts';
import { getProviderConfiguration, getRegisteredApiKey } from './runtime/providers.ts';
import { createFlueFs } from './sandbox.ts';

import type {
	AgentConfig,
	BranchSummaryEntry,
	CallHandle,
	CompactionEntry,
	FlueEvent,
	FlueEventCallback,
	FlueFs,
	FlueSession,
	MessageEntry,
	PromptModel,
	PromptOptions,
	PromptResponse,
	PromptResultResponse,
	PromptUsage,
	SessionData,
	SessionEntry,
	SessionEnv,
	SessionStore,
	ShellOptions,
	ShellResult,
	SkillOptions,
	TaskOptions,
	ThinkingLevel,
	ToolDef,
} from './types.ts';
import { addUsage, emptyUsage, fromProviderUsage } from './usage.ts';

const MAX_TASK_DEPTH = 4;

export interface CreateTaskSessionOptions {
	parentSession: string;
	taskId: string;
	parentEnv: SessionEnv;
	cwd?: string;
	role?: string;
	depth: number;
}

export type CreateTaskSession = (options: CreateTaskSessionOptions) => Promise<Session>;

type OperationKind = 'prompt' | 'skill' | 'task' | 'shell' | 'compact';

interface SessionInitOptions {
	name: string;
	storageKey: string;
	affinityKey: string;
	config: AgentConfig;
	env: SessionEnv;
	store: SessionStore;
	existingData: SessionData | null;
	onAgentEvent?: FlueEventCallback;
	agentTools?: ToolDef[];
	sessionRole?: string;
	taskDepth?: number;
	createTaskSession?: CreateTaskSession;
	onDelete?: () => void;
}

// TODO: rename `RuntimeScopeOptions` → `CallOverrides` and `withScopedRuntime`
// → `withCallOverrides`. The "scope" name is a vestige from when this also
// built a fresh just-bash env with per-call `commands` registered. With
// `commands` removed, this is just per-call overrides on top of agent-wide
// defaults — the name no longer reflects what it does.
interface RuntimeScopeOptions {
	tools: ToolDef[];
	role?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	callSite: string;
	/**
	 * Framework-injected pi-agent-core tools spliced in alongside builtins and custom
	 * tools for the duration of this call. Used by the result-schema flow to
	 * inject `finish` and `give_up`.
	 */
	extraTools?: AgentTool<any>[];
}

interface InternalTaskResult<T> {
	output: T;
	text: string;
	taskId: string;
	session: string;
	messageId?: string;
	role?: string;
	cwd?: string;
}

/**
 * Read the per-call result schema option, accepting both the canonical
 * `result` field and the deprecated `schema` alias.
 */
function resolveResultOption(
	options: { result?: v.GenericSchema; schema?: v.GenericSchema } | undefined,
): v.GenericSchema | undefined {
	if (!options) return undefined;
	if (options.result !== undefined) return options.result;
	return options.schema;
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

export type MessageSource = MessageEntry['source'];

export interface ContextEntry {
	message: AgentMessage;
	entry?: SessionEntry;
}

export interface CompactionAppendInput {
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	details?: { readFiles: string[]; modifiedFiles: string[] };
	usage?: PromptUsage;
}

export class SessionHistory {
	private entries: SessionEntry[];
	private byId: Map<string, SessionEntry>;
	private leafId: string | null;

	private constructor(entries: SessionEntry[], leafId: string | null) {
		this.entries = [...entries];
		this.leafId = leafId;
		this.byId = new Map(this.entries.map((entry) => [entry.id, entry]));
	}

	static empty(): SessionHistory {
		return new SessionHistory([], null);
	}

	static fromData(data: SessionData | null): SessionHistory {
		if (!data) return SessionHistory.empty();
		return new SessionHistory(data.entries, data.leafId);
	}

	getLeafId(): string | null {
		return this.leafId;
	}

	getActivePath(): SessionEntry[] {
		const path: SessionEntry[] = [];
		let current = this.leafId ? this.byId.get(this.leafId) : undefined;
		while (current) {
			path.push(current);
			current = current.parentId ? this.byId.get(current.parentId) : undefined;
		}
		return path.reverse();
	}

	/**
	 * Active-path entries appended after `afterLeafId` (exclusive), in order.
	 *
	 * - `afterLeafId === null` means "from the start of the path" → returns
	 *   the entire active path.
	 * - When the id is found, returns entries strictly after it.
	 * - When the id is *not* on the current active path (e.g. a branch
	 *   switch happened mid-window), returns `[]`. Callers use this for
	 *   bounded windowing — falling back to the full path would silently
	 *   include unrelated history. An empty result is the safer answer
	 *   for usage aggregation: zero is loud (sums won't match expectations)
	 *   while full-history is silent overcounting.
	 */
	getActivePathSince(afterLeafId: string | null): SessionEntry[] {
		const path = this.getActivePath();
		if (afterLeafId === null) return path;
		const startIndex = path.findIndex((entry) => entry.id === afterLeafId);
		if (startIndex === -1) return [];
		return path.slice(startIndex + 1);
	}

	buildContextEntries(): ContextEntry[] {
		const path = this.getActivePath();
		const latestCompactionIndex = findLatestCompactionIndex(path);
		if (latestCompactionIndex === -1) {
			return pathToContextEntries(path);
		}

		const compaction = path[latestCompactionIndex] as CompactionEntry;
		const firstKeptIndex = path.findIndex((entry) => entry.id === compaction.firstKeptEntryId);
		const keptStart = firstKeptIndex >= 0 ? firstKeptIndex : latestCompactionIndex + 1;
		const context: ContextEntry[] = [
			{ message: createContextSummaryMessage(compaction.summary, compaction.timestamp), entry: compaction },
		];
		context.push(...pathToContextEntries(path.slice(keptStart, latestCompactionIndex)));
		context.push(...pathToContextEntries(path.slice(latestCompactionIndex + 1)));
		return context;
	}

	buildContext(): AgentMessage[] {
		return this.buildContextEntries().map((entry) => entry.message);
	}

	getLatestCompaction(): CompactionEntry | undefined {
		const path = this.getActivePath();
		for (let i = path.length - 1; i >= 0; i--) {
			const entry = path[i]!;
			if (entry.type === 'compaction') return entry;
		}
		return undefined;
	}

	appendMessage(message: AgentMessage, source?: MessageSource): string {
		const entry: MessageEntry = {
			type: 'message',
			id: generateEntryId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			message,
			source,
		};
		this.appendEntry(entry);
		return entry.id;
	}

	appendMessages(messages: AgentMessage[], source?: MessageSource): string[] {
		return messages.map((message) => this.appendMessage(message, source));
	}

	appendCompaction(input: CompactionAppendInput): string {
		if (!this.byId.has(input.firstKeptEntryId)) {
			throw new Error(`[flue] Cannot compact: entry "${input.firstKeptEntryId}" does not exist.`);
		}
		const entry: CompactionEntry = {
			type: 'compaction',
			id: generateEntryId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			summary: input.summary,
			firstKeptEntryId: input.firstKeptEntryId,
			tokensBefore: input.tokensBefore,
			details: input.details,
			usage: input.usage,
		};
		this.appendEntry(entry);
		return entry.id;
	}

	appendBranchSummary(summary: string, fromId: string, details?: unknown): string {
		const entry: BranchSummaryEntry = {
			type: 'branch_summary',
			id: generateEntryId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			fromId,
			summary,
			details,
		};
		this.appendEntry(entry);
		return entry.id;
	}

	removeLeafMessage(message: AgentMessage): boolean {
		if (!this.leafId) return false;
		const leaf = this.byId.get(this.leafId);
		if (!leaf || leaf.type !== 'message' || leaf.message !== message) return false;
		this.byId.delete(leaf.id);
		this.entries = this.entries.filter((entry) => entry.id !== leaf.id);
		this.leafId = leaf.parentId;
		return true;
	}

	toData(metadata: Record<string, any>, createdAt: string, updatedAt: string): SessionData {
		return {
			version: 3,
			entries: [...this.entries],
			leafId: this.leafId,
			metadata,
			createdAt,
			updatedAt,
		};
	}

	private appendEntry(entry: SessionEntry): void {
		this.entries.push(entry);
		this.byId.set(entry.id, entry);
		this.leafId = entry.id;
	}
}

function pathToContextEntries(path: SessionEntry[]): ContextEntry[] {
	const context: ContextEntry[] = [];
	for (const entry of path) {
		if (entry.type === 'message') {
			context.push({ message: entry.message, entry });
		} else if (entry.type === 'branch_summary') {
			context.push({ message: createUserContextMessage(`[Branch Summary]\n\n${entry.summary}`, entry.timestamp), entry });
		}
	}
	return context;
}

function findLatestCompactionIndex(path: SessionEntry[]): number {
	for (let i = path.length - 1; i >= 0; i--) {
		if (path[i]!.type === 'compaction') return i;
	}
	return -1;
}

function createContextSummaryMessage(summary: string, timestamp: string): AgentMessage {
	const text = summary.startsWith('[Context Summary]') ? summary : `[Context Summary]\n\n${summary}`;
	return createUserContextMessage(text, timestamp);
}

function createUserContextMessage(text: string, timestamp: string): AgentMessage {
	return {
		role: 'user',
		content: [{ type: 'text', text }],
		timestamp: new Date(timestamp).getTime(),
	} as UserMessage as AgentMessage;
}

function generateEntryId(byId: Map<string, SessionEntry>): string {
	for (let i = 0; i < 100; i++) {
		const id = crypto.randomUUID().slice(0, 8);
		if (!byId.has(id)) return id;
	}
	return crypto.randomUUID();
}

export class Session implements FlueSession {
	readonly name: string;
	readonly fs: FlueFs;
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
	private overflowRecoveryAttempted = false;
	private compactionAbortController: AbortController | undefined;
	private eventCallback: FlueEventCallback | undefined;
	private agentTools: ToolDef[];
	private deleted = false;
	private activeOperation: OperationKind | undefined;
	private activeOperationId: string | undefined;
	private toolStartTimes = new Map<string, number>();
	private turnStartTime: number | undefined;
	private activeTasks = new Set<Session>();
	private sessionRole: string | undefined;
	private taskDepth: number;
	private createTaskSession: CreateTaskSession | undefined;
	private onDelete: (() => void) | undefined;

	constructor(options: SessionInitOptions) {
		this.name = options.name;
		this.storageKey = options.storageKey;
		this.config = options.config;
		this.env = options.env;
		this.fs = createFlueFs(options.env);
		this.store = options.store;
		this.agentTools = options.agentTools ?? [];
		this.sessionRole = options.sessionRole;
		this.taskDepth = options.taskDepth ?? 0;
		this.createTaskSession = options.createTaskSession;
		this.onDelete = options.onDelete;

		this.metadata = options.existingData?.metadata ?? {};
		this.createdAt = options.existingData?.createdAt;

		this.history = SessionHistory.fromData(options.existingData);

		const systemPrompt = this.config.systemPrompt;

		assertRoleExists(this.config.roles, this.config.role);
		assertRoleExists(this.config.roles, this.sessionRole);

		const tools = [
			...this.createBuiltinTools(this.env, []),
			...this.createCustomTools(this.agentTools),
		];

		const previousMessages = this.history.buildContext();

		this.harness = new Agent({
			initialState: {
				systemPrompt,
				model: this.config.model,
				tools,
				messages: previousMessages,
				thinkingLevel: this.config.thinkingLevel ?? 'medium',
			},
			getApiKey: (provider) => this.getProviderApiKey(provider),
			onPayload: (payload, model) => this.applyProviderPayloadOverrides(payload, model),
			toolExecution: 'parallel',
			sessionId: options.affinityKey,
		});

		this.eventCallback = options.onAgentEvent;
		this.harness.subscribe(async (event) => {
			switch (event.type) {
				case 'agent_start':
					// pi-agent-core lifecycle event; not part of Flue's wire vocabulary.
					break;
				case 'turn_start':
					this.turnStartTime = Date.now();
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
					this.toolStartTimes.set(event.toolCallId, Date.now());
					this.emit({
						type: 'tool_start',
						toolName: event.toolName,
						toolCallId: event.toolCallId,
						args: event.args,
					});
					break;
				case 'tool_execution_end':
					this.emit({
						type: 'tool_call',
						toolName: event.toolName,
						toolCallId: event.toolCallId,
						isError: event.isError,
						result: event.result,
						durationMs: durationSince(this.toolStartTimes.get(event.toolCallId)),
					});
					this.toolStartTimes.delete(event.toolCallId);
					break;
				case 'turn_end': {
					const message = event.message;
					const assistant = message.role === 'assistant' ? (message as AssistantMessage) : undefined;
					this.emit({
						type: 'turn',
						durationMs: durationSince(this.turnStartTime),
						model: assistant?.model,
						usage: fromProviderUsage(assistant?.usage),
						stopReason: assistant?.stopReason,
						isError: assistant?.stopReason === 'error' || assistant?.stopReason === 'aborted',
						error: assistant?.errorMessage,
					});
					this.turnStartTime = undefined;
					break;
				}
				case 'agent_end':
					break;
			}
		});
	}

	private resolveCompactionSettings(model: Model<any> | undefined): CompactionSettings {
		const cc = this.config.compaction;
		const defaults = model
			? deriveCompactionDefaults({
					contextWindow: model.contextWindow ?? 0,
					maxTokens: model.maxTokens ?? 0,
				})
			: DEFAULT_COMPACTION_SETTINGS;
		if (cc === false) {
			return { ...defaults, enabled: false };
		}
		if (!cc) {
			return defaults;
		}
		return {
			enabled: true,
			reserveTokens: cc.reserveTokens ?? defaults.reserveTokens,
			keepRecentTokens: cc.keepRecentTokens ?? defaults.keepRecentTokens,
		};
	}

	prompt<S extends v.GenericSchema>(
		text: string,
		options: PromptOptions<S> & { result: S },
	): CallHandle<PromptResultResponse<v.InferOutput<S>>>;
	prompt<S extends v.GenericSchema>(
		text: string,
		options: PromptOptions<S> & { schema: S },
	): CallHandle<PromptResultResponse<v.InferOutput<S>>>;
	prompt(text: string, options?: PromptOptions): CallHandle<PromptResponse>;
	prompt(text: string, options?: PromptOptions<v.GenericSchema | undefined>): CallHandle<any> {
		return createCallHandle(options?.signal, (signal) =>
			this.runOperation('prompt', signal, async () => {
				const schema = resolveResultOption(options);
				return this.runPromptCall({
					promptText: buildPromptText(text, schema),
					schema,
					tools: options?.tools,
					role: options?.role,
					model: options?.model,
					thinkingLevel: options?.thinkingLevel,
					images: options?.images,
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
	skill<S extends v.GenericSchema>(
		name: string,
		options: SkillOptions<S> & { schema: S },
	): CallHandle<PromptResultResponse<v.InferOutput<S>>>;
	skill(name: string, options?: SkillOptions): CallHandle<PromptResponse>;
	skill(name: string, options?: SkillOptions<v.GenericSchema | undefined>): CallHandle<any> {
		return createCallHandle(options?.signal, (signal) =>
			this.runOperation('skill', signal, async () => {
				// Registered skill names and relative skill paths use different prompts.
				const looksLikePath = name.includes('/') || /\.(md|markdown)$/i.test(name);
				const schema = resolveResultOption(options);

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
					role: options?.role,
					model: options?.model,
					thinkingLevel: options?.thinkingLevel,
					images: options?.images,
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
	task<S extends v.GenericSchema>(
		text: string,
		options: TaskOptions<S> & { schema: S },
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
				const toolCallId = crypto.randomUUID();
				const toolStartMs = Date.now();

				// Per-call cwd/env names, when set, are part of the call's
				// identity and need to be visible in the transcript. Env
				// values often contain credentials, so transcript/tool events
				// record only the keys while env.exec receives the real values.
				// The bash tool's own schema (BashParams) doesn't formally
				// declare these, but pi-ai's ToolCall.arguments is
				// `Record<string, any>` and providers forward arguments
				// opaquely, so extending the shape here is safe.
				const args: Record<string, unknown> = { command };
				if (options?.cwd !== undefined) args.cwd = options.cwd;
				if (options?.env !== undefined) args.env = redactEnvValues(options.env);

				this.emit({ type: 'tool_start', toolName: 'bash', toolCallId, args });

				try {
					const result = await this.env.exec(command, {
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
						type: 'tool_call',
						toolName: 'bash',
						toolCallId,
						isError: false,
						result: toolResult,
						durationMs: durationSince(toolStartMs),
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
						type: 'tool_call',
						toolName: 'bash',
						toolCallId,
						isError: true,
						result: errResult,
						durationMs: durationSince(toolStartMs),
					});
					throw error;
				}
			}),
		);
	}

	async compact(): Promise<void> {
		await this.runOperation('compact', undefined, async () => {
			await this.runCompaction('manual', false);
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
			model = this.config.resolveModel(roleModel);
		}

		if (promptModel) {
			model = this.config.resolveModel(promptModel);
		}

		return this.requireModel(model, callSite);
	}

	/** Precedence: call-level > role-level > agent-level default > 'medium'. */
	private resolveThinkingLevelForCall(
		callValue: ThinkingLevel | undefined,
		roleName: string | undefined,
	): ThinkingLevel {
		if (callValue !== undefined) return callValue;
		const roleLevel = resolveRoleThinkingLevel(this.config.roles, roleName);
		if (roleLevel !== undefined) return roleLevel;
		return this.config.thinkingLevel ?? 'medium';
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
		// Explicit provider configuration overrides apiKeys carried by registered
		// provider templates. Undefined falls through to pi-ai's env-var lookup.
		const override = getProviderConfiguration(provider)?.apiKey;
		if (override !== undefined) return override;
		return getRegisteredApiKey(provider);
	}

	/**
	 * Provider-specific payload overrides. Returning undefined keeps the
	 * upstream-built payload as-is.
	 */
	private applyProviderPayloadOverrides(payload: unknown, model: Model<any>): unknown {
		if (model.api !== 'openai-responses' && model.api !== 'azure-openai-responses') {
			return undefined;
		}
		const settings = getProviderConfiguration(model.provider);
		if (settings?.storeResponses !== true) {
			return undefined;
		}
		return { ...(payload as Record<string, unknown>), store: true };
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
		tools: ToolDef[],
		role?: string,
		model?: string,
		thinkingLevel?: ThinkingLevel,
	): AgentTool<any>[] {
		return createTools(env, {
			roles: this.config.roles,
			task: (params, signal) =>
				this.runTaskForTool(params, tools, role, model, thinkingLevel, signal),
		});
	}

	private async withScopedRuntime<T>(
		options: RuntimeScopeOptions,
		fn: (ctx: { resolvedModel: Model<any> }) => Promise<T>,
	): Promise<T> {
		const customTools = this.createCustomTools([...this.agentTools, ...options.tools]);
		const previousTools = this.harness.state.tools;
		const previousModel = this.harness.state.model;
		const previousSystemPrompt = this.harness.state.systemPrompt;
		const previousThinkingLevel = this.harness.state.thinkingLevel;

		const resolvedModel = this.resolveModelForCall(options.model, options.role, options.callSite);
		this.harness.state.model = resolvedModel;
		this.harness.state.systemPrompt = this.buildSystemPrompt(options.role);
		this.harness.state.thinkingLevel = this.resolveThinkingLevelForCall(
			options.thinkingLevel,
			options.role,
		);
		this.harness.state.tools = [
			...this.createBuiltinTools(
				this.env,
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
				tools,
			},
			signal,
		);

		return {
			content: [{ type: 'text', text: result.text || '(task completed with no text)' }],
				details: {
					taskId: result.taskId,
					session: result.session,
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
		return this.runExclusive('task', async () => {
			if (signal?.aborted) throw abortErrorFor(signal);
			this.activeOperationId = generateOperationId();
			const operationId = this.activeOperationId;
			const startedAt = Date.now();
			this.emit({ type: 'operation_start', operationId, operationKind: 'task' });
			try {
				const result = await this.runTaskExclusive(text, options, signal);
				this.emit({
					type: 'operation',
					operationId,
					operationKind: 'task',
					durationMs: durationSince(startedAt),
					isError: false,
					result: result.output,
					usage: usageFromResult(result.output),
				});
				return result;
			} catch (error) {
				const surfaced = signal?.aborted ? abortErrorFor(signal) : error;
				this.emit({
					type: 'operation',
					operationId,
					operationKind: 'task',
					durationMs: durationSince(startedAt),
					isError: true,
					error: serializeError(surfaced),
				});
				throw surfaced;
			} finally {
				this.emit({ type: 'idle' });
				this.activeOperationId = undefined;
			}
		});
	}

	private async runTaskExclusive<S extends v.GenericSchema | undefined>(
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
			parentSession: this.name,
		});
		const taskStartMs = Date.now();

		try {
			const role = this.resolveEffectiveRole(options?.role);

			child = await this.createTaskSession({
				parentSession: this.name,
				taskId,
				parentEnv: this.env,
				cwd: options?.cwd,
				role,
				depth: this.taskDepth + 1,
			});
			await this.recordTaskSession(child.name, child.storageKey, taskId);
			this.activeTasks.add(child);

			// Aborts during sandbox bring-up — child.prompt's own
			// runOperation handles the in-flight case.
			if (signal) {
				abortListener = () => child?.abort();
				signal.addEventListener('abort', abortListener, { once: true });
			}

			const schema = resolveResultOption(options);
			const roleModel = resolveRoleModel(this.config.roles, role);
			const roleThinkingLevel = resolveRoleThinkingLevel(this.config.roles, role);
			const childOptions: PromptOptions<v.GenericSchema | undefined> = {
				model: options?.model ?? (roleModel ? undefined : options?.inheritedModel),
				thinkingLevel:
					options?.thinkingLevel ??
					(roleThinkingLevel !== undefined ? undefined : options?.inheritedThinkingLevel),
				tools: options?.tools,
				images: options?.images,
				signal,
			};
			if (schema) childOptions.result = schema;

			const output: any = await child.prompt(text, childOptions as any);
			const taskResult: InternalTaskResult<any> = {
				output,
				text: typeof output?.text === 'string' ? output.text : child.getAssistantText(),
				taskId,
				session: child.name,
				messageId: child.getLatestAssistantMessageId(),
				role,
				cwd: options?.cwd,
			};
			this.emit({
				type: 'task',
				taskId,
				isError: false,
				result: taskResult.text,
				durationMs: durationSince(taskStartMs),
				parentSession: this.name,
			});
			return taskResult;
		} catch (error) {
			this.emit({
				type: 'task',
				taskId,
				isError: true,
				result: getErrorMessage(error),
				durationMs: durationSince(taskStartMs),
				parentSession: this.name,
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
		operation: OperationKind,
		signal: AbortSignal | undefined,
		fn: () => Promise<T>,
	): Promise<T> {
		return this.runExclusive(operation, async () => {
			if (signal?.aborted) throw abortErrorFor(signal);
			this.activeOperationId = generateOperationId();
			const operationId = this.activeOperationId;
			const startedAt = Date.now();
			this.emit({ type: 'operation_start', operationId, operationKind: operation });

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
				const result = await fn();
				this.emit({
					type: 'operation',
					operationId,
					operationKind: operation,
					durationMs: durationSince(startedAt),
					isError: false,
					result,
					usage: usageFromResult(result),
				});
				return result;
			} catch (error) {
				// Normalize post-abort fallout to a single AbortError for callers.
				const surfaced = signal?.aborted ? abortErrorFor(signal) : error;
				this.emit({
					type: 'operation',
					operationId,
					operationKind: operation,
					durationMs: durationSince(startedAt),
					isError: true,
					error: serializeError(surfaced),
				});
				throw surfaced;
			} finally {
				signal?.removeEventListener('abort', onAbort);
				this.emit({ type: 'idle' });
				this.activeOperationId = undefined;
			}
		});
	}

	private async runExclusive<T>(operation: OperationKind, fn: () => Promise<T>): Promise<T> {
		this.assertActive();
		if (this.activeOperation) {
			throw new Error(
				`[flue] Session "${this.name}" is already running ${this.activeOperation}. ` +
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
		const decorated = {
			...event,
			session: event.session ?? this.name,
		};
		const operationId = event.operationId ?? this.activeOperationId;
		if (operationId !== undefined) decorated.operationId = operationId;
		this.eventCallback?.(decorated);
	}

	private assertActive(): void {
		if (this.deleted) {
			throw new Error(`[flue] Session "${this.name}" has been deleted.`);
		}
	}

	/** Append a `session.shell()` call as an LLM-shaped bash tool exchange. */
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
		this.history.appendMessages([userMessage, assistantMessage, toolResultMessage], 'shell');
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
		session: string,
		storageKey: string,
		taskId: string,
	): Promise<void> {
		const taskSessions = Array.isArray(this.metadata.taskSessions)
			? this.metadata.taskSessions
			: [];
		if (!taskSessions.some((task) => task?.session === session)) {
			taskSessions.push({ session, taskId, storageKey });
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
		if (assistantMessage.stopReason === 'aborted') return;

		const model = this.harness.state.model;
		const settings = this.resolveCompactionSettings(model);
		const contextWindow = model.contextWindow ?? 0;
		const overflow = isContextOverflow(assistantMessage, contextWindow);

		if (overflow) {
			if (this.overflowRecoveryAttempted) return;
			this.overflowRecoveryAttempted = true;

			this.internalLog('info', '[flue:compaction] Overflow detected, compacting and retrying...');

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
		if (!settings.enabled) return;
		if (assistantMessage.stopReason === 'error') return;

		const contextTokens = calculateContextTokens(assistantMessage.usage);

		if (shouldCompact(contextTokens, contextWindow, settings)) {
			this.internalLog(
				'info',
				`[flue:compaction] Threshold reached — ${contextTokens} tokens used, ` +
					`window ${contextWindow}, reserve ${settings.reserveTokens}, ` +
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
	private async runCompaction(
		reason: 'threshold' | 'overflow' | 'manual',
		willRetry: boolean,
	): Promise<void> {
		this.compactionAbortController = new AbortController();
		const messagesBefore = this.harness.state.messages.length;
		const compactionStartMs = Date.now();

		try {
			const sessionModel = this.harness.state.model;
			const settings = this.resolveCompactionSettings(sessionModel);
			// Summarization may use a cheaper or stronger model than the active
			// session model, but the cut point still uses the active model's window.
			const compactionConfig =
				this.config.compaction === false ? undefined : this.config.compaction;
			const summarizationModel = compactionConfig?.model
				? (this.config.resolveModel(compactionConfig.model) ?? sessionModel)
				: sessionModel;

			const contextEntries = this.history.buildContextEntries();
			const messages = contextEntries.map((entry) => entry.message);
			const latestCompaction = this.history.getLatestCompaction();

			const preparation = prepareCompaction(
				messages,
				settings,
				latestCompaction
					? {
							summary: latestCompaction.summary,
							firstKeptIndex: 1,
							details: latestCompaction.details,
						}
					: undefined,
			);
			if (!preparation) {
				this.internalLog('info', '[flue:compaction] Nothing to compact (no valid cut point found)');
				return;
			}
			const firstKeptEntry = contextEntries[preparation.firstKeptIndex]?.entry;
			if (!firstKeptEntry || firstKeptEntry.type !== 'message') {
				this.internalLog('info', '[flue:compaction] Nothing to compact (first kept message has no entry)');
				return;
			}

			this.internalLog(
				'info',
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
				summarizationModel,
				this.getProviderApiKey(summarizationModel.provider),
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
			this.internalLog(
				'info',
				`[flue:compaction] Complete — messages: ${messagesBefore} → ${messagesAfter}, ` +
					`tokens before: ${result.tokensBefore}`,
			);

			this.emit({
				type: 'compaction',
				messagesBefore,
				messagesAfter,
				durationMs: durationSince(compactionStartMs),
				usage: result.usage,
			});

			await this.save();

			if (willRetry) {
				const msgs = this.harness.state.messages;
				const lastMsg = msgs[msgs.length - 1];
				if (lastMsg?.role === 'assistant' && (lastMsg as AssistantMessage).stopReason === 'error') {
					this.harness.state.messages = msgs.slice(0, -1);
				}
				this.internalLog('info', '[flue:compaction] Retrying after overflow recovery...');
				const beforeRetry = this.harness.state.messages.length;
				await this.harness.continue();
				await this.harness.waitForIdle();
				await this.syncHarnessMessagesSince(beforeRetry, 'retry');
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.internalLog('error', `[flue:compaction] Failed: ${errorMessage}`, { error });
		} finally {
			this.compactionAbortController = undefined;
		}
	}

	private internalLog(
		level: 'info' | 'warn' | 'error',
		message: string,
		attributes?: Record<string, unknown>,
	): void {
		console.error(message);
		this.emit({ type: 'log', level, message, attributes: normalizeLogAttributes(attributes) });
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
	 * Returns `PromptResultResponse<T>` when a result schema is set, else `PromptResponse`.
	 */
	private async runPromptCall(args: {
		promptText: string;
		schema: v.GenericSchema | undefined;
		tools: ToolDef[] | undefined;
		role: string | undefined;
		model: string | undefined;
		thinkingLevel: ThinkingLevel | undefined;
		images: ImageContent[] | undefined;
		source: MessageSource;
		errorLabel: string;
		callSite: string;
		signal: AbortSignal;
		// The result-schema branch returns the public `PromptResultResponse<unknown>`
		// shape (`data` + `usage` + `model`) plus a deprecated `result` alias
		// that the public type marks as `never`. We widen the internal return
		// type with `Omit<…, 'result'> & { result: unknown }` so the runtime
		// can populate the alias without TS rejecting the assignment.
	}): Promise<
		| PromptResponse
		| (Omit<PromptResultResponse<unknown>, 'result'> & { result: unknown })
	> {
		const role = this.resolveEffectiveRole(args.role);
		const resultBundle = args.schema ? createResultTools(args.schema) : undefined;

		return this.withScopedRuntime(
			{
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
						args.images,
					);
					// `result` is the deprecated alias for `data`. Both keys carry
					// the same value during the deprecation window so existing
					// callers keep working at runtime; the public type marks
					// `result` as `never` so TypeScript flags new usage.
					return {
						data: result,
						result,
						usage: this.aggregateUsageSince(beforeLeafId),
						model,
					};
				}

				await this.harness.prompt(args.promptText, args.images);
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
	 * loop. There is no retry cap from the framework's perspective: the model has a
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
		initialImages?: ImageContent[],
	): Promise<T> {
		let nextPrompt: string = initialPrompt;
		let cursor = beforeLength;
		const MAX_FOLLOWUPS = 32;
		for (let attempt = 0; attempt <= MAX_FOLLOWUPS; attempt++) {
			if (signal.aborted) throw abortErrorFor(signal);
			// Images attach only on the first turn — retry follow-ups carry text
			// only, so we don't re-bill image bytes on every result-tool retry.
			await this.harness.prompt(nextPrompt, attempt === 0 ? initialImages : undefined);
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

function serializeError(error: unknown): unknown {
	if (error instanceof Error) {
		return { name: error.name, message: error.message };
	}
	return error;
}

function normalizeLogAttributes(
	attributes: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	if (!attributes) return undefined;
	if (!(attributes.error instanceof Error)) return attributes;
	return { ...attributes, error: serializeError(attributes.error) };
}

function durationSince(start: number | undefined): number {
	return start === undefined ? 0 : Date.now() - start;
}

function usageFromResult(result: unknown): PromptUsage | undefined {
	if (typeof result !== 'object' || result === null) return undefined;
	const usage = (result as { usage?: unknown }).usage;
	return isPromptUsage(usage) ? usage : undefined;
}

function isPromptUsage(value: unknown): value is PromptUsage {
	return (
		typeof value === 'object' &&
		value !== null &&
		typeof (value as PromptUsage).input === 'number' &&
		typeof (value as PromptUsage).output === 'number' &&
		typeof (value as PromptUsage).totalTokens === 'number'
	);
}

function redactEnvValues(env: Record<string, string>): Record<string, string> {
	return Object.fromEntries(Object.keys(env).map((key) => [key, '<redacted>']));
}
