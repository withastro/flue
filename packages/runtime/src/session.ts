/**
 * Internal session implementation. Not exported publicly — user code receives
 * the facade from `createPublicSession()`, which exposes exactly the
 * `FlueSession` contract.
 */

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
import { type ActionDefinition, parseActionInput, runActionWithParsedInput } from './action.ts';
import {
	createActivateSkillTool,
	createPackagedSkillReadTool,
	createTaskTool,
	createTools,
	type TaskToolParams,
	type TaskToolResultDetails,
} from './agent.ts';
import {
	type AgentSubmissionStore,
	DURABILITY_DEFAULT_MAX_ATTEMPTS,
	DURABILITY_DEFAULT_TIMEOUT_MS,
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
	DelegationDepthExceededError,
	ModelNotConfiguredError,
	OperationFailedError,
	SessionBusyError,
	SessionDeletedError,
	SkillNotRegisteredError,
	SubagentNotDeclaredError,
	SubmissionTimeoutError,
	ToolNameConflictError,
} from './errors.ts';
import { IMAGE_DATA_OMITTED, redactEventImages } from './event-redaction.ts';
import { assertImagesWithinLimit } from './persisted-images.ts';
import {
	buildPackagedSkillPrompt,
	buildPromptText,
	buildResultFollowUpPrompt,
	buildSkillByPathlessNamePrompt,
	buildWorkspaceSkillPrompt,
	createResultTools,
	FINISH_TOOL_NAME,
	GIVE_UP_TOOL_NAME,
	type ResultToolBundle,
	ResultUnavailableError,
} from './result.ts';
import type {
	AgentSubmissionInput,
	AgentSubmissionInspection,
	AgentSubmissionInterruption,
	AgentSubmissionSession,
	DirectAgentSubmissionInput,
	ProcessAgentSubmissionOptions,
} from './runtime/agent-submissions.ts';
import { agentSubmissionDispatchInput } from './runtime/agent-submissions.ts';
import type { DispatchInput } from './runtime/dispatch-queue.ts';
import { generateOperationId, generateTurnId } from './runtime/ids.ts';
import { getRegisteredApiKey, getRegisteredStoreResponses } from './runtime/providers.ts';
import { reconstructInterruptedStream, StreamChunkWriter } from './runtime/stream-chunks.ts';
import { createFlueFs } from './sandbox.ts';
import { valibotToJsonSchema } from './schema.ts';
import {
	createUserContextMessage,
	renderSignalMessage,
	SessionHistory,
} from './session-history.ts';
import { childSessionStorageKey } from './session-identity.ts';
import { execShellWithEvents, getErrorMessage } from './shell.ts';
import {
	classifySubmissionState,
	countConsecutiveRetryableModelErrors,
	findTrailingPartialToolBatch,
	isCompletedAssistantResponse,
	isRetryableModelError,
} from './submission-state.ts';
import { normalizeToolDefinition } from './tool.ts';
import type {
	AgentConfig,
	AgentProfile,
	CallHandle,
	ChildSessionRef,
	DispatchMessageMetadata,
	FlueEvent,
	FlueEventInput,
	FlueEventInputCallback,
	FlueFs,
	FlueHarness,
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

const MAX_DELEGATION_DEPTH = 4;
const MAX_TRANSIENT_MODEL_RETRIES = 3;
const TRANSIENT_MODEL_RETRY_BASE_DELAY_MS = 2_000;

type TurnInputMessage = Extract<FlueEvent, { type: 'turn_request' }>['input']['messages'][number];
type TurnInputTool = NonNullable<
	Extract<FlueEvent, { type: 'turn_request' }>['input']['tools']
>[number];
type TurnOutput = NonNullable<Extract<FlueEvent, { type: 'turn' }>['output']>;
type ModelToolSource = 'builtin' | 'adapter' | 'framework' | 'custom' | 'action' | 'result';
type ModelToolGroup = { source: ModelToolSource; tools: AgentTool<any>[] };
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
		// Events never carry raw image bytes — see redactEventImages().
		return { type: 'image', data: IMAGE_DATA_OMITTED, mimeType: block.mimeType };
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

interface CreateActionHarnessOptions {
	invocationId: string;
	depth: number;
	signal?: AbortSignal;
	config: AgentConfig;
	env: SessionEnv;
	tools: ToolDefinition[];
	actions: ActionDefinition[];
	retainSession(session: string): Promise<void>;
}

export interface ActionHarness extends FlueHarness {
	close(): Promise<void>;
}

export type CreateActionHarness = (options: CreateActionHarnessOptions) => ActionHarness;

type OperationKind = 'prompt' | 'skill' | 'task' | 'shell' | 'compact';

interface SessionInitOptions {
	name: string;
	storageKey: string;
	affinityKey: string;
	config: AgentConfig;
	env: SessionEnv;
	store: SessionStore;
	existingData: SessionData | null;
	onAgentEvent?: FlueEventInputCallback;
	agentTools?: ToolDefinition[];
	toolFactory?: SessionToolFactory;
	delegationDepth?: number;
	createTaskSession?: CreateTaskSession;
	actions?: ActionDefinition[];
	createActionHarness?: CreateActionHarness;
	scopeSignal?: AbortSignal;
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
			session: 'default',
			dispatchId: input.dispatchId,
			acceptedAt: input.acceptedAt,
		},
		timestamp: Date.now(),
	};
}

