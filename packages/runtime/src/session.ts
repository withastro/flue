/** Internal session implementation. Not exported publicly — wrapped by FlueSession. */

import type {
	AgentMessage,
	AgentTool,
	AgentToolResult,
	StreamFn,
} from '@earendil-works/pi-agent-core';
import { Agent } from '@earendil-works/pi-agent-core';
import type {
	AssistantMessage,
	ImageContent,
	Message,
	Model,
	ToolResultMessage,
	UserMessage,
} from '@earendil-works/pi-ai';
import { streamSimple } from '@earendil-works/pi-ai';
import type * as v from 'valibot';
import { abortErrorFor, createCallHandle } from './abort.ts';
import {
	createActivateSkillTool,
	createPackagedSkillReadTool,
	createTaskTool,
	createTools,
	formatBashResult,
	type TaskToolParams,
	type TaskToolResultDetails,
} from './agent.ts';
import {
	DURABILITY_DEFAULT_MAX_RETRY,
	DURABILITY_DEFAULT_TIMEOUT_MINUTES,
	type AgentSubmissionStore,
	type SubmissionDurability,
} from './agent-execution-store.ts';
import {
	type CompactionSettings,
	type CompactionTurnHandle,
	calculateContextTokens,
	compact,
	DEFAULT_COMPACTION_SETTINGS,
	deriveCompactionDefaults,
	isContextOverflow,
	prepareCompaction,
	shouldCompact,
} from './compaction.ts';
import { isWorkspaceSkill, skillsDirIn } from './context.ts';
import {
	buildPackagedSkillPrompt,
	buildPromptText,
	buildResultFollowUpPrompt,
	buildSkillByPathlessNamePrompt,
	buildWorkspaceSkillPrompt,
	createResultTools,
	type ResultToolBundle,
	ResultUnavailableError,
} from './result.ts';
import type {
	AgentSubmissionInput,
	AgentSubmissionInspection,
	AgentSubmissionInterruption,
	DirectAgentSubmissionInput,
	ProcessAgentSubmissionOptions,
} from './runtime/agent-submissions.ts';
import { agentSubmissionDispatchInput } from './runtime/agent-submissions.ts';
import { reconstructInterruptedStream, StreamChunkWriter } from './runtime/stream-chunks.ts';
import type { DispatchInput } from './runtime/dispatch-queue.ts';
import { generateOperationId, generateTurnId } from './runtime/ids.ts';
import { getProviderConfiguration, getRegisteredApiKey } from './runtime/providers.ts';
import { createFlueFs } from './sandbox.ts';
import {
	SessionHistory,
	createUserContextMessage,
	renderSignalMessage,
	type MessageSource,
} from './session-history.ts';
import { childTaskSessionStorageKey } from './session-identity.ts';
import type {
	AgentConfig,
	AgentProfile,
	CallHandle,
	DispatchMessageMetadata,
	FlueEvent,
	FlueEventCallback,
	FlueFs,
	FlueSession,
	MessageEntry,
	PackagedSkillDirectory,
	PromptModel,
	PromptOptions,
	PromptResponse,
	PromptResultResponse,
	PromptUsage,
	SessionData,
	SessionEntry,
	SessionEnv,
	SessionStore,
	SessionToolFactory,
	ShellOptions,
	ShellResult,
	SignalMessage,
	SkillOptions,
	SkillReference,
	TaskOptions,
	ThinkingLevel,
	ToolDefinition,
} from './types.ts';
import { addUsage, emptyUsage, fromProviderUsage } from './usage.ts';

export { SessionHistory } from './session-history.ts';
export type { MessageSource } from './session-history.ts';

const MAX_TASK_DEPTH = 4;
const MAX_TRANSIENT_MODEL_RETRIES = 3;
const TRANSIENT_MODEL_RETRY_BASE_DELAY_MS = 2_000;

type TurnInputMessage = Extract<FlueEvent, { type: 'turn_request' }>['input']['messages'][number];
type TurnInputTool = NonNullable<
	Extract<FlueEvent, { type: 'turn_request' }>['input']['tools']
>[number];
type TurnOutput = NonNullable<Extract<FlueEvent, { type: 'turn' }>['output']>;
type ProviderTextOrImageContent = Exclude<UserMessage['content'], string>[number];
type ProviderContentBlock =
	| ProviderTextOrImageContent
	| AssistantMessage['content'][number]
	| ToolResultMessage['content'][number];
type TurnUserContent = Exclude<
	Extract<TurnInputMessage, { role: 'user' }>['content'],
	string
>[number];
type TurnAssistantContent = Extract<TurnInputMessage, { role: 'assistant' }>['content'][number];
type TurnToolResultContent = Extract<TurnInputMessage, { role: 'toolResult' }>['content'][number];
type TurnContent = TurnUserContent | TurnAssistantContent | TurnToolResultContent;

function toTurnMessage(message: AgentMessage): TurnInputMessage {
	if (message.role === 'signal') {
		return {
			role: 'user',
			content: renderSignalMessage(message),
		};
	}
	if (message.role === 'user') {
		return {
			role: 'user',
			content:
				typeof message.content === 'string'
					? message.content
					: (message.content.map(toTurnContent) as TurnUserContent[]),
		};
	}
	if (message.role === 'assistant') {
		return {
			role: 'assistant',
			content: message.content.map(toTurnContent) as TurnAssistantContent[],
		};
	}
	if (message.role === 'toolResult') {
		return {
			role: 'toolResult',
			toolCallId: message.toolCallId,
			toolName: message.toolName,
			content: message.content.map(toTurnContent) as TurnToolResultContent[],
			isError: message.isError,
		};
	}
	throw new Error(`[flue] Unsupported message role in turn context: ${message.role}`);
}

function toTurnContent(block: ProviderContentBlock): TurnContent {
	if (block.type === 'text') {
		return { type: 'text', text: block.text, textSignature: block.textSignature };
	}
	if (block.type === 'image') {
		return { type: 'image', data: block.data, mimeType: block.mimeType };
	}
	if (block.type === 'thinking') {
		return {
			type: 'thinking',
			thinking: block.thinking,
			thinkingSignature: block.thinkingSignature,
			redacted: block.redacted,
		};
	}
	return {
		type: 'toolCall',
		id: block.id,
		name: block.name,
		arguments: block.arguments,
		thoughtSignature: block.thoughtSignature,
	};
}

export interface CreateTaskSessionOptions {
	parentSession: string;
	taskId: string;
	parentEnv: SessionEnv;
	cwd?: string;
	agent?: AgentProfile;
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
	agentTools?: ToolDefinition[];
	toolFactory?: SessionToolFactory;
	taskDepth?: number;
	createTaskSession?: CreateTaskSession;
	onDelete?: () => void;
	submissionStore?: AgentSubmissionStore;
}

interface CallOverrides {
	tools: ToolDefinition[];
	model?: string;
	thinkingLevel?: ThinkingLevel;
	callSite: string;
	/**
	 * Framework-injected pi-agent-core tools spliced in alongside builtins and custom
	 * tools for the duration of this call. Used by the result-schema flow to
	 * inject `finish` and `give_up`.
	 */
	extraTools?: AgentTool<any>[];
	activePackagedSkills?: Record<string, PackagedSkillDirectory>;
}

interface InternalTaskResult<T> {
	output: T;
	text: string;
	taskId: string;
	session: string;
	messageId?: string;
	agent?: string;
	cwd?: string;
}

interface InternalTaskOptions<S extends v.GenericSchema | undefined> extends TaskOptions<S> {
	inheritedModel?: string;
	inheritedThinkingLevel?: ThinkingLevel;
}

function getRegisteredPackagedSkills(
	skills: Record<string, AgentConfig['skills'][string]>,
	packagedSkills: Record<string, PackagedSkillDirectory> | undefined,
): Record<string, PackagedSkillDirectory> {
	const registered: Record<string, PackagedSkillDirectory> = {};
	for (const skill of Object.values(skills)) {
		if (!('__flueSkillReference' in skill)) continue;
		const packaged = packagedSkills?.[skill.id];
		if (packaged) registered[skill.id] = packaged;
	}
	return registered;
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

function createDispatchInputSignal(input: DispatchInput): SignalMessage {
	return {
		role: 'signal',
		type: 'dispatch_input',
		tagName: 'dispatch',
		content: stableStringify(input.input),
		attributes: {
			agent: input.agent,
			id: input.id,
			session: input.session,
			dispatchId: input.dispatchId,
			acceptedAt: input.acceptedAt,
		},
		data: { input: input.input },
		timestamp: Date.now(),
	};
}

function dispatchMetadata(input: DispatchInput): DispatchMessageMetadata {
	const metadata: DispatchMessageMetadata = {
		dispatchId: input.dispatchId,
		agent: input.agent,
		id: input.id,
		session: input.session,
		acceptedAt: input.acceptedAt,
		input: input.input,
	};
	return metadata;
}

function stableStringify(value: unknown): string {
	return JSON.stringify(sortJsonLike(value), null, 2);
}

function sortJsonLike(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortJsonLike);
	if (!value || typeof value !== 'object') return value;
	const sorted: Record<string, unknown> = {};
	for (const key of Object.keys(value).sort()) {
		sorted[key] = sortJsonLike((value as Record<string, unknown>)[key]);
	}
	return sorted;
}

function isRetryableModelError(message: AssistantMessage): boolean {
	if (message.stopReason !== 'error' || !message.errorMessage) return false;
	return /overloaded|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|network.?error|connection.?(?:reset|refused|lost)|socket hang up|fetch failed|timed? out|timeout|terminated/i.test(
		message.errorMessage,
	);
}

function isCompletedAssistantResponse(message: AssistantMessage): boolean {
	return message.stopReason === 'stop' || message.stopReason === 'length';
}

function modelRetryDelayMs(attempt: number): number {
	const baseDelay = TRANSIENT_MODEL_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
	return Math.round(baseDelay * (0.75 + Math.random() * 0.25));
}

function countConsecutiveRetryableModelErrors(entries: SessionEntry[]): number {
	let count = 0;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry?.type !== 'message' || entry.message.role !== 'assistant') continue;
		if (!isRetryableModelError(entry.message as AssistantMessage)) return count;
		count += 1;
	}
	return count;
}

function sleepUntilRetry(delayMs: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.reject(abortErrorFor(signal));
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal.removeEventListener('abort', onAbort);
			resolve();
		}, delayMs);
		const onAbort = () => {
			clearTimeout(timer);
			signal.removeEventListener('abort', onAbort);
			reject(abortErrorFor(signal));
		};
		signal.addEventListener('abort', onAbort, { once: true });
	});
}

export class Session implements FlueSession {
	readonly name: string;
	readonly fs: FlueFs;
	metadata: Record<string, any>;

	private harness: Agent;
	private storageKey: string;
	private affinityKey: string;
	private config: AgentConfig;
	private env: SessionEnv;
	private store: SessionStore;
	private history: SessionHistory;
	private createdAt: string | undefined;
	private compactionAbortController: AbortController | undefined;
	private modelRetryAbortController: AbortController | undefined;
	private eventCallback: FlueEventCallback | undefined;
	private agentTools: ToolDefinition[];
	private toolFactory: SessionToolFactory | undefined;
	private deleted = false;
	private deletionPromise: Promise<void> | undefined;
	private activeOperation: OperationKind | undefined;
	private activeOperationId: string | undefined;
	private toolStartTimes = new Map<string, number>();
	private turnStartTime: number | undefined;
	private activeTurnId: string | undefined;
	private activeTasks = new Set<Session>();
	private taskDepth: number;
	private createTaskSession: CreateTaskSession | undefined;
	private onDelete: (() => void) | undefined;
	private submissionStore: AgentSubmissionStore | undefined;
	private pendingSave: Promise<void> = Promise.resolve();
	private harnessMessageCheckpointCursor = 0;
	private activeCheckpointSource: MessageEntry['source'] | undefined;
	private activeJournalCallbacks: ProcessAgentSubmissionOptions['journal'] | undefined;
	private activeTimeoutAt: number | undefined;
	private activeTurnCanCommitJournal = false;
	private activeStreamChunkWriter: StreamChunkWriter | undefined;
	private activeSubmissionId: string | undefined;
	private activeSubmissionAttemptId: string | undefined;

	private emitTurnRequestAndStream: StreamFn = async (model, context, options) => {
		if (this.activeTurnId === undefined) this.activeTurnId = generateTurnId();
		const turnId = this.activeTurnId;
		const streamKey =
			this.activeSubmissionId && this.activeSubmissionAttemptId
				? `${this.activeSubmissionId}:${turnId}:${this.activeSubmissionAttemptId}`
				: undefined;
		const state = {
			operationId: this.activeOperationId ?? generateOperationId(),
			turnId,
			checkpointLeafId: this.history.getLeafId() ?? undefined,
			streamKey,
		};
		await this.activeJournalCallbacks?.beforeProvider?.(state);
		if (streamKey && this.submissionStore) {
			this.activeStreamChunkWriter = new StreamChunkWriter(this.submissionStore, streamKey);
		}
		this.emitTurnRequest(turnId, 'agent', model, context, options?.reasoning);
		await this.activeJournalCallbacks?.providerStarted?.(state);
		return streamSimple(model, context, options);
	};

	private emitTurnRequest(
		turnId: string,
		purpose: 'agent' | 'compaction' | 'compaction_prefix',
		model: Model<any>,
		context: {
			systemPrompt?: string;
			messages: Message[];
			tools?: Array<{ name: string; description: string; parameters: unknown }>;
		},
		reasoning: string | undefined,
	): void {
		const tools = context.tools?.map(
			(tool): TurnInputTool => ({
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
			}),
		);
		this.emit({
			type: 'turn_request',
			turnId,
			purpose,
			model: model.id,
			provider: model.provider,
			api: model.api,
			input: {
				systemPrompt: context.systemPrompt,
				messages: context.messages.map(toTurnMessage),
				tools,
			},
			reasoning,
		});
	}