function dispatchMetadata(input: DispatchInput): DispatchMessageMetadata {
	return { dispatchId: input.dispatchId };
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

function modelRetryDelayMs(attempt: number): number {
	const baseDelay = TRANSIENT_MODEL_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
	return Math.round(baseDelay * (0.75 + Math.random() * 0.25));
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

export class Session implements FlueSession, AgentSubmissionSession {
	readonly name: string;
	readonly fs: FlueFs;
	metadata: Record<string, any>;

	private childSessions: ChildSessionRef[];
	private agentLoop: Agent;
	private storageKey: string;
	private affinityKey: string;
	private config: AgentConfig;
	private env: SessionEnv;
	private store: SessionStore;
	private history: SessionHistory;
	private createdAt: string | undefined;
	private compactionAbortController: AbortController | undefined;
	private modelRetryAbortController: AbortController | undefined;
	private eventCallback: FlueEventInputCallback | undefined;
	private agentTools: ToolDefinition[];
	private toolFactory: SessionToolFactory | undefined;
	private deleted = false;
	private deletionPromise: Promise<void> | undefined;
	private activeOperation: OperationKind | undefined;
	private activeOperationId: string | undefined;
	private activeOperationSettlement: Promise<void> = Promise.resolve();
	private resolveActiveOperationSettlement: (() => void) | undefined;
	private closePromise: Promise<void> | undefined;
	private toolStartTimes = new Map<string, number>();
	private turnStartTime: number | undefined;
	private activeTurnId: string | undefined;
	private activeTasks = new Set<Session>();
	private activeActionHarnesses = new Set<ActionHarness>();
	private delegationDepth: number;
	private createTaskSession: CreateTaskSession | undefined;
	private actions: ActionDefinition[];
	private createActionHarness: CreateActionHarness | undefined;
	private scopeSignal: AbortSignal | undefined;
	private onDelete: (() => void) | undefined;
	private submissionStore: AgentSubmissionStore | undefined;
	private pendingSave: Promise<void> = Promise.resolve();
	private agentLoopMessageCheckpointCursor = 0;
	private activeJournalCallbacks: ProcessAgentSubmissionOptions['journal'] | undefined;
	private activeTimeoutAt: number | undefined;
	private activeTurnCanCommitJournal = false;
	private activeStreamChunkWriter: StreamChunkWriter | undefined;
	/**
	 * Stream keys whose chunk segments belong to aborted/error turns of this
	 * session. They are kept durable so restart reconciliation can recover the
	 * partial stream, and deleted once a later turn checkpoint supersedes them.
	 */
	private staleStreamChunkKeys = new Set<string>();
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
		} else {
			// Defensive: never let a leftover writer from a failed earlier run capture
			// this turn's deltas under the old submission's stream key.
			this.activeStreamChunkWriter?.cancel();
			this.activeStreamChunkWriter = undefined;
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
		this.delegationDepth = options.delegationDepth ?? 0;
		this.createTaskSession = options.createTaskSession;
		this.actions = options.actions ?? [];
		this.createActionHarness = options.createActionHarness;
		this.scopeSignal = options.scopeSignal;
		this.onDelete = options.onDelete;
		this.submissionStore = options.submissionStore;

		this.metadata = options.existingData?.metadata ?? {};
		this.childSessions = options.existingData?.childSessions ?? [];
		this.createdAt = options.existingData?.createdAt;

		this.history = SessionHistory.fromData(options.existingData);

		const systemPrompt = this.config.systemPrompt;

		const tools = this.assembleModelTools(
			this.createBuiltinToolGroups(this.env, []),
			this.agentTools,
			[],
		);

		const previousMessages = this.history.buildContext();

		this.agentLoop = new Agent({
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

		this.agentLoopMessageCheckpointCursor = this.agentLoop.state.messages.length;
		this.eventCallback = options.onAgentEvent;
		this.agentLoop.subscribe(async (event) => {
			switch (event.type) {
				case 'agent_start':
					this.emit({ type: 'agent_start' });
					break;
				case 'turn_start':
					this.turnStartTime = Date.now();
					this.activeTurnId ??= generateTurnId();
					this.activeTurnCanCommitJournal = false;
					this.emit({ type: 'turn_start', turnId: this.activeTurnId, purpose: 'agent' });
					break;
				case 'message_start': {
					const turnId = this.activeTurnId ?? generateTurnId();
					this.activeTurnId = turnId;
					this.emit({ type: 'message_start', message: event.message, turnId });
					break;
				}
				case 'message_update': {
					this.activeStreamChunkWriter?.write(event.assistantMessageEvent);
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
				case 'message_end': {
					const turnId = this.activeTurnId ?? generateTurnId();
					this.activeTurnId = turnId;
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
					this.emit({ type: 'message_end', message: event.message, turnId });
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
				case 'tool_execution_update':
					break;
				case 'tool_execution_end':
					this.emit({
						type: 'tool',
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
					const message = event.message;
					const assistant =
						message.role === 'assistant' ? (message as AssistantMessage) : undefined;
					// An aborted/error turn is not durable progress: leave the
					// journal uncommitted and keep the persisted partial-stream
					// chunks alive so restart reconciliation can resume the
					// submission (stream recovery, transient retry, or replay
					// from the input) instead of terminally failing it. The
					// chunks become stale once a later turn commits; stage them
					// for deletion at that point.
					const turnInterrupted =
						assistant?.stopReason === 'aborted' || assistant?.stopReason === 'error';
					this.activeTurnCanCommitJournal = !turnInterrupted;
					if (turnInterrupted && this.activeStreamChunkWriter) {
						this.staleStreamChunkKeys.add(this.activeStreamChunkWriter.streamKey);
					}
					await this.checkpointHarnessMessages();
					this.emit({
						type: 'turn_messages',
						turnId,
						purpose: 'agent',
						message: event.message,
						toolResults: event.toolResults,
					});
					const output = assistant ? (toTurnMessage(assistant) as TurnOutput) : undefined;
					const model = this.agentLoop.state.model;
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
					errorLabel: 'prompt',
					callSite: 'this prompt() call',
					signal,
				});
			}),
		);
	}

	inspectSubmissionInput(input: AgentSubmissionInput): AgentSubmissionInspection {
		return this.inspectPersistedInput(
			input.kind === 'dispatch'
				? this.history.findDispatchInput(input.dispatchId)
				: this.history.findDirectSubmissionInput(input.submissionId),
		);
	}

	/**
	 * Reconstruct the submission result from persisted history for a
	 * submission whose canonical response completed but whose settlement was
	 * interrupted. Mirrors the response shape of `processSubmissionInput`
	 * (text/usage/model) without replaying any provider work, so
	 * reconciliation can resolve a waiting observer with the real result.
	 * Returns undefined when the input or a completed response is absent.
	 */
	reconstructSubmissionResult(input: AgentSubmissionInput): PromptResponse | undefined {
		const inputEntry =
			input.kind === 'dispatch'
				? this.history.findDispatchInput(input.dispatchId)
				: this.history.findDirectSubmissionInput(input.submissionId);
		if (!inputEntry) return undefined;
		const assistant = this.history
			.getActivePathSince(inputEntry.id)
			.findLast(
				(entry): entry is MessageEntry =>
					entry.type === 'message' && entry.message.role === 'assistant',
			)?.message as AssistantMessage | undefined;
		if (!assistant || !isCompletedAssistantResponse(assistant)) return undefined;
		return {
			text: assistant.content
				.flatMap((block) => (block.type === 'text' ? [block.text] : []))
				.join('\n'),
			usage: this.aggregateUsageSince(inputEntry.id),
			model: { provider: assistant.provider, id: assistant.model },
		};
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
		return this.appendRepairedToolResultBatch(assistant.id, toolRequest.toolCalls, following);
	}

	/**
	 * Complete the trailing partial tool-result batch left by a turn that was
	 * interrupted mid-batch, so resumption continues from the repaired batch
	 * instead of replaying — and re-executing — tool calls whose results were
	 * already recorded. Same conservative semantics as
	 * `repairInterruptedToolCalls`, with the batch derived from persisted
	 * history (the journal's toolRequest does not survive the next turn the
	 * abort also cut short). No-op when no trailing partial batch exists.
	 */
	private async repairTrailingPartialToolBatch(inputEntry: MessageEntry): Promise<void> {
		const following = this.history.getActivePathSince(inputEntry.id);
		const partial = findTrailingPartialToolBatch(following);
		if (!partial) return;
		await this.appendRepairedToolResultBatch(partial.entryId, partial.toolCalls, following);
	}

	/**
	 * Shared repair core: build a complete ordered result batch for
	 * `toolCalls`, preserving already-settled results (first-write-wins) and
	 * synthesizing interrupted-marker error results for unresolved calls —
	 * never a fabricated or assumed outcome. Returns the new leaf ID, or
	 * undefined when every call already has a result.
	 */
	private async appendRepairedToolResultBatch(
		assistantEntryId: string,
		toolCalls: ReadonlyArray<{ id: string; name: string }>,
		following: SessionEntry[],
	): Promise<string | undefined> {
		const settledByCallId = new Map<string, ToolResultMessage>();
		for (const entry of following) {
			if (entry.type === 'message' && entry.message.role === 'toolResult') {
				const result = entry.message as ToolResultMessage;
				if (!settledByCallId.has(result.toolCallId)) {
					settledByCallId.set(result.toolCallId, result);
				}
			}
		}

		const hasUnsettled = toolCalls.some((tc) => !settledByCallId.has(tc.id));
		if (!hasUnsettled) return undefined;

		const now = Date.now();
		const orderedResults: ToolResultMessage[] = toolCalls.map((tc) => {
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
		this.history.setLeaf(assistantEntryId);
		this.history.appendMessages(orderedResults);
		this.rebuildHarnessContext();
		await this.save();
		return this.history.getLeafId() ?? undefined;
	}

	async recoverInterruptedStream(
		streamKey: string,
		turnCheckpointLeafId?: string,
	): Promise<boolean> {
		if (!this.submissionStore) return false;
		const segments = await this.submissionStore.getStreamChunkSegments(streamKey);
		const recovered = reconstructInterruptedStream(segments, streamKey);
		if (!recovered) return false;
		const activePath = this.history.getActivePath();
		const alreadyRecovered = activePath.some(
			(entry) =>
				entry.type === 'message' &&
				entry.message.role === 'signal' &&
				entry.message.type === 'stream_continued' &&
				entry.message.attributes?.streamKey === streamKey,
		);
		if (alreadyRecovered) return true;
		// A graceful shutdown abort reaches turn_end before the process exits,
		// so the interrupted turn's partial is usually already checkpointed as
		// the trailing aborted assistant. Append only the recovery signals then
		// — re-appending the reconstructed partial would duplicate it in
		// durable history. The trailing aborted assistant belongs to this turn
		// exactly when it was appended after the turn began, i.e. it is not the
		// journal's pre-turn checkpoint leaf (a hard crash mid-turn checkpoints
		// nothing, leaving any trailing aborted assistant from an earlier turn
		// at that leaf).
		const last = activePath.at(-1);
		const partialAlreadyCheckpointed =
			last?.type === 'message' &&
			last.message.role === 'assistant' &&
			(last.message as AssistantMessage).stopReason === 'aborted' &&
			last.id !== turnCheckpointLeafId;
		this.history.appendMessages(
			partialAlreadyCheckpointed
				? [recovered.interrupted, recovered.continued]
				: [recovered.partial, recovered.interrupted, recovered.continued],
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
		this.history.appendMessage(signal, {
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
		return createCallHandle(options?.signal, (signal) =>
			this.runOperation(
				'task',
				signal,
				async () => (await this.executeTask(text, options, signal)).output,
			),
		);
	}

	shell(command: string, options?: ShellOptions): CallHandle<ShellResult> {
		return createCallHandle(options?.signal, (signal) =>
			this.runOperation('shell', signal, () =>
				// session.shell() is an out-of-band tool invocation: the caller
				// (agent code) decides to run a bash command, but it should
				// appear in the message history as if the model itself had
				// called the bash tool. That keeps the transcript readable for
				// later turns, lets compaction handle it via the same path as
				// real tool calls, and removes the synthetic-user-message
				// shape that earlier versions of this method produced. The
				// record hook appends the transcript triple before each
				// terminal tool event; harness.shell() shares the same
				// envelope without it.
				execShellWithEvents(
					this.env,
					(event) => this.emit(event),
					command,
					options,
					this.scopeSignal ? AbortSignal.any([signal, this.scopeSignal]) : signal,
					(toolCallId, args, result, isError) =>
						this.appendShellTriple(toolCallId, args, result, isError),
				),
			),
		);
	}

	async compact(): Promise<void> {
		await this.runOperation('compact', undefined, async () => {
			await this.runCompaction('manual');
		});
	}

	abort(): void {
		this.agentLoop.abort();
		this.compactionAbortController?.abort();
		this.modelRetryAbortController?.abort();
		for (const task of this.activeTasks) task.abort();
		for (const harness of this.activeActionHarnesses) void harness.close();
	}

	async settle(): Promise<void> {
		this.abort();
		await this.activeOperationSettlement;
		await Promise.allSettled([
			this.pendingSave,
			...[...this.activeTasks].map((task) => task.settle()),
			...[...this.activeActionHarnesses].map((harness) => harness.close()),
		]);
	}

	/**
	 * Detach a child task session after its task completes. Aborts pending
	 * work and fires the onDelete callback but does NOT delete stored data —
	 * child session storage is parent-owned and cleaned up when the parent
	 * session is deleted via the session-tree cascade.
	 */
	close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		this.deleted = true;
		this.abort();
		this.closePromise = this.settle().finally(() => {
			this.onDelete?.();
		});
		return this.closePromise;
	}

	delete(): Promise<void> {
		if (this.deletionPromise) return this.deletionPromise;
		if (this.deleted) return Promise.resolve();
		if (this.activeOperation) {
			return Promise.reject(
				new SessionBusyError({ session: this.name, activeOperation: this.activeOperation }),
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
		throw new ModelNotConfiguredError({ callSite });
	}

	private getProviderApiKey(providerId: string): string | undefined {
		// Undefined falls through to pi-ai's env-var lookup.
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
		if (!getRegisteredStoreResponses(model.provider)) {
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
		throw new SkillNotRegisteredError({
			skill,
			available: Object.keys(this.config.skills),
			skillsDir: skillsDirIn(this.env.cwd),
		});
	}

	// ─── Custom Tools ───────────────────────────────────────────────────────

	private createCustomTools(tools: ToolDefinition[]): AgentTool<any>[] {
		return tools.map((rawToolDef): AgentTool<any> => {
			// `defineTool()` already normalized its result; this catches inline
			// tool literals whose valibot `parameters` never went through it.
			const toolDef = normalizeToolDefinition(rawToolDef);
			return {
				name: toolDef.name,
				label: toolDef.name,
				description: toolDef.description,
				parameters: toolDef.parameters as any,
				async execute(_toolCallId: string, params: unknown, signal?: AbortSignal) {
					if (signal?.aborted) throw abortErrorFor(signal);
					const resultText = await toolDef.execute(params as Record<string, any>, signal);
					return {
						content: [{ type: 'text' as const, text: resultText }],
						details: { customTool: toolDef.name },
					};
				},
			};
		});
	}

	private createActionTools(): AgentTool<any>[] {
		return this.actions.map((action) => ({
			name: action.name,
			label: action.name,
			description: action.description,
			parameters: (action.input
				? valibotToJsonSchema(action.input)
				: {
						type: 'object',
						properties: {},
						additionalProperties: false,
					}) as any,
			execute: (toolCallId: string, params: unknown, signal?: AbortSignal) =>
				this.executeActionTool(action, toolCallId, params, signal),
		}));
	}

	private async executeActionTool(
		action: ActionDefinition,
		toolCallId: string,
		input: unknown,
		signal?: AbortSignal,
	): Promise<AgentToolResult<any>> {
		if (!this.createActionHarness) throw new Error('[flue] This session cannot execute Actions.');
		if (this.delegationDepth >= MAX_DELEGATION_DEPTH) {
			throw new DelegationDepthExceededError({ maxDepth: MAX_DELEGATION_DEPTH });
		}
		const parsedInput = parseActionInput(action, action.input ? input : undefined);
		const invocationId = crypto.randomUUID();
		const harness = this.createActionHarness({
			invocationId,
			depth: this.delegationDepth + 1,
			signal,
			config: this.config,
			env: this.env,
			tools: this.agentTools,
			actions: this.actions,
			retainSession: async (session) => {
				if (
					this.childSessions.some(
						(ref) =>
							ref.type === 'action' && ref.invocationId === invocationId && ref.session === session,
					)
				) {
					return;
				}
				const reference = { type: 'action', invocationId, session } as const;
				this.childSessions.push(reference);
				try {
					await this.save();
				} catch (error) {
					const index = this.childSessions.indexOf(reference);
					if (index !== -1) this.childSessions.splice(index, 1);
					throw error;
				}
			},
		});
		this.activeActionHarnesses.add(harness);
		try {
			const output = await runActionWithParsedInput(
				action,
				{ harness, log: this.createActionLogger(action.name, toolCallId) },
				parsedInput,
			);
			return {
				content: [{ type: 'text', text: output === undefined ? 'null' : JSON.stringify(output) }],
				details: { action: action.name, invocationId, toolCallId, output },
			};
		} finally {
			this.activeActionHarnesses.delete(harness);
			await harness.close();
		}
	}

	private createActionLogger(action: string, toolCallId: string) {
		const emit = (
			level: 'info' | 'warn' | 'error',
			message: string,
			attributes?: Record<string, unknown>,
		) =>
			this.emit({ type: 'log', level, message, attributes: { ...attributes, action, toolCallId } });
		return {
			info: (message: string, attributes?: Record<string, unknown>) =>
				emit('info', message, attributes),
			warn: (message: string, attributes?: Record<string, unknown>) =>
				emit('warn', message, attributes),
			error: (message: string, attributes?: Record<string, unknown>) =>
				emit('error', message, attributes),
		};
	}

	private assembleModelTools(
		baseGroups: ModelToolGroup[],
		customDefinitions: ToolDefinition[],
		extraTools: AgentTool<any>[],
	): AgentTool<any>[] {
		const groups: ModelToolGroup[] = [
			...baseGroups,
			{ source: 'custom' as const, tools: this.createCustomTools(customDefinitions) },
			{ source: 'action' as const, tools: this.createActionTools() },
			{ source: 'result' as const, tools: extraTools },
		];
		const seen = new Map<string, (typeof groups)[number]['source']>();
		const frameworkReserved = new Set([
			'task',
			'activate_skill',
			FINISH_TOOL_NAME,
			GIVE_UP_TOOL_NAME,
		]);
		for (const group of groups) {
			for (const tool of group.tools) {
				if (
					frameworkReserved.has(tool.name) &&
					group.source !== 'framework' &&
					!(
						group.source === 'result' &&
						(tool.name === FINISH_TOOL_NAME || tool.name === GIVE_UP_TOOL_NAME)
					)
				) {
					throw new ToolNameConflictError({
						name: tool.name,
						conflict: 'reserved',
						source: group.source,
						reserved: [...frameworkReserved],
					});
				}
				if (seen.has(tool.name)) {
					throw new ToolNameConflictError({
						name: tool.name,
						conflict: 'duplicate',
						source: group.source,
					});
				}
				seen.set(tool.name, group.source);
			}
		}
		return groups.flatMap((group) => group.tools);
	}

	/** Build built-in tools from the sandbox adapter or the framework defaults. */
	private createBuiltinToolGroups(
		env: SessionEnv,
		tools: ToolDefinition[],
		model?: string,
		thinkingLevel?: ThinkingLevel,
		activePackagedSkills?: Record<string, PackagedSkillDirectory>,
	): ModelToolGroup[] {
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
		const frameworkTools = (taskTool: AgentTool<any>) =>
			activateSkillTool ? [taskTool, activateSkillTool] : [taskTool];

		if (this.toolFactory) {
			let adapterTools = this.toolFactory(env, { subagents: this.config.subagents ?? {} });
			if (Object.keys(packagedSkills).length > 0) {
				const packagedRead = createPackagedSkillReadTool(packagedSkills);
				const adapterRead = adapterTools.find((tool) => tool.name === 'read');
				if (adapterRead) {
					adapterTools = adapterTools.map((tool) =>
						tool !== adapterRead
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
											: adapterRead.execute(id, params, signal);
									},
								},
					);
				} else {
					adapterTools = [...adapterTools, packagedRead];
				}
			}
			return [
				{ source: 'adapter', tools: adapterTools },
				{
					source: 'framework',
					tools: frameworkTools(createTaskTool(runTask, this.config.subagents ?? {})),
				},
			];
		}

		const builtinTools = createTools(env, {
			subagents: this.config.subagents ?? {},
			packagedSkills,
		});
		return [
			{ source: 'builtin', tools: builtinTools },
			{
				source: 'framework',
				tools: frameworkTools(createTaskTool(runTask, this.config.subagents ?? {})),
			},
		];
	}

	private async withCallOverrides<T>(
		options: CallOverrides,
		fn: (ctx: { resolvedModel: Model<any> }) => Promise<T>,
	): Promise<T> {
		const previousTools = this.agentLoop.state.tools;
		const previousModel = this.agentLoop.state.model;
		const previousThinkingLevel = this.agentLoop.state.thinkingLevel;

		const resolvedModel = this.resolveModelForCall(options.model, options.callSite);
		this.agentLoop.state.model = resolvedModel;
		this.agentLoop.state.thinkingLevel = this.resolveThinkingLevelForCall(options.thinkingLevel);
		const builtinToolGroups = this.createBuiltinToolGroups(
			this.env,
			options.tools,
			options.model,
			options.thinkingLevel,
			options.activePackagedSkills,
		);
		this.agentLoop.state.tools = this.assembleModelTools(
			builtinToolGroups,
			[...this.agentTools, ...options.tools],
			options.extraTools ?? [],
		);
		try {
			return await fn({ resolvedModel });
		} finally {
			this.agentLoop.state.tools = previousTools;
			this.agentLoop.state.model = previousModel;
			this.agentLoop.state.thinkingLevel = previousThinkingLevel;
		}
	}

	// ─── Tasks ────────────────────────────────────────────────────────────────

	private resolveDeclaredSubagent(name: string): AgentProfile {
		const subagents = this.config.subagents ?? {};
		const subagent = subagents[name];
		if (subagent) return subagent;
		throw new SubagentNotDeclaredError({ subagent: name, available: Object.keys(subagents) });
	}

	private async runTaskForTool(
		params: TaskToolParams,
		tools: ToolDefinition[],
		inheritedModel: string | undefined,
		inheritedThinkingLevel: ThinkingLevel | undefined,
		signal?: AbortSignal,
	): Promise<AgentToolResult<TaskToolResultDetails>> {
		const attachmentIds = [
			...new Set((params.attachments ?? []).map((attachment) => attachment.id)),
		];
		const images = this.history.resolveImages(attachmentIds);
		const result = await this.executeTask(
			params.prompt,
			{
				agent: params.agent,
				inheritedModel,
				inheritedThinkingLevel,
				cwd: params.cwd,
				images,
				// Subagent profiles are self-contained: the parent's call-level
				// tools flow only into agent-less tasks, never into a selected
				// profile's session.
				tools: params.agent ? undefined : tools,
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
		if (this.delegationDepth >= MAX_DELEGATION_DEPTH) {
			throw new DelegationDepthExceededError({ maxDepth: MAX_DELEGATION_DEPTH });
		}
		// Reject oversized images before creating the child session so a
		// rejected task() call stays side-effect-free.
		assertImagesWithinLimit(options?.images);
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
				depth: this.delegationDepth + 1,
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
				await child.close();
				this.activeTasks.delete(child);
			}
		}
	}

	// ─── Internal ────────────────────────────────────────────────────────────

	private async runOperation<T>(
		operation: OperationKind,
		signal: AbortSignal | undefined,
		fn: () => Promise<T>,
	): Promise<T> {
		const operationSignal =
			signal && this.scopeSignal
				? AbortSignal.any([signal, this.scopeSignal])
				: (signal ?? this.scopeSignal);
		return this.runExclusive(operation, async () => {
			if (operationSignal?.aborted) throw abortErrorFor(operationSignal);
			this.activeOperationId = generateOperationId();
			const operationId = this.activeOperationId;
			const startedAt = Date.now();
			this.emit({ type: 'operation_start', operationId, operationKind: operation });

			// Mirror Session.abort() for the duration of this call.
			// shell() doesn't use the agent loop/compaction/tasks — these
			// hooks are inert there.
			const onAbort = () => {
				this.agentLoop.abort();
				this.compactionAbortController?.abort(operationSignal?.reason);
				this.modelRetryAbortController?.abort(operationSignal?.reason);
				for (const task of this.activeTasks) task.abort();
				for (const harness of this.activeActionHarnesses) void harness.close();
			};
			operationSignal?.addEventListener('abort', onAbort, { once: true });

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
				const surfaced = operationSignal?.aborted ? abortErrorFor(operationSignal) : error;
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
				operationSignal?.removeEventListener('abort', onAbort);
				this.emit({ type: 'idle' });
				this.activeOperationId = undefined;
			}
		});
	}

	private async runExclusive<T>(operation: OperationKind, fn: () => Promise<T>): Promise<T> {
		this.assertActive();
		if (this.activeOperation) {
			throw new SessionBusyError({ session: this.name, activeOperation: this.activeOperation });
		}
		this.activeOperation = operation;
		this.activeOperationSettlement = new Promise<void>((resolve) => {
			this.resolveActiveOperationSettlement = resolve;
		});
		try {
			return await fn();
		} finally {
			this.activeOperation = undefined;
			this.resolveActiveOperationSettlement?.();
			this.resolveActiveOperationSettlement = undefined;
		}
	}

	private emit(event: FlueEventInput): void {
		const decorated = {
			...redactEventImages(event),
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
			throw new SessionDeletedError({ session: this.name });
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
		this.history.appendMessages([userMessage, assistantMessage, toolResultMessage]);
		this.rebuildHarnessContext();
		await this.save();
	}

	private rebuildHarnessContext(): void {
		const messages = this.history.buildContext();
		this.agentLoop.state.messages = messages;
		this.agentLoopMessageCheckpointCursor = messages.length;
	}

	private async checkpointHarnessMessages(): Promise<void> {
		const messages = this.agentLoop.state.messages.slice(
			this.agentLoopMessageCheckpointCursor,
		) as AgentMessage[];
		if (messages.length === 0) return;
		this.history.appendMessages(messages);
		this.agentLoopMessageCheckpointCursor = this.agentLoop.state.messages.length;
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
			} else {
				await this.activeJournalCallbacks?.committed?.({
					operationId: this.activeOperationId ?? generateOperationId(),
					turnId: this.activeTurnId ?? generateTurnId(),
					checkpointLeafId: leafId,
					committedLeafId: leafId,
				});
			}
			await this.deleteSupersededStreamChunks();
			this.activeTurnCanCommitJournal = false;
		}
	}

	/**
	 * Delete stream chunk segments that a durable turn checkpoint has just
	 * superseded: the active turn's own segments plus any segments staged by
	 * earlier aborted/error turns of this session (kept alive until now so an
	 * intervening crash could still recover the interrupted stream).
	 */
	private async deleteSupersededStreamChunks(): Promise<void> {
		if (!this.submissionStore) return;
		if (this.activeStreamChunkWriter) {
			await this.submissionStore.deleteStreamChunkSegments(this.activeStreamChunkWriter.streamKey);
		}
		for (const streamKey of this.staleStreamChunkKeys) {
			await this.submissionStore.deleteStreamChunkSegments(streamKey);
		}
		this.staleStreamChunkKeys.clear();
	}

	private async save(): Promise<void> {
		const result = this.pendingSave.then(async () => {
			const now = new Date().toISOString();
			const data = this.history.toData(
				this.affinityKey,
				this.childSessions,
				this.metadata,
				this.createdAt ?? now,
				now,
			);
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
		if (!this.childSessions.some((child) => child.type === 'task' && child.session === session)) {
			this.childSessions.push({ type: 'task', session, taskId });
			await this.save();
		}
	}

	// ─── Model-turn recovery and compaction ───────────────────────────────────

	/**
	 * Drive the agent loop with recovery: each iteration first evaluates the
	 * trailing assistant (overflow → compact, transient error → back off) and
	 * then starts the next turn, so one loop body serves both live turns and
	 * resumption of persisted state.
	 *
	 * Live callers pass only `start`; their first iteration has nothing to
	 * evaluate and recovery applies to the turns the loop itself produces.
	 * The persisted-input resume path additionally passes `resume` with the
	 * trailing assistant the classifier found after the input (if any), so
	 * the persisted state gets the same recovery evaluation before the first
	 * `continue()`. When recovery is already exhausted at resume entry, the
	 * loop throws `OperationFailedError` for `resume.errorLabel`: no live
	 * turn has run, so `agentLoop.state.errorMessage` is unset and the
	 * caller's `throwIfError` could not surface the failure.
	 */
	private async runModelTurnWithRecovery(options: {
		start: () => Promise<void>;
		signal: AbortSignal;
		resume?: { assistant: AssistantMessage | undefined; errorLabel: string };
	}): Promise<void> {
		let start = options.start;
		let assistant = options.resume?.assistant;
		let turnCompleted = false;
		let overflowRecoveryAttempted = false;

		// Cooperative halt points: checked before each turn and before recovery
		// work (compaction, retry backoff), not during provider calls. A hung
		// provider or long tool execution can exceed the deadline. That case is
		// covered by DO eviction + the attempt budget (Capability K), not this
		// check. Preemptive in-turn watchdog is deferred to Capability L.
		const throwIfHalted = () => {
			if (options.signal.aborted) throw abortErrorFor(options.signal);
			if (this.activeTimeoutAt !== undefined && Date.now() >= this.activeTimeoutAt) {
				throw new SubmissionTimeoutError();
			}
		};

		while (true) {
			const overflow =
				assistant !== undefined &&
				isContextOverflow(assistant, this.agentLoop.state.model.contextWindow ?? 0);
			const retryable = !overflow && assistant !== undefined && isRetryableModelError(assistant);

			if (turnCompleted && !overflow && !retryable) {
				// The turn the previous iteration ran settled. This exits before
				// the halt checks so a deadline that expired during the final
				// turn cannot discard its result.
				if (assistant !== undefined) {
					await this.checkCompaction(assistant);
					if (assistant.stopReason === 'error' || assistant.stopReason === 'aborted') {
						this.rebuildHarnessContext();
					}
				}
				return;
			}
			if (overflow && overflowRecoveryAttempted) {
				// Overflow persisting through a compaction attempt is not
				// recoverable here; the caller's `throwIfError` surfaces it.
				this.rebuildHarnessContext();
				return;
			}

			throwIfHalted();

			if (overflow && assistant !== undefined) {
				overflowRecoveryAttempted = true;
				this.internalLog('info', '[flue:compaction] Overflow detected, compacting and retrying...');
				this.rebuildHarnessContext();
				if (!(await this.runCompaction('overflow'))) {
					if (!turnCompleted && options.resume) {
						throw new OperationFailedError({
							operation: options.resume.errorLabel,
							reason: assistant.errorMessage ?? assistant.stopReason,
						});
					}
					return;
				}
				this.internalLog('info', '[flue:compaction] Retrying after overflow recovery...');
				start = () => this.agentLoop.continue();
			} else if (retryable && assistant !== undefined) {
				// Count trailing consecutive errors from durable history (the error
				// is already checkpointed) so isolated transient errors separated by
				// successful turns don't share one budget. This keeps the live
				// budget identical to the one a restart computes when it resumes a
				// persisted error.
				const transientRetries = countConsecutiveRetryableModelErrors(this.history.getActivePath());
				if (!(await this.waitForTransientModelRetry(assistant, transientRetries))) {
					if (!turnCompleted && options.resume) {
						throw new OperationFailedError({
							operation: options.resume.errorLabel,
							reason: assistant.errorMessage ?? assistant.stopReason,
						});
					}
					return;
				}
				start = () => this.agentLoop.continue();
			}

			// Recovery may have spent significant time compacting or backing off.
			if (overflow || retryable) throwIfHalted();

			try {
				await start();
				await this.agentLoop.waitForIdle();
				await this.checkpointHarnessMessages();
			} catch (error) {
				try {
					await this.activeStreamChunkWriter?.flush();
				} catch {
					// Best-effort: persisting partial deltas must not mask the run error.
				}
				this.activeStreamChunkWriter?.cancel();
				this.activeStreamChunkWriter = undefined;
				this.rebuildHarnessContext();
				throw error;
			}
			turnCompleted = true;

			const messages = this.agentLoop.state.messages;
			const latest = messages[messages.length - 1];
			assistant = latest?.role === 'assistant' ? (latest as AssistantMessage) : undefined;
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

		const model = this.agentLoop.state.model;
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
		const messagesBefore = this.agentLoop.state.messages.length;
		const compactionStartMs = Date.now();
		// True between `compaction_start` and its terminal `compaction` event,
		// so every started compaction emits exactly one terminal event.
		let terminalPending = false;

		try {
			const sessionModel = this.agentLoop.state.model;
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
			terminalPending = true;

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

			if (this.compactionAbortController.signal.aborted) {
				const abortError = abortErrorFor(this.compactionAbortController.signal);
				this.emit({
					type: 'compaction',
					messagesBefore,
					messagesAfter: this.agentLoop.state.messages.length,
					durationMs: durationSince(compactionStartMs),
					isError: true,
					error: serializeError(abortError),
				});
				terminalPending = false;
				if (reason === 'manual') throw abortError;
				return false;
			}

			this.history.appendCompaction({
				summary: result.summary,
				firstKeptEntryId: firstKeptEntry.id,
				tokensBefore: result.tokensBefore,
				details: result.details,
				usage: result.usage,
			});
			this.rebuildHarnessContext();

			const messagesAfter = this.agentLoop.state.messages.length;
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
				isError: false,
				usage: result.usage,
			});
			terminalPending = false;

			await this.save();
			return true;
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.internalLog('error', `[flue:compaction] Failed: ${errorMessage}`, { error });
			if (terminalPending) {
				this.emit({
					type: 'compaction',
					messagesBefore,
					messagesAfter: this.agentLoop.state.messages.length,
					durationMs: durationSince(compactionStartMs),
					isError: true,
					error: serializeError(error),
				});
			}
			// Explicit `session.compact()` calls must surface their own failure;
			// automatic threshold/overflow compaction stays best-effort.
			if (reason === 'manual') throw error;
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
		const errorMsg = this.agentLoop.state.errorMessage;
		if (errorMsg) {
			throw new OperationFailedError({ operation: context, reason: errorMsg });
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
	 * flat `agentLoop.state.messages` array, so the result is robust to
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
		const messages = this.agentLoop.state.messages;
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
		const state = classifySubmissionState(
			inputEntry ? this.history.getActivePathSince(inputEntry.id) : undefined,
			{ contextWindow: this.agentLoop.state.model?.contextWindow ?? 0 },
		);
		switch (state.kind) {
			case 'absent':
				return 'absent';
			case 'completed':
				// Inspection ignores the overflow flag: a stop/length response is a
				// settled canonical result for reconciliation, even though the
				// processing preamble would compact-and-continue a silent overflow
				// (see submission-state.ts).
				return 'completed';
			case 'resume':
				// Overflow and input-only resumes stay 'uncertain' (see
				// submission-state.ts): reconciliation compensates with its
				// provider-unreached retry special case. Every other resume mode
				// has partial progress that restart processing can safely
				// continue, so reconciliation reports it 'continuable'.
				return state.mode === 'overflow' || state.mode === 'input_only'
					? 'uncertain'
					: 'continuable';
			default:
				return 'uncertain';
		}
	}

	private async runPersistedDispatchInput(
		input: DispatchInput,
		signal: AbortSignal,
		options?: ProcessAgentSubmissionOptions,
	): Promise<PromptResponse> {
		return this.runPersistedContextInput({
			findInput: () => this.history.findDispatchInput(input.dispatchId),
			persistInput: () =>
				this.history.appendMessage(createDispatchInputSignal(input), {
					dispatch: dispatchMetadata(input),
				}),
			errorLabel: `dispatch(${input.dispatchId})`,
			callSite: 'this dispatched input',
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
					createUserContextMessage(
						this.history.prepareImagePrompt(input.payload.message, input.payload.images),
						new Date().toISOString(),
						input.payload.images,
					),
					{ directSubmissionId: input.submissionId },
				),
			errorLabel: `direct(${input.submissionId})`,
			callSite: 'this direct input',
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
			maxRetry: this.config.durability?.maxAttempts ?? DURABILITY_DEFAULT_MAX_ATTEMPTS,
			timeoutAt:
				timeoutAt ??
				(startedAt ?? Date.now()) +
					(this.config.durability?.timeoutMs ?? DURABILITY_DEFAULT_TIMEOUT_MS),
		};
	}

	private async runPersistedContextInput(options: {
		findInput: () => MessageEntry | undefined;
		persistInput: () => string;
		journal?: ProcessAgentSubmissionOptions['journal'];
		startedAt?: number;
		timeoutAt?: number;
		errorLabel: string;
		callSite: string;
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
					if (!inputEntry) {
						throw new OperationFailedError({
							operation: options.errorLabel,
							reason: 'the input could not be persisted',
						});
					}
					await options.onInputApplied?.(durability);
					const state = classifySubmissionState(this.history.getActivePathSince(inputEntry.id), {
						contextWindow: this.agentLoop.state.model.contextWindow ?? 0,
					});
					switch (state.kind) {
						case 'absent':
							// Unreachable: `following` is only classified for a found input
							// entry, and absence was already handled above.
							throw new OperationFailedError({
								operation: options.errorLabel,
								reason: 'the input could not be persisted',
							});
						case 'advanced_past_input':
							throw new OperationFailedError({
								operation: options.errorLabel,
								reason: 'the session advanced past this input before it completed',
							});
						case 'terminal_error':
							throw new OperationFailedError({
								operation: options.errorLabel,
								reason: state.reason,
							});
						case 'completed':
						case 'resume': {
							// Divergence preserved from before consolidation (see
							// submission-state.ts): a completed response flagged as silent
							// overflow is compacted and continued here, while inspection
							// reports it 'completed'.
							if (state.kind === 'completed' && !state.overflow) break;
							// A turn interrupted mid-tool-batch must not replay: repair
							// the partial batch first (recorded results preserved,
							// unresolved calls marked interrupted) so the resumed turn
							// continues from the repaired results instead of re-executing
							// tool calls that already completed.
							if (state.kind === 'resume' && state.mode === 'tool_results_partial') {
								await this.repairTrailingPartialToolBatch(inputEntry);
							}
							// Recovery for the persisted trailing assistant (overflow
							// compaction, transient-retry backoff) happens inside the turn
							// loop, which evaluates the resume assistant before its first
							// `continue()`.
							await this.runModelTurnWithRecovery({
								start: () => this.agentLoop.continue(),
								signal: options.signal,
								resume: { assistant: state.assistant, errorLabel: options.errorLabel },
							});
							this.throwIfError(options.errorLabel);
							break;
						}
						case 'tool_use_unresolved':
							// Divergence preserved from before consolidation (see
							// submission-state.ts): an unresolved tool call settles with the
							// persisted response here, while inspection reports it
							// 'uncertain'.
							break;
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
					// Defensive: the writer is normally closed in turn_end/agent_end, but a
					// failure mid-run (e.g. a checkpoint save throwing) can leave it assigned.
					// A stale writer would direct a later prompt's deltas to this
					// submission's stream key.
					this.activeStreamChunkWriter?.cancel();
					this.activeStreamChunkWriter = undefined;
				}
			},
		);
	}

	/**
	 * Shared body of `prompt()` and `skill()`: scope the runtime, optionally
	 * inject the result-tool pair, drive the agent loop, and aggregate usage.
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
		errorLabel: string;
		callSite: string;
		activePackagedSkills?: Record<string, PackagedSkillDirectory>;
		signal: AbortSignal;
	}): Promise<PromptResponse | PromptResultResponse<unknown>> {
		assertImagesWithinLimit(args.images);
		const promptText = this.history.prepareImagePrompt(args.promptText, args.images);
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
						promptText,
						resultBundle,
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
					start: () => this.agentLoop.prompt(promptText, args.images),
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
	 * Drive the agent loop through one or more turns until the LLM either calls
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
				start: () => this.agentLoop.prompt(nextPrompt, attempt === 0 ? initialImages : undefined),
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
		}
		throw new ResultUnavailableError(
			`Agent did not call \`finish\` or \`give_up\` after ${MAX_FOLLOWUPS + 1} attempts.`,
			this.getAssistantText(),
		);
	}
}

// ─── Public facade ──────────────────────────────────────────────────────────

const publicSessionsBySession = new WeakMap<Session, FlueSession>();
const internalSessionsByFacade = new WeakMap<FlueSession, Session>();

/**
 * Wrap an internal Session in a facade exposing exactly the {@link FlueSession}
 * contract. Session instances carry internal runtime surface (the durable
 * submission executor, `abort()`/`close()`, load-bearing `metadata`) that must
 * not leak to user code at runtime. Repeated calls for the same Session return
 * the same facade.
 */
export function createPublicSession(session: Session): FlueSession {
	const existing = publicSessionsBySession.get(session);
	if (existing) return existing;
	const facade: FlueSession = {
		name: session.name,
		fs: session.fs,
		prompt: session.prompt.bind(session) as FlueSession['prompt'],
		shell: session.shell.bind(session),
		skill: session.skill.bind(session) as FlueSession['skill'],
		task: session.task.bind(session) as FlueSession['task'],
		compact: session.compact.bind(session),
		delete: session.delete.bind(session),
	};
	publicSessionsBySession.set(session, facade);
	internalSessionsByFacade.set(facade, session);
	return facade;
}

/**
 * Recover the internal Session behind a facade produced by
 * {@link createPublicSession}, or `undefined` when the object is not a
 * registered facade (e.g. a test fake injected through a harness seam).
 * Runtime-internal use only (durable submission processing).
 */
export function getInternalSession(session: FlueSession): Session | undefined {
	return internalSessionsByFacade.get(session);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

export async function deleteSessionTree(
	store: SessionStore,
	storageKey: string,
	seen = new Set<string>(),
): Promise<void> {
	if (seen.has(storageKey)) return;
	seen.add(storageKey);
	const data = await store.load(storageKey);
	for (const child of data?.childSessions ?? []) {
		const childStorageKey = childSessionStorageKey(storageKey, child);
		if (childStorageKey) await deleteSessionTree(store, childStorageKey, seen);
	}
	await store.delete(storageKey);
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