	constructor(options: SessionInitOptions) {
		this.name = options.name;
		this.storageKey = options.storageKey;
		this.affinityKey = options.affinityKey;
		this.config = options.config;
		this.env = options.env;
		this.fs = createFlueFs(options.env);
		this.store = options.store;
		this.agentTools = options.agentTools ?? [];
		this.toolFactory = options.toolFactory;
		this.taskDepth = options.taskDepth ?? 0;
		this.createTaskSession = options.createTaskSession;
		this.onDelete = options.onDelete;
		this.submissionStore = options.submissionStore;

		this.metadata = options.existingData?.metadata ?? {};
		this.createdAt = options.existingData?.createdAt;

		this.history = SessionHistory.fromData(options.existingData);

		const systemPrompt = this.config.systemPrompt;

		const builtinTools = this.createBuiltinTools(this.env, []);
		const tools = [...builtinTools, ...this.createCustomTools(this.agentTools, builtinTools)];

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
			streamFn: this.emitTurnRequestAndStream,
			toolExecution: 'parallel',
			sessionId: this.affinityKey,
		});

		this.harnessMessageCheckpointCursor = this.harness.state.messages.length;
		this.eventCallback = options.onAgentEvent;
		this.harness.subscribe(async (event) => {
			switch (event.type) {
				case 'agent_start':
					this.emit({ type: 'agent_start' });
					break;
				case 'turn_start':
					this.turnStartTime = Date.now();
					this.activeTurnId = generateTurnId();
					this.activeTurnCanCommitJournal = false;
					this.emit({ type: 'turn_start', turnId: this.activeTurnId, purpose: 'agent' });
					break;
				case 'message_start':
					this.emit({ type: 'message_start', message: event.message });
					break;
				case 'message_update': {
					this.activeStreamChunkWriter?.write(event.assistantMessageEvent);
					this.emit({
						type: 'message_update',
						message: event.message,
						assistantMessageEvent: event.assistantMessageEvent,
					});
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
				case 'message_end':
					if (event.message.role === 'assistant') {
						const toolCalls = event.message.content.filter(
							(content) => content.type === 'toolCall',
						);
						if (toolCalls.length > 0) {
							await this.checkpointHarnessMessages();
							await this.activeJournalCallbacks?.toolRequestRecorded?.({
								operationId: this.activeOperationId ?? generateOperationId(),
								turnId: this.activeTurnId ?? generateTurnId(),
								checkpointLeafId: this.history.getLeafId() ?? undefined,
								toolRequest: { toolCalls },
							});
						}
					}
					if (event.message.role === 'user') await this.checkpointHarnessMessages();
					this.emit({ type: 'message_end', message: event.message });
					break;
				case 'tool_execution_start':
					this.toolStartTimes.set(event.toolCallId, Date.now());
					this.emit({
						type: 'tool_start',
						toolName: event.toolName,
						toolCallId: event.toolCallId,
						args: event.args,
					});
					break;
				case 'tool_execution_update':
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
					const turnId = this.activeTurnId ?? generateTurnId();
					await this.activeStreamChunkWriter?.flush();
					this.activeTurnCanCommitJournal = true;
					await this.checkpointHarnessMessages();
					this.emit({
						type: 'turn_end',
						turnId,
						purpose: 'agent',
						message: event.message,
						toolResults: event.toolResults,
					});
					const message = event.message;
					const assistant =
						message.role === 'assistant' ? (message as AssistantMessage) : undefined;
					const output = assistant ? (toTurnMessage(assistant) as TurnOutput) : undefined;
					const model = this.harness.state.model;
					this.emit({
						type: 'turn',
						turnId,
						purpose: 'agent',
						durationMs: durationSince(this.turnStartTime),
						model: model?.id,
						provider: model?.provider,
						api: model?.api,
						output,
						usage: fromProviderUsage(assistant?.usage),
						stopReason: assistant?.stopReason,
						isError: assistant?.stopReason === 'error' || assistant?.stopReason === 'aborted',
						error: assistant?.errorMessage,
					});
					this.turnStartTime = undefined;
					this.activeTurnId = undefined;
					await this.activeStreamChunkWriter?.close();
					this.activeStreamChunkWriter = undefined;
					break;
				}
				case 'agent_end':
					await this.activeStreamChunkWriter?.flush();
					await this.checkpointHarnessMessages();
					this.emit({ type: 'agent_end', messages: event.messages });
					this.turnStartTime = undefined;
					this.activeTurnId = undefined;
					await this.activeStreamChunkWriter?.close();
					this.activeStreamChunkWriter = undefined;
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
	prompt(text: string, options?: PromptOptions): CallHandle<PromptResponse>;
	prompt(text: string, options?: PromptOptions<v.GenericSchema | undefined>): CallHandle<any> {
		return createCallHandle(options?.signal, (signal) =>
			this.runOperation('prompt', signal, async () => {
				const schema = options?.result;
				return this.runPromptCall({
					promptText: buildPromptText(text, schema),
					schema,
					tools: options?.tools,
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

	processDirectInput(input: { message: string }): CallHandle<PromptResponse> {
		return createCallHandle(undefined, (signal) =>
			this.runOperation(
				'prompt',
				signal,
				() =>
					this.runPromptCall({
						promptText: input.message,
						schema: undefined,
						tools: undefined,
						model: undefined,
						thinkingLevel: undefined,
						images: undefined,
						source: 'prompt',
						errorLabel: 'prompt',
						callSite: 'this direct input',
						signal,
					}) as Promise<PromptResponse>,
			),
		);
	}

	inspectSubmissionInput(input: AgentSubmissionInput): AgentSubmissionInspection {
		return this.inspectPersistedInput(
			input.kind === 'dispatch'
				? this.history.findDispatchInput(input.dispatchId)
				: this.history.findDirectSubmissionInput(input.submissionId),
		);
	}

	processSubmissionInput(
		input: AgentSubmissionInput,
		options?: ProcessAgentSubmissionOptions,
	): CallHandle<PromptResponse> {
		return createCallHandle(undefined, (signal) =>
			this.runOperation('prompt', signal, () =>
				input.kind === 'dispatch'
					? this.runPersistedDispatchInput(agentSubmissionDispatchInput(input), signal, options)
					: this.runPersistedDirectSubmissionInput(input, signal, options),
			),
		);
	}

	/**
	 * Repair interrupted tool calls by building a complete ordered result batch
	 * for all tool calls in the journal's toolRequest. Already-settled results
	 * are preserved (first-write-wins); unresolved tools get synthetic error
	 * results. Results are appended in original tool-call order so
	 * `isCompleteToolResultBatch` positional matching succeeds.
	 *
	 * Returns the new leaf ID after repair, or undefined if no repair was needed.
	 */
	async repairInterruptedToolCalls(
		input: AgentSubmissionInput,
		toolRequest: { toolCalls: Array<{ type: 'toolCall'; id: string; name: string }> },
	): Promise<string | undefined> {
		const inputEntry =
			input.kind === 'dispatch'
				? this.history.findDispatchInput(input.dispatchId)
				: this.history.findDirectSubmissionInput(input.submissionId);
		if (!inputEntry) return undefined;
		const following = this.history.getActivePathSince(inputEntry.id);
		const assistant = following.findLast(
			(entry): entry is MessageEntry =>
				entry.type === 'message' && entry.message.role === 'assistant',
		);
		if (!assistant || (assistant.message as AssistantMessage).stopReason !== 'toolUse')
			return undefined;

		const settledByCallId = new Map<string, ToolResultMessage>();
		for (const entry of following) {
			if (entry.type === 'message' && entry.message.role === 'toolResult') {
				const result = entry.message as ToolResultMessage;
				if (!settledByCallId.has(result.toolCallId)) {
					settledByCallId.set(result.toolCallId, result);
				}
			}
		}

		const hasUnsettled = toolRequest.toolCalls.some((tc) => !settledByCallId.has(tc.id));
		if (!hasUnsettled) return undefined;

		const now = Date.now();
		const orderedResults: ToolResultMessage[] = toolRequest.toolCalls.map((tc) => {
			const settled = settledByCallId.get(tc.id);
			if (settled) return settled;
			return {
				role: 'toolResult' as const,
				toolCallId: tc.id,
				toolName: tc.name,
				content: [
					{
						type: 'text' as const,
						text: JSON.stringify({
							type: 'interrupted',
							message: 'Tool execution was interrupted before completion. The outcome is unknown.',
						}),
					},
				],
				isError: true,
				timestamp: now,
			};
		});

		// Branch from the assistant entry so results are in correct positional
		// order regardless of which partial results were previously persisted.
		this.history.setLeaf(assistant.id);
		this.history.appendMessages(orderedResults, undefined);
		this.rebuildHarnessContext();
		await this.save();
		return this.history.getLeafId() ?? undefined;
	}

	async recoverInterruptedStream(streamKey: string): Promise<boolean> {
		if (!this.submissionStore) return false;
		const segments = await this.submissionStore.getStreamChunkSegments(streamKey);
		const recovered = reconstructInterruptedStream(segments, streamKey);
		if (!recovered) return false;
		const alreadyRecovered = this.history
			.getActivePath()
			.some(
				(entry) =>
					entry.type === 'message' &&
					entry.message.role === 'signal' &&
					entry.message.type === 'stream_continued' &&
					entry.message.attributes?.streamKey === streamKey,
			);
		if (alreadyRecovered) return true;
		this.history.appendMessages(
			[recovered.partial, recovered.interrupted, recovered.continued],
			'retry',
		);
		this.rebuildHarnessContext();
		await this.save();
		return true;
	}

	async recordSubmissionTerminal(input: AgentSubmissionInterruption): Promise<void> {
		if (this.history.findSubmissionTerminal(input.submissionId)) return;
		let body = input.message;
		if (input.interruptedTools && input.interruptedTools.length > 0) {
			const toolList = input.interruptedTools.map((t) => `  - ${t.name} (${t.id})`).join('\n');
			body += `\n\nInterrupted tool call(s):\n${toolList}`;
		}
		const signal: SignalMessage = {
			role: 'signal',
			type: 'submission_interrupted',
			content: body,
			attributes: {
				submissionId: input.submissionId,
				kind: input.kind,
				reason: input.reason,
			},
			timestamp: Date.now(),
		};
		this.history.appendMessage(signal, undefined, {
			submissionTerminal: {
				submissionId: input.submissionId,
				kind: input.kind,
				reason: input.reason,
			},
		});
		this.rebuildHarnessContext();
		await this.save();
	}

	skill<S extends v.GenericSchema>(
		skill: SkillReference | string,
		options: SkillOptions<S> & { result: S },
	): CallHandle<PromptResultResponse<v.InferOutput<S>>>;
	skill(skill: SkillReference | string, options?: SkillOptions): CallHandle<PromptResponse>;
	skill(
		skill: SkillReference | string,
		options?: SkillOptions<v.GenericSchema | undefined>,
	): CallHandle<any> {
		return createCallHandle(options?.signal, (signal) =>
			this.runOperation('skill', signal, async () => {
				const schema = options?.result;

				let promptText: string;
				let skillName: string;
				let activePackagedSkills: Record<string, PackagedSkillDirectory> | undefined;
				if (typeof skill === 'string') {
					const registered = this.config.skills[skill];
					if (registered && '__flueSkillReference' in registered) {
						const packaged = this.resolvePackagedSkill(registered);
						promptText = buildPackagedSkillPrompt(registered, packaged, options?.args, schema);
						activePackagedSkills = { [registered.id]: packaged };
					} else if (registered) {
						promptText = buildSkillByPathlessNamePrompt(skill, options?.args, schema);
					} else {
						this.throwMissingSkill(skill);
					}
					skillName = skill;
				} else {
					const packaged = this.resolvePackagedSkill(skill);
					promptText = buildPackagedSkillPrompt(skill, packaged, options?.args, schema);
					activePackagedSkills = { [skill.id]: packaged };
					skillName = skill.name;
				}

				return this.runPromptCall({
					promptText,
					schema,
					tools: options?.tools,
					model: options?.model,
					thinkingLevel: options?.thinkingLevel,
					images: options?.images,
					source: 'skill',
					errorLabel: `skill("${skillName}")`,
					callSite: `this skill("${skillName}") call`,
					activePackagedSkills,
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
			await this.runCompaction('manual');
		});
	}

	abort(): void {
		this.harness.abort();
		this.compactionAbortController?.abort();
		this.modelRetryAbortController?.abort();
		for (const task of this.activeTasks) task.abort();
	}

	/**
	 * Detach a child task session after its task completes. Aborts pending
	 * work and fires the onDelete callback but does NOT delete stored data —
	 * child session storage is parent-owned and cleaned up when the parent
	 * session is deleted via the session-tree cascade.
	 */
	close(): void {
		if (this.deleted) return;
		this.deleted = true;
		this.abort();
		this.onDelete?.();
	}

	delete(): Promise<void> {
		if (this.deletionPromise) return this.deletionPromise;
		if (this.deleted) return Promise.resolve();
		if (this.activeOperation) {
			return Promise.reject(
				new Error(
					`[flue] Session "${this.name}" cannot be deleted while ${this.activeOperation} is running. ` +
						'Wait for the active operation to finish before deleting the session.',
				),
			);
		}
		this.deleted = true;
		this.deletionPromise = Promise.resolve()
			.then(() => {
				const deleteTree = () => deleteSessionTree(this.store, this.storageKey);
				return this.submissionStore?.deleteSession(this.storageKey, deleteTree) ?? deleteTree();
			})
			.then(() => {
				this.onDelete?.();
			})
			.catch((error) => {
				this.deleted = false;
				this.deletionPromise = undefined;
				throw error;
			});
		return this.deletionPromise;
	}

	/** Precedence: call-level > agent-level default. */
	private resolveModelForCall(modelSpecifier: string | undefined, callSite: string): Model<any> {
		const model = modelSpecifier ? this.config.resolveModel(modelSpecifier) : this.config.model;
		return this.requireModel(model, callSite);
	}

	/** Precedence: call-level > agent-level default > 'medium'. */
	private resolveThinkingLevelForCall(callValue: ThinkingLevel | undefined): ThinkingLevel {
		return callValue ?? this.config.thinkingLevel ?? 'medium';
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
				`Pass \`{ model: "provider-id/model-id" }\` to this call or configure an agent model.`,
		);
	}

	private getProviderApiKey(providerId: string): string | undefined {
		// Explicit provider configuration overrides apiKeys carried by registered
		// provider templates. Undefined falls through to pi-ai's env-var lookup.
		const override = getProviderConfiguration(providerId)?.apiKey;
		if (override !== undefined) return override;
		return getRegisteredApiKey(providerId);
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

	private resolvePackagedSkill(reference: SkillReference) {
		const packaged = this.config.packagedSkills?.[reference.id];
		if (!packaged)
			throw new Error(
				`[flue] Packaged skill "${reference.name}" is unavailable for this application build.`,
			);
		return packaged;
	}

	private async activateSkillForTool(name: string): Promise<string> {
		const registered = this.config.skills[name];
		if (!registered) this.throwMissingSkill(name);
		if ('__flueSkillReference' in registered) {
			return buildPackagedSkillPrompt(registered, this.resolvePackagedSkill(registered));
		}
		if (isWorkspaceSkill(registered)) {
			return buildWorkspaceSkillPrompt(
				registered.name,
				registered.directory,
				registered.skillMdPath,
				await this.env.readFile(registered.skillMdPath),
			);
		}
		return buildSkillByPathlessNamePrompt(name);
	}

	private throwMissingSkill(skill: string): never {
		const available = Object.keys(this.config.skills).join(', ') || '(none)';
		throw new Error(
			`[flue] Skill "${skill}" not registered. Available: ${available}.\n\n` +
				`Skills are discovered at init() time from ${skillsDirIn(this.env.cwd)}/<name>/SKILL.md ` +
				`inside the session's sandbox. If you expected "${skill}" to be there, make sure ` +
				`the SKILL.md file exists at that path before calling init() — the default ` +
				`empty sandbox starts with no files, so it has no skills unless you put them there.\n\n` +
				`Packaged skills can be imported from SKILL.md with { type: 'skill' } and passed directly ` +
				`to session.skill(skillReference).`,
		);
	}

	// ─── Custom Tools ───────────────────────────────────────────────────────

	private createCustomTools(
		tools: ToolDefinition[],
		builtinTools: AgentTool<any>[],
	): AgentTool<any>[] {
		this.validateCustomToolNames(tools, builtinTools);

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

	/** Reject custom tools that collide with active built-ins or each other. */
	private validateCustomToolNames(tools: ToolDefinition[], builtinTools: AgentTool<any>[]): void {
		const reserved = new Set<string>(builtinTools.map((t) => t.name));
		reserved.add('task');
		reserved.add('activate_skill');
		const names = new Set<string>();
		for (const toolDef of tools) {
			if (reserved.has(toolDef.name)) {
				throw new Error(
					`[flue] Custom tool "${toolDef.name}" conflicts with a built-in tool. ` +
						`Built-in tools: ${[...reserved].join(', ')}`,
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

	/** Build built-in tools from the connector or the framework defaults. */
	private createBuiltinTools(
		env: SessionEnv,
		tools: ToolDefinition[],
		model?: string,
		thinkingLevel?: ThinkingLevel,
		activePackagedSkills?: Record<string, PackagedSkillDirectory>,
	): AgentTool<any>[] {
		const runTask = (params: TaskToolParams, signal?: AbortSignal) =>
			this.runTaskForTool(params, tools, model, thinkingLevel, signal);
		const packagedSkills = {
			...getRegisteredPackagedSkills(this.config.skills, this.config.packagedSkills),
			...activePackagedSkills,
		};
		const skillNames = Object.keys(this.config.skills);
		const activateSkillTool =
			skillNames.length > 0
				? createActivateSkillTool(skillNames, (name) => this.activateSkillForTool(name))
				: undefined;
		const appendActivateSkillTool = (builtinTools: AgentTool<any>[]) =>
			activateSkillTool ? [...builtinTools, activateSkillTool] : builtinTools;

		if (this.toolFactory) {
			let connectorTools = this.toolFactory(env, { subagents: this.config.subagents ?? {} });
			if (Object.keys(packagedSkills).length > 0) {
				const packagedRead = createPackagedSkillReadTool(packagedSkills);
				const connectorRead = connectorTools.find((tool) => tool.name === 'read');
				if (connectorRead) {
					connectorTools = connectorTools.map((tool) =>
						tool !== connectorRead
							? tool
							: {
									...tool,
									execute: (id, params, signal) => {
										const resourcePath =
											typeof params === 'object' && params !== null && 'path' in params
												? params.path
												: undefined;
										return typeof resourcePath === 'string' &&
											resourcePath.startsWith('/.flue/packaged-skills/')
											? packagedRead.execute(
													id,
													params as { path: string; offset?: number; limit?: number },
													signal,
												)
											: connectorRead.execute(id, params, signal);
									},
								},
					);
				} else {
					connectorTools = [...connectorTools, packagedRead];
				}
			}
			this.validateConnectorTools(connectorTools);
			return appendActivateSkillTool([
				...connectorTools,
				createTaskTool(runTask, this.config.subagents ?? {}),
			]);
		}

		return appendActivateSkillTool(
			createTools(env, {
				subagents: this.config.subagents ?? {},
				packagedSkills,
				task: runTask,
			}),
		);
	}

	/** Validate connector tool names before handing them to the agent loop. */
	private validateConnectorTools(tools: AgentTool<any>[]): void {
		const names = new Set<string>();
		for (const tool of tools) {
			if (tool.name === 'task' || tool.name === 'activate_skill') {
				throw new Error(
					`[flue] Sandbox connector tools() returned a tool named "${tool.name}", which is ` +
						`framework-reserved. The framework appends \`${tool.name}\` automatically when appropriate; remove it from the connector.`,
				);
			}
			if (names.has(tool.name)) {
				throw new Error(
					`[flue] Sandbox connector tools() returned duplicate tool name "${tool.name}". ` +
						'Connector tool names must be unique.',
				);
			}
			names.add(tool.name);
		}
	}

	private async withCallOverrides<T>(
		options: CallOverrides,
		fn: (ctx: { resolvedModel: Model<any> }) => Promise<T>,
	): Promise<T> {
		const previousTools = this.harness.state.tools;
		const previousModel = this.harness.state.model;
		const previousSystemPrompt = this.harness.state.systemPrompt;
		const previousThinkingLevel = this.harness.state.thinkingLevel;

		const resolvedModel = this.resolveModelForCall(options.model, options.callSite);
		this.harness.state.model = resolvedModel;
		this.harness.state.thinkingLevel = this.resolveThinkingLevelForCall(options.thinkingLevel);
		const builtinTools = this.createBuiltinTools(
			this.env,
			options.tools,
			options.model,
			options.thinkingLevel,
			options.activePackagedSkills,
		);
		const customTools = this.createCustomTools(
			[...this.agentTools, ...options.tools],
			builtinTools,
		);
		this.harness.state.tools = [...builtinTools, ...customTools, ...(options.extraTools ?? [])];
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

	private resolveDeclaredSubagent(name: string): AgentProfile {
		const subagents = this.config.subagents ?? {};
		const subagent = subagents[name];
		if (subagent) return subagent;
		const available = Object.keys(subagents).join(', ') || '(none)';
		throw new Error(`[flue] Subagent "${name}" is not declared. Available: ${available}.`);
	}

	private async runTaskForTool(
		params: TaskToolParams,
		tools: ToolDefinition[],
		inheritedModel: string | undefined,
		inheritedThinkingLevel: ThinkingLevel | undefined,
		signal?: AbortSignal,
	): Promise<AgentToolResult<TaskToolResultDetails>> {
		const result = await this.executeTask(
			params.prompt,
			{
				agent: params.agent,
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
				agent: result.agent,
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
				const result = await this.executeTask(text, options, signal);
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

	private async executeTask<S extends v.GenericSchema | undefined>(
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
		const taskAgent = options?.agent ? this.resolveDeclaredSubagent(options.agent) : undefined;
		let child: Session | undefined;
		let abortListener: (() => void) | undefined;

		this.emit({
			type: 'task_start',
			taskId,
			prompt: text,
			agent: taskAgent?.name,
			cwd: options?.cwd,
			parentSession: this.name,
		});
		const taskStartMs = Date.now();

		try {
			child = await this.createTaskSession({
				parentSession: this.name,
				taskId,
				parentEnv: this.env,
				cwd: options?.cwd,
				agent: taskAgent,
				depth: this.taskDepth + 1,
			});
			await this.recordTaskSession(child.name, taskId);
			await child.save();
			this.activeTasks.add(child);

			// Aborts during sandbox bring-up — child.prompt's own
			// runOperation handles the in-flight case.
			if (signal) {
				abortListener = () => child?.abort();
				signal.addEventListener('abort', abortListener, { once: true });
			}

			const schema = options?.result;
			const childOptions: PromptOptions<v.GenericSchema | undefined> = {
				model:
					options?.model ?? (taskAgent?.model !== undefined ? undefined : options?.inheritedModel),
				thinkingLevel:
					options?.thinkingLevel ??
					(taskAgent?.thinkingLevel !== undefined ? undefined : options?.inheritedThinkingLevel),
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
				agent: taskAgent?.name,
				cwd: options?.cwd,
			};
			this.emit({
				type: 'task',
				taskId,
				agent: taskAgent?.name,
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
				agent: taskAgent?.name,
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
				this.modelRetryAbortController?.abort(signal?.reason);
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
		const turnId = event.turnId ?? this.activeTurnId;
		if (turnId !== undefined) decorated.turnId = turnId;
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
					arguments: args as Record<string, unknown>,
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
		this.rebuildHarnessContext();
		await this.save();
	}

	private rebuildHarnessContext(): void {
		const messages = this.history.buildContext();
		this.harness.state.messages = messages;
		this.harnessMessageCheckpointCursor = messages.length;
	}

	private async checkpointHarnessMessages(): Promise<void> {
		const messages = this.harness.state.messages.slice(
			this.harnessMessageCheckpointCursor,
		) as AgentMessage[];
		if (messages.length === 0) return;
		if (!this.activeCheckpointSource) {
			throw new Error('[flue] Cannot checkpoint harness messages without an active source.');
		}
		this.history.appendMessages(messages, this.activeCheckpointSource);
		this.harnessMessageCheckpointCursor = this.harness.state.messages.length;
		await this.save();
		if (this.activeTurnCanCommitJournal) {
			const leafId = this.history.getLeafId();
			if (!leafId) {
				throw new Error('[flue] Invariant: checkpoint leaf ID is null after saving messages.');
			}
			const latest = messages.at(-1);
			const turnEndedWithToolResult = latest?.role === 'toolResult';
			if (turnEndedWithToolResult) {
				await this.activeJournalCallbacks?.checkpointReady?.({
					operationId: this.activeOperationId ?? generateOperationId(),
					turnId: this.activeTurnId ?? generateTurnId(),
					checkpointLeafId: leafId,
				});
				if (this.activeStreamChunkWriter) {
					await this.submissionStore?.deleteStreamChunkSegments(
						this.activeStreamChunkWriter.streamKey,
					);
				}
			} else {
				await this.activeJournalCallbacks?.committed?.({
					operationId: this.activeOperationId ?? generateOperationId(),
					turnId: this.activeTurnId ?? generateTurnId(),
					checkpointLeafId: leafId,
					committedLeafId: leafId,
				});
				if (this.activeStreamChunkWriter) {
					await this.submissionStore?.deleteStreamChunkSegments(
						this.activeStreamChunkWriter.streamKey,
					);
				}
			}
			this.activeTurnCanCommitJournal = false;
		}
	}

	private async save(): Promise<void> {
		const result = this.pendingSave.then(async () => {
			const now = new Date().toISOString();
			const data = this.history.toData(this.affinityKey, this.metadata, this.createdAt ?? now, now);
			if (!this.createdAt) this.createdAt = now;
			await this.store.save(this.storageKey, data);
		});
		this.pendingSave = result.then(
			() => {},
			() => {},
		);
		await result;
	}

	private async recordTaskSession(session: string, taskId: string): Promise<void> {
		const taskSessions = Array.isArray(this.metadata.taskSessions)
			? this.metadata.taskSessions
			: [];
		if (!taskSessions.some((task) => task?.session === session)) {
			taskSessions.push({ session, taskId });
			this.metadata.taskSessions = taskSessions;
			await this.save();
		}
	}

	// ─── Model-turn recovery and compaction ───────────────────────────────────

	private async runModelTurnWithRecovery(options: {
		start: () => Promise<void>;
		source: MessageSource;
		signal: AbortSignal;
		transientRetries?: number;
		overflowRecoveryAttempted?: boolean;
	}): Promise<void> {
		let start = options.start;
		let source = options.source;
		let transientRetries = options.transientRetries ?? 0;
		let overflowRecoveryAttempted = options.overflowRecoveryAttempted ?? false;

		while (true) {
			if (options.signal.aborted) throw abortErrorFor(options.signal);
			// Cooperative timeout: checked between turns, not during provider calls.
			// A hung provider or long tool execution can exceed the deadline. That case
			// is covered by DO eviction + the attempt budget (Capability K), not this check.
			// Preemptive in-turn watchdog is deferred to Capability L.
			if (this.activeTimeoutAt !== undefined && Date.now() >= this.activeTimeoutAt) {
				throw new Error('[flue] Submission exceeded configured timeout.');
			}
			this.activeCheckpointSource = source;
			try {
				await start();
				await this.harness.waitForIdle();
				await this.checkpointHarnessMessages();
			} catch (error) {
				await this.activeStreamChunkWriter?.flush();
				this.rebuildHarnessContext();
				throw error;
			} finally {
				this.activeCheckpointSource = undefined;
			}

			const messages = this.harness.state.messages;
			const latest = messages[messages.length - 1];
			if (latest?.role !== 'assistant') return;
			const assistant = latest as AssistantMessage;
			const model = this.harness.state.model;

			if (isContextOverflow(assistant, model.contextWindow ?? 0)) {
				if (overflowRecoveryAttempted) {
					this.rebuildHarnessContext();
					return;
				}
				overflowRecoveryAttempted = true;
				this.internalLog('info', '[flue:compaction] Overflow detected, compacting and retrying...');
				this.rebuildHarnessContext();
				if (!(await this.runCompaction('overflow'))) return;
				this.internalLog('info', '[flue:compaction] Retrying after overflow recovery...');
				start = () => this.harness.continue();
				source = 'retry';
				continue;
			}

			if (isRetryableModelError(assistant)) {
				transientRetries += 1;
				if (!(await this.waitForTransientModelRetry(assistant, transientRetries))) return;
				start = () => this.harness.continue();
				source = 'retry';
				continue;
			}

			await this.checkCompaction(assistant);
			if (assistant.stopReason === 'error' || assistant.stopReason === 'aborted') {
				this.rebuildHarnessContext();
			}
			return;
		}
	}

	private async waitForTransientModelRetry(
		assistant: AssistantMessage,
		attempt: number,
	): Promise<boolean> {
		if (attempt > MAX_TRANSIENT_MODEL_RETRIES) {
			this.internalLog('warn', '[flue:model-retry] Transient model error retries exhausted', {
				attempts: attempt - 1,
				error: assistant.errorMessage,
			});
			this.rebuildHarnessContext();
			return false;
		}
		const delayMs = modelRetryDelayMs(attempt);
		this.rebuildHarnessContext();
		this.modelRetryAbortController = new AbortController();
		this.internalLog('warn', '[flue:model-retry] Retrying transient model error', {
			attempt,
			maxRetries: MAX_TRANSIENT_MODEL_RETRIES,
			delayMs,
			error: assistant.errorMessage,
		});
		try {
			await sleepUntilRetry(delayMs, this.modelRetryAbortController.signal);
		} finally {
			this.modelRetryAbortController = undefined;
		}
		return true;
	}

	private async checkCompaction(assistantMessage: AssistantMessage): Promise<void> {
		if (assistantMessage.stopReason === 'aborted' || assistantMessage.stopReason === 'error')
			return;

		const model = this.harness.state.model;
		const settings = this.resolveCompactionSettings(model);
		if (!settings.enabled) return;
		const contextWindow = model.contextWindow ?? 0;
		const contextTokens = calculateContextTokens(assistantMessage.usage);

		if (shouldCompact(contextTokens, contextWindow, settings)) {
			this.internalLog(
				'info',
				`[flue:compaction] Threshold reached — ${contextTokens} tokens used, ` +
					`window ${contextWindow}, reserve ${settings.reserveTokens}, ` +
					'triggering compaction',
			);
			await this.runCompaction('threshold');
		}
	}

	/**
	 * Runs a compaction pass. The summarization cost (1–2 internal LLM
	 * calls) is persisted on the resulting `CompactionEntry.usage`, which
	 * `aggregateUsageSince` later folds into the surrounding call's
	 * `response.usage` — so users see the true cost of the call that
	 * triggered compaction.
	 */
	private async runCompaction(reason: 'threshold' | 'overflow' | 'manual'): Promise<boolean> {
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
				return false;
			}
			const firstKeptEntry = contextEntries[preparation.firstKeptIndex]?.entry;
			if (!firstKeptEntry || firstKeptEntry.type !== 'message') {
				this.internalLog(
					'info',
					'[flue:compaction] Nothing to compact (first kept message has no entry)',
				);
				return false;
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
				{
					start: (purpose, model, context, options): CompactionTurnHandle => {
						const handle = { turnId: generateTurnId(), startedAt: Date.now() };
						this.emitTurnRequest(handle.turnId, purpose, model, context, options.reasoning);
						return handle;
					},
					end: (purpose, handle, model, response, error): void => {
						const output = response ? (toTurnMessage(response) as TurnOutput) : undefined;
						this.emit({
							type: 'turn',
							turnId: handle.turnId,
							purpose,
							durationMs: durationSince(handle.startedAt),
							model: model.id,
							provider: model.provider,
							api: model.api,
							output,
							usage: fromProviderUsage(response?.usage),
							stopReason: response?.stopReason,
							isError:
								error !== undefined ||
								response?.stopReason === 'error' ||
								response?.stopReason === 'aborted',
							error: error === undefined ? response?.errorMessage : serializeError(error),
						});
					},
				},
			);

			if (this.compactionAbortController.signal.aborted) return false;

			this.history.appendCompaction({
				summary: result.summary,
				firstKeptEntryId: firstKeptEntry.id,
				tokensBefore: result.tokensBefore,
				details: result.details,
				usage: result.usage,
			});
			this.rebuildHarnessContext();

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
			return true;
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.internalLog('error', `[flue:compaction] Failed: ${errorMessage}`, { error });
			return false;
		} finally {
			this.compactionAbortController = undefined;
		}
	}

	private internalLog(
		level: 'info' | 'warn' | 'error',
		message: string,
		attributes?: Record<string, unknown>,
	): void {
		if (level === 'error') console.error(message);
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
			const msg = messages[i];
			if (msg?.role !== 'assistant') continue;
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
			const entry = path[i];
			if (entry?.type === 'message' && entry.message.role === 'assistant') {
				return entry.id;
			}
		}
		return undefined;
	}

	private inspectPersistedInput(inputEntry: MessageEntry | undefined): AgentSubmissionInspection {
		if (!inputEntry) return 'absent';
		const following = this.history.getActivePathSince(inputEntry.id);
		if (following.some((entry) => entry.type === 'message' && entry.message.role === 'user')) {
			return 'uncertain';
		}
		const assistant = following.findLast(
			(entry): entry is MessageEntry =>
				entry.type === 'message' && entry.message.role === 'assistant',
		)?.message as AssistantMessage | undefined;
		if (assistant && isCompletedAssistantResponse(assistant)) return 'completed';
		if (
			assistant?.stopReason === 'toolUse' &&
			following.some((entry) => entry.type === 'message' && entry.message.role === 'toolResult')
		) {
			return 'continuable';
		}
		if (
			assistant?.stopReason === 'aborted' &&
			following.some(
				(entry) =>
					entry.type === 'message' &&
					entry.message.role === 'signal' &&
					entry.message.type === 'stream_continued',
			)
		) {
			return 'continuable';
		}
		return 'uncertain';
	}

	private async runPersistedDispatchInput(
		input: DispatchInput,
		signal: AbortSignal,
		options?: ProcessAgentSubmissionOptions,
	): Promise<PromptResponse> {
		return this.runPersistedContextInput({
			findInput: () => this.history.findDispatchInput(input.dispatchId),
			persistInput: () =>
				this.history.appendMessage(createDispatchInputSignal(input), 'dispatch', {
					dispatch: dispatchMetadata(input),
				}),
			errorLabel: `dispatch(${input.dispatchId})`,
			outputSource: 'dispatch',
			callSite: 'this dispatched input',
			persistenceError: '[flue] Failed to persist dispatched input.',
			recoveryError: '[flue] Cannot recover dispatched input after the session has advanced.',
			onInputApplied: options?.onInputApplied,
			submissionAttempt: options?.submissionAttempt,
			journal: options?.journal,
			startedAt: options?.startedAt,
			timeoutAt: options?.timeoutAt,
			signal,
		});
	}

	private async runPersistedDirectSubmissionInput(
		input: DirectAgentSubmissionInput,
		signal: AbortSignal,
		options?: ProcessAgentSubmissionOptions,
	): Promise<PromptResponse> {
		return this.runPersistedContextInput({
			findInput: () => this.history.findDirectSubmissionInput(input.submissionId),
			persistInput: () =>
				this.history.appendMessage(
					createUserContextMessage(input.payload.message, new Date().toISOString()),
					'prompt',
					{ directSubmissionId: input.submissionId },
				),
			errorLabel: `direct(${input.submissionId})`,
			outputSource: 'prompt',
			callSite: 'this direct input',
			persistenceError: '[flue] Failed to persist direct input.',
			recoveryError: '[flue] Cannot recover direct input after the session has advanced.',
			onInputApplied: options?.onInputApplied,
			submissionAttempt: options?.submissionAttempt,
			journal: options?.journal,
			startedAt: options?.startedAt,
			timeoutAt: options?.timeoutAt,
			signal,
		});
	}

	private resolveSubmissionDurability(
		startedAt?: number,
		timeoutAt?: number,
	): SubmissionDurability {
		return {
			maxRetry: this.config.durability?.retry ?? DURABILITY_DEFAULT_MAX_RETRY,
			timeoutAt:
				timeoutAt ??
				(startedAt ?? Date.now()) +
					(this.config.durability?.timeout ?? DURABILITY_DEFAULT_TIMEOUT_MINUTES) * 60_000,
		};
	}

	private async runPersistedContextInput(options: {
		findInput: () => MessageEntry | undefined;
		persistInput: () => string;
		journal?: ProcessAgentSubmissionOptions['journal'];
		startedAt?: number;
		timeoutAt?: number;
		errorLabel: string;
		outputSource: MessageSource;
		callSite: string;
		persistenceError: string;
		recoveryError: string;
		onInputApplied?: (durability: SubmissionDurability) => Promise<void> | void;
		submissionAttempt?: import('./agent-execution-store.ts').SubmissionAttemptRef;
		signal: AbortSignal;
	}): Promise<PromptResponse> {
		return this.withCallOverrides(
			{
				tools: [],
				model: undefined,
				thinkingLevel: undefined,
				callSite: options.callSite,
			},
			async ({ resolvedModel }) => {
				this.activeJournalCallbacks = options.journal;
				this.activeSubmissionId = options.submissionAttempt?.submissionId;
				this.activeSubmissionAttemptId = options.submissionAttempt?.attemptId;
				const durability = this.resolveSubmissionDurability(options.startedAt, options.timeoutAt);
				this.activeTimeoutAt = durability.timeoutAt;
				try {
					let inputEntry = options.findInput();
					if (!inputEntry) {
						options.persistInput();
						this.rebuildHarnessContext();
						await this.save();
						inputEntry = options.findInput();
					}
					if (!inputEntry) throw new Error(options.persistenceError);
					await options.onInputApplied?.(durability);
					const following = this.history.getActivePathSince(inputEntry.id);
					if (
						following.some((entry) => entry.type === 'message' && entry.message.role === 'user')
					) {
						throw new Error(options.recoveryError);
					}
					const persistedAssistants = following.filter(
						(entry): entry is MessageEntry =>
							entry.type === 'message' && entry.message.role === 'assistant',
					);
					const persistedAssistant = persistedAssistants.at(-1);
					const assistant = persistedAssistant?.message as AssistantMessage | undefined;
					const model = this.harness.state.model;
					const overflow = assistant
						? isContextOverflow(assistant, model.contextWindow ?? 0)
						: false;
					const streamContinuation =
						assistant?.stopReason === 'aborted' &&
						following.some(
							(entry) =>
								entry.type === 'message' &&
								entry.message.role === 'signal' &&
								entry.message.type === 'stream_continued',
						);
					if (
						!assistant ||
						overflow ||
						isRetryableModelError(assistant) ||
						streamContinuation ||
						(assistant.stopReason === 'toolUse' &&
							following.some(
								(entry) => entry.type === 'message' && entry.message.role === 'toolResult',
							))
					) {
						const transientRetries = countConsecutiveRetryableModelErrors(following);
						// Check timeout before entering the preamble (compaction, transient
						// retry backoff) which can add significant time. The main timeout
						// check lives in runModelTurnWithRecovery, but these preamble paths
						// run before that loop is entered.
						if (this.activeTimeoutAt !== undefined && Date.now() >= this.activeTimeoutAt) {
							throw new Error('[flue] Submission exceeded configured timeout.');
						}
						if (assistant && overflow) {
							this.rebuildHarnessContext();
							this.internalLog(
								'info',
								'[flue:compaction] Overflow detected, compacting and retrying...',
							);
							if (!(await this.runCompaction('overflow'))) {
								throw new Error(
									`[flue] ${options.errorLabel} failed: ${assistant.errorMessage ?? assistant.stopReason}`,
								);
							}
							this.internalLog('info', '[flue:compaction] Retrying after overflow recovery...');
						} else if (assistant && isRetryableModelError(assistant)) {
							if (!(await this.waitForTransientModelRetry(assistant, transientRetries))) {
								throw new Error(
									`[flue] ${options.errorLabel} failed: ${assistant.errorMessage ?? assistant.stopReason}`,
								);
							}
						}
						await this.runModelTurnWithRecovery({
							start: () => this.harness.continue(),
							source: assistant ? 'retry' : options.outputSource,
							signal: options.signal,
							transientRetries,
							overflowRecoveryAttempted: overflow,
						});
						this.throwIfError(options.errorLabel);
					} else if (assistant.stopReason === 'error' || assistant.stopReason === 'aborted') {
						throw new Error(
							`[flue] ${options.errorLabel} failed: ${assistant.errorMessage ?? assistant.stopReason}`,
						);
					}
					return {
						text: this.getAssistantText(),
						usage: this.aggregateUsageSince(inputEntry.id),
						model: { provider: resolvedModel.provider, id: resolvedModel.id },
					};
				} finally {
					this.activeJournalCallbacks = undefined;
					this.activeSubmissionId = undefined;
					this.activeSubmissionAttemptId = undefined;
					this.activeTimeoutAt = undefined;
				}
			},
		);
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
		tools: ToolDefinition[] | undefined;
		model: string | undefined;
		thinkingLevel: ThinkingLevel | undefined;
		images: ImageContent[] | undefined;
		source: MessageSource;
		errorLabel: string;
		callSite: string;
		activePackagedSkills?: Record<string, PackagedSkillDirectory>;
		signal: AbortSignal;
	}): Promise<PromptResponse | PromptResultResponse<unknown>> {
		const resultBundle = args.schema ? createResultTools(args.schema) : undefined;

		return this.withCallOverrides(
			{
				tools: args.tools ?? [],
				model: args.model,
				thinkingLevel: args.thinkingLevel,
				callSite: args.callSite,
				extraTools: resultBundle?.tools,
				activePackagedSkills: args.activePackagedSkills,
			},
			async ({ resolvedModel }) => {
				const beforeLeafId = this.history.getLeafId();
				const model: PromptModel = { provider: resolvedModel.provider, id: resolvedModel.id };

				if (resultBundle) {
					const result = await this.runWithResultTools(
						args.promptText,
						resultBundle,
						args.source,
						args.errorLabel,
						args.signal,
						args.images,
					);
					return {
						data: result,
						usage: this.aggregateUsageSince(beforeLeafId),
						model,
					};
				}

				await this.runModelTurnWithRecovery({
					start: () => this.harness.prompt(args.promptText, args.images),
					source: args.source,
					signal: args.signal,
				});
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
	 */
	private async runWithResultTools<T>(
		initialPrompt: string,
		bundle: ResultToolBundle<T>,
		source: MessageSource,
		errorLabel: string,
		signal: AbortSignal,
		initialImages?: ImageContent[],
	): Promise<T> {
		let nextPrompt: string = initialPrompt;
		const MAX_FOLLOWUPS = 32;
		for (let attempt = 0; attempt <= MAX_FOLLOWUPS; attempt++) {
			if (signal.aborted) throw abortErrorFor(signal);
			// Images attach only on the first turn — retry follow-ups carry text
			// only, so we don't re-bill image bytes on every result-tool retry.
			await this.runModelTurnWithRecovery({
				start: () => this.harness.prompt(nextPrompt, attempt === 0 ? initialImages : undefined),
				source,
				signal,
			});
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
	return `/${result.join('/')}`;
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
		const childStorageKey = childTaskSessionStorageKey(storageKey, task);
		if (childStorageKey) await deleteSessionTree(store, childStorageKey, seen);
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
