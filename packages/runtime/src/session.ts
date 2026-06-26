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
	SimpleStreamOptions,
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
	READ_SKILL_RESOURCE_TOOL_NAME,
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
	classifyConversationSubmission,
	projectConversationModelContext,
} from './conversation-projections.ts';
import {
	type ConversationRecord,
	generateConversationEntryId,
	generateConversationRecordId,
} from './conversation-records.ts';
import { getActiveConversationPath } from './conversation-reducer.ts';
import type { ConversationRecordWriter } from './conversation-writer.ts';
import { createDataEmitter } from './data.ts';
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
import {
	IMAGE_DATA_OMITTED,
	redactEventImages,
	redactObservationDetailImages,
} from './event-redaction.ts';
import { type FlueExecutionContext, interceptExecution } from './execution-interceptor.ts';
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
	prepareResultTool,
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
import {
	getProviderTelemetry,
	getRegisteredApiKey,
	getRegisteredStoreResponses,
} from './runtime/providers.ts';
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
import { getSkillReferenceDirectory } from './skill-package.ts';
import {
	classifySubmissionState,
	countConsecutiveRetryableModelErrors,
	findTrailingPartialToolBatch,
	isCompletedAssistantResponse,
	isRetryableModelError,
} from './submission-state.ts';
import { assertToolDefinition, parseToolInput, validateToolOutput } from './tool.ts';
import { getPreparedToolAdapter } from './tool-adapter.ts';
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
	FlueObservationDetail,
	FlueSession,
	MessageEntry,
	ModelRequestInfo,
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

type TurnInputMessage = Extract<FlueEvent, { type: 'turn_request' }>['request']['input']['messages'][number];
type TurnInputTool = NonNullable<
	Extract<FlueEvent, { type: 'turn_request' }>['request']['input']['tools']
>[number];
type TurnOutput = NonNullable<Extract<FlueEvent, { type: 'turn' }>['response']['output']>;
type ModelToolSource = 'builtin' | 'adapter' | 'framework' | 'custom' | 'action' | 'result';
type ModelToolGroup = { source: ModelToolSource; tools: AgentTool<any>[] };
type ToolTelemetry = {
	origin: 'model' | 'caller' | 'framework' | 'adapter';
	toolType: 'function' | 'extension' | 'datastore';
	description?: string;
};
type ActiveToolCall = {
	startedAt: number;
	toolName: string;
	telemetry: ToolTelemetry;
	startEmitted: boolean;
	error?: unknown;
	effectiveResult?: unknown;
	effectiveResultCaptured?: boolean;
};
type PreparedToolExecution = {
	args: unknown;
	run: () => Promise<AgentToolResult<any>>;
	result?(value: AgentToolResult<any>): unknown;
};

function toolResultText(value: AgentToolResult<any>): unknown {
	const content = value.content;
	if (content.length === 1 && content[0]?.type === 'text') return content[0].text;
	return content;
}

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
	executionContext: FlueExecutionContext;
	eventCallback?: FlueEventInputCallback;
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
	conversationId: string;
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
	conversationWriter?: ConversationRecordWriter;
	executionContext?: FlueExecutionContext;
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
	toolCallId?: string;
}

function getRegisteredPackagedSkills(
	skills: Record<string, AgentConfig['skills'][string]>,
): Record<string, PackagedSkillDirectory> {
	const registered: Record<string, PackagedSkillDirectory> = {};
	for (const skill of Object.values(skills)) {
		if (!('__flueSkillReference' in skill)) continue;
		const packaged = getSkillReferenceDirectory(skill);
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

function wrapProviderStream<T extends AsyncIterable<unknown> & { result(): Promise<unknown> }>(
	stream: T,
	operation: { type: 'model'; turnId: string },
	executionContext: FlueExecutionContext,
): T {
	return {
		[Symbol.asyncIterator]() {
			const iterator = stream[Symbol.asyncIterator]();
			const returnIterator = iterator.return?.bind(iterator);
			const throwIterator = iterator.throw?.bind(iterator);
			return {
				next: () => interceptExecution(operation, executionContext, () => iterator.next()),
				return: returnIterator
					? () => interceptExecution(operation, executionContext, returnIterator)
					: undefined,
				throw: throwIterator
					? (error: unknown) => interceptExecution(operation, executionContext, () => throwIterator(error))
					: undefined,
			};
		},
		result() {
			return interceptExecution(operation, executionContext, () => stream.result());
		},
	} as T;
}

function parseProviderEndpoint(value: string | undefined): { address: string; port?: number } | undefined {
	if (!value) return undefined;
	try {
		const url = new URL(value);
		return {
			address: url.hostname,
			...(url.port ? { port: Number(url.port) } : {}),
		};
	} catch {
		return undefined;
	}
}

function classifyError(error: unknown): { type: string; name?: string; code?: string; message?: string } {
	if (error instanceof DOMException && error.name === 'AbortError') {
		return { type: 'AbortError', name: error.name, message: error.message };
	}
	if (error && typeof error === 'object') {
		const value = error as { name?: unknown; code?: unknown; type?: unknown; message?: unknown };
		const name = typeof value.name === 'string' ? value.name : undefined;
		const code = typeof value.code === 'string' ? value.code : undefined;
		const type = typeof value.type === 'string' ? value.type : code ?? name ?? '_OTHER';
		return {
			type,
			...(name === undefined ? {} : { name }),
			...(code === undefined ? {} : { code }),
			...(typeof value.message === 'string' ? { message: value.message } : {}),
		};
	}
	if (typeof error === 'string') return { type: '_OTHER', message: error };
	return { type: '_OTHER' };
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
	readonly conversationId: string;
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
	private activeAgentInput: FlueObservationDetail['agentInput'];
	private activeOperationSettlement: Promise<void> = Promise.resolve();
	private resolveActiveOperationSettlement: (() => void) | undefined;
	private closePromise: Promise<void> | undefined;
	private activeToolCalls = new Map<string, ActiveToolCall>();
	private modelToolTelemetry = new WeakMap<AgentTool<any>, ToolTelemetry>();
	private activeTurnId: string | undefined;
	private modelRequests = new Map<string, ModelRequestInfo>();
	private modelRequestStartTimes = new Map<string, number>();
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
	private conversationWriter: ConversationRecordWriter | undefined;
	private canonicalAssistant:
		| {
				messageId: string;
				parentId: string | null;
				blocks: Map<number, { id: string; type: 'text' | 'reasoning'; deltaCount: number; completed: boolean }>;
		  }
		| undefined;
	private canonicalToolResultParentId: string | undefined;
	private pendingCanonicalWrites = new Set<Promise<void>>();
	private pendingToolPublications = new Map<string, () => void>();
	private executionIdentity: FlueExecutionContext;
	private readonly emitData = createDataEmitter((event) => {
		if (this.conversationWriter) {
			this.enqueueCanonical(
				[
					{
						...this.canonicalEnvelope('data'),
						type: 'data',
						dataType: event.name,
						...(event.id === undefined ? {} : { dataId: event.id }),
						data: event.data,
					},
				],
				() => this.emit(event),
			);
			return;
		}
		this.emit(event);
	});

	private emitTurnRequestAndStream: StreamFn = async (model, context, options) => {
		if (this.activeTurnId === undefined) this.activeTurnId = generateTurnId();
		const turnId = this.activeTurnId;
		const streamKey =
			!this.conversationWriter && this.activeSubmissionId && this.activeSubmissionAttemptId
				? `${this.activeSubmissionId}:${turnId}:${this.activeSubmissionAttemptId}`
				: undefined;
		const state = {
			operationId: this.activeOperationId ?? generateOperationId(),
			turnId,
			checkpointLeafId: this.history.getLeafId() ?? undefined,
			streamKey,
		};
		await this.activeJournalCallbacks?.beforeProvider?.(state);
		if (streamKey && this.submissionStore && !this.conversationWriter) {
			this.activeStreamChunkWriter = new StreamChunkWriter(this.submissionStore, streamKey);
		} else {
			// Defensive: never let a leftover writer from a failed earlier run capture
			// this turn's deltas under the old submission's stream key.
			this.activeStreamChunkWriter?.cancel();
			this.activeStreamChunkWriter = undefined;
		}
		this.emitTurnRequest(turnId, 'agent', model, context, options);
		await this.activeJournalCallbacks?.providerStarted?.(state);
		const operation = { type: 'model' as const, turnId };
		const executionContext = this.executionContext({ operationId: state.operationId, turnId });
		return interceptExecution(operation, executionContext, async () =>
			wrapProviderStream(streamSimple(model, context, options), operation, executionContext),
		);
	};

	private canonicalEnvelope(type: ConversationRecord['type'], id = generateConversationRecordId()) {
		return {
			v: 1 as const,
			id,
			type,
			conversationId: this.conversationId,
			harness: this.executionIdentity.harness ?? 'default',
			session: this.name,
			timestamp: new Date().toISOString(),
			...(this.activeSubmissionId ? { submissionId: this.activeSubmissionId } : {}),
			...(this.activeSubmissionAttemptId ? { attemptId: this.activeSubmissionAttemptId } : {}),
			...(this.activeOperationId ? { operationId: this.activeOperationId } : {}),
			...(this.activeTurnId ? { turnId: this.activeTurnId } : {}),
		};
	}

	private canonicalAppendOptions() {
		const submission =
			this.activeSubmissionId && this.activeSubmissionAttemptId
				? { submissionId: this.activeSubmissionId, attemptId: this.activeSubmissionAttemptId }
				: undefined;
		return submission ? { submission } : {};
	}

	private appendCanonical(records: readonly ConversationRecord[]): Promise<{ offset: string }> {
		if (!this.conversationWriter) return Promise.resolve({ offset: '-1' });
		return this.conversationWriter.append(records, this.canonicalAppendOptions());
	}

	private enqueueCanonical(records: readonly ConversationRecord[], publish: () => void): void {
		if (!this.conversationWriter) {
			publish();
			return;
		}
		const pending = this.conversationWriter.enqueue(records, this.canonicalAppendOptions()).then(() => publish());
		let tracked: Promise<void>;
		tracked = pending.finally(() => this.pendingCanonicalWrites.delete(tracked));
		this.pendingCanonicalWrites.add(tracked);
	}

	private async flushCanonical(): Promise<void> {
		await this.conversationWriter?.flush();
		await Promise.all(this.pendingCanonicalWrites);
	}

	private modelRequestInfo(model: Model<any> | undefined, options?: SimpleStreamOptions): ModelRequestInfo {
		if (!model) throw new Error('[flue] Missing configured model for turn telemetry.');
		const providerTelemetry = getProviderTelemetry(model.provider);
		const parsedEndpoint = parseProviderEndpoint(model.baseUrl);
		return {
			providerId: model.provider,
			providerName: providerTelemetry?.providerName ?? model.provider,
			requestedModel: model.id,
			api: model.api,
			serverAddress: providerTelemetry?.serverAddress ?? parsedEndpoint?.address,
			serverPort: providerTelemetry?.serverPort ?? parsedEndpoint?.port,
			reasoningLevel: options?.reasoning,
			maxTokens: options?.maxTokens,
			temperature: options?.temperature,
			...(this.history.getLatestCompaction() ? { contextCompacted: true as const } : {}),
		};
	}

	private emitTurnRequest(
		turnId: string,
		purpose: 'agent' | 'compaction' | 'compaction_prefix',
		model: Model<any>,
		context: {
			systemPrompt?: string;
			messages: Message[];
			tools?: Array<{ name: string; description: string; parameters: unknown }>;
		},
		options: SimpleStreamOptions | undefined,
	): void {
		const tools = context.tools?.map(
			(tool): TurnInputTool => ({
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
			}),
		);
		const request = this.modelRequestInfo(model, options);
		this.modelRequests.set(turnId, request);
		this.modelRequestStartTimes.set(turnId, Date.now());
		this.emit({
			type: 'turn_request',
			turnId,
			purpose,
			request: {
				...request,
				input: {
					systemPrompt: context.systemPrompt,
					messages: context.messages.map(toTurnMessage),
					tools,
				},
			},
		});
	}

	private emitTurn(
		turnId: string,
		purpose: 'agent' | 'compaction' | 'compaction_prefix',
		response: AssistantMessage | undefined,
		request: ModelRequestInfo,
		error?: unknown,
	): void {
		const output = response ? (toTurnMessage(response) as TurnOutput) : undefined;
		this.emit({
			type: 'turn',
			turnId,
			purpose,
			durationMs: durationSince(this.modelRequestStartTimes.get(turnId)),
			request,
			response: {
				responseId: response?.responseId,
				responseModel: response?.responseModel,
				output,
				usage: fromProviderUsage(response?.usage),
				finishReason: response?.stopReason,
				...(error !== undefined || response?.errorMessage
					? { error: classifyError(error ?? response?.errorMessage) }
					: {}),
			},
			isError:
				error !== undefined || response?.stopReason === 'error' || response?.stopReason === 'aborted',
		});
	}

	constructor(options: SessionInitOptions) {
		this.name = options.name;
		this.conversationId = options.conversationId;
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
		this.conversationWriter = options.conversationWriter;
		this.executionIdentity = options.executionContext ?? {};

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
					this.activeTurnId ??= generateTurnId();
					this.activeTurnCanCommitJournal = false;
					this.emit({ type: 'turn_start', turnId: this.activeTurnId, purpose: 'agent' });
					break;
				case 'message_start': {
					const turnId = this.activeTurnId ?? generateTurnId();
					this.activeTurnId = turnId;
					if (event.message.role === 'assistant') {
						const messageId = generateConversationEntryId();
						const parentId = await this.conversationWriter?.getConversationLeaf(this.conversationId) ?? null;
						this.canonicalAssistant = { messageId, parentId, blocks: new Map() };
						this.canonicalToolResultParentId = undefined;
						const { role: _role, content: _content, stopReason: _stopReason, errorMessage: _errorMessage, timestamp: _timestamp, usage: _usage, ...modelInfo } = event.message;
						await this.appendCanonical([{
							...this.canonicalEnvelope('assistant_message_started'),
							type: 'assistant_message_started',
							messageId,
							parentId,
							modelInfo,
						}]);
					}
					this.emit({ type: 'message_start', message: event.message, turnId });
					break;
				}
				case 'message_update': {
					this.activeStreamChunkWriter?.write(event.assistantMessageEvent);
					const aEvent = event.assistantMessageEvent;
					const assistant = this.canonicalAssistant;
					if (assistant && aEvent.type === 'text_start') {
						const blockId = `block_${crypto.randomUUID()}`;
						assistant.blocks.set(aEvent.contentIndex, { id: blockId, type: 'text', deltaCount: 0, completed: false });
						await this.appendCanonical([{
							...this.canonicalEnvelope('assistant_text_started'), type: 'assistant_text_started',
							messageId: assistant.messageId, blockId, blockIndex: aEvent.contentIndex,
						}]);
					} else if (assistant && aEvent.type === 'text_delta') {
						const block = assistant.blocks.get(aEvent.contentIndex);
						if (!block || block.type !== 'text') throw new Error('[flue] Canonical text delta has no started block.');
						this.enqueueCanonical([{
							...this.canonicalEnvelope('assistant_text_delta'), type: 'assistant_text_delta',
							messageId: assistant.messageId, blockId: block.id, sequence: block.deltaCount++, delta: aEvent.delta,
						}], () => this.emit({ type: 'text_delta', text: aEvent.delta }));
					} else if (assistant && aEvent.type === 'text_end') {
						const block = assistant.blocks.get(aEvent.contentIndex);
						if (!block || block.type !== 'text') throw new Error('[flue] Canonical text completion has no started block.');
						await this.flushCanonical();
						await this.appendCanonical([{
							...this.canonicalEnvelope('assistant_text_completed'), type: 'assistant_text_completed',
							messageId: assistant.messageId, blockId: block.id, deltaCount: block.deltaCount,
						}]);
						block.completed = true;
					} else if (assistant && aEvent.type === 'thinking_start') {
						const blockId = `block_${crypto.randomUUID()}`;
						assistant.blocks.set(aEvent.contentIndex, { id: blockId, type: 'reasoning', deltaCount: 0, completed: false });
						await this.appendCanonical([{
							...this.canonicalEnvelope('assistant_reasoning_started'), type: 'assistant_reasoning_started',
							messageId: assistant.messageId, blockId, blockIndex: aEvent.contentIndex,
						}]);
						this.emit({ type: 'thinking_start', contentIndex: aEvent.contentIndex });
					} else if (assistant && aEvent.type === 'thinking_delta') {
						const block = assistant.blocks.get(aEvent.contentIndex);
						if (!block || block.type !== 'reasoning') throw new Error('[flue] Canonical reasoning delta has no started block.');
						this.enqueueCanonical([{
							...this.canonicalEnvelope('assistant_reasoning_delta'), type: 'assistant_reasoning_delta',
							messageId: assistant.messageId, blockId: block.id, sequence: block.deltaCount++, delta: aEvent.delta,
						}], () => this.emit({ type: 'thinking_delta', contentIndex: aEvent.contentIndex, delta: aEvent.delta }));
					} else if (assistant && aEvent.type === 'thinking_end') {
						const block = assistant.blocks.get(aEvent.contentIndex);
						if (!block || block.type !== 'reasoning') throw new Error('[flue] Canonical reasoning completion has no started block.');
						const content = aEvent.partial.content[aEvent.contentIndex];
						await this.flushCanonical();
						await this.appendCanonical([{
							...this.canonicalEnvelope('assistant_reasoning_completed'), type: 'assistant_reasoning_completed',
							messageId: assistant.messageId, blockId: block.id, deltaCount: block.deltaCount,
							...(content?.type === 'thinking' && content.thinkingSignature ? { encrypted: content.thinkingSignature } : {}),
						}]);
						block.completed = true;
						this.emit({ type: 'thinking_end', contentIndex: aEvent.contentIndex, content: aEvent.content });
					} else if (assistant && aEvent.type === 'toolcall_end') {
						await this.appendCanonical([{
							...this.canonicalEnvelope('assistant_tool_call'), type: 'assistant_tool_call',
							messageId: assistant.messageId, blockId: `block_${crypto.randomUUID()}`,
							blockIndex: aEvent.contentIndex, toolCallId: aEvent.toolCall.id,
							name: aEvent.toolCall.name, arguments: aEvent.toolCall.arguments,
							...(aEvent.toolCall.thoughtSignature ? { thoughtSignature: aEvent.toolCall.thoughtSignature } : {}),
						}]);
					} else if (aEvent.type === 'text_delta') {
						this.emit({ type: 'text_delta', text: aEvent.delta });
					} else if (aEvent.type === 'thinking_start') {
						this.emit({ type: 'thinking_start', contentIndex: aEvent.contentIndex });
					} else if (aEvent.type === 'thinking_delta') {
						this.emit({ type: 'thinking_delta', contentIndex: aEvent.contentIndex, delta: aEvent.delta });
					} else if (aEvent.type === 'thinking_end') {
						this.emit({ type: 'thinking_end', contentIndex: aEvent.contentIndex, content: aEvent.content });
					}
					break;
				}
				case 'message_end': {
					const turnId = this.activeTurnId ?? generateTurnId();
					this.activeTurnId = turnId;
					if (event.message.role === 'assistant') {
						const canonical = this.canonicalAssistant;
						if (canonical) {
							await this.flushCanonical();
							for (const block of canonical.blocks.values()) {
								if (block.completed) continue;
								await this.appendCanonical([block.type === 'text'
									? {
										...this.canonicalEnvelope('assistant_text_completed'), type: 'assistant_text_completed',
										messageId: canonical.messageId, blockId: block.id, deltaCount: block.deltaCount,
									}
									: {
										...this.canonicalEnvelope('assistant_reasoning_completed'), type: 'assistant_reasoning_completed',
										messageId: canonical.messageId, blockId: block.id, deltaCount: block.deltaCount,
									}]);
								block.completed = true;
							}
							await this.appendCanonical([{
								...this.canonicalEnvelope('assistant_message_completed'), type: 'assistant_message_completed',
								messageId: canonical.messageId, stopReason: event.message.stopReason,
								usage: event.message.usage,
								...(event.message.errorMessage ? { error: event.message.errorMessage } : {}),
							}]);
							this.canonicalAssistant = undefined;
						}
						const request = this.modelRequests.get(turnId) ?? this.modelRequestInfo(this.agentLoop.state.model);
						this.emitTurn(turnId, 'agent', event.message, request);
						this.modelRequests.delete(turnId);
						this.modelRequestStartTimes.delete(turnId);
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
				case 'tool_execution_start': {
					const tool = this.agentLoop.state.tools.find((candidate) => candidate.name === event.toolName);
					this.activeToolCalls.set(event.toolCallId, {
						startedAt: Date.now(),
						toolName: event.toolName,
						telemetry: tool
							? (this.modelToolTelemetry.get(tool) ?? { origin: 'model', toolType: 'function' })
							: { origin: 'model', toolType: 'function' },
						startEmitted: false,
					});
					break;
				}
				case 'tool_execution_update':
					break;
				case 'tool_execution_end': {
					const call = this.activeToolCalls.get(event.toolCallId) ?? {
						startedAt: Date.now(),
						toolName: event.toolName,
						telemetry: { origin: 'model' as const, toolType: 'function' as const },
						startEmitted: false,
					};
					if (!call.startEmitted) {
						this.emit(
							{
								type: 'tool_start',
								toolName: call.toolName,
								toolCallId: event.toolCallId,
							},
							call.telemetry,
						);
					}
					const publishTool = () =>
						this.emit(
							{
								type: 'tool',
								toolName: event.toolName,
								toolCallId: event.toolCallId,
								isError: event.isError,
								result: event.result,
								durationMs: durationSince(call.startedAt),
							},
							{
								...call.telemetry,
								...(call.effectiveResultCaptured ? { effectiveResult: call.effectiveResult } : {}),
								...(event.isError ? { errorInfo: classifyError(call.error ?? event.result) } : {}),
							},
						);
					if (this.conversationWriter) this.pendingToolPublications.set(event.toolCallId, publishTool);
					else publishTool();
					this.activeToolCalls.delete(event.toolCallId);
					break;
				}
				case 'turn_end': {
					const turnId = this.activeTurnId ?? generateTurnId();
					await this.activeStreamChunkWriter?.flush();
					if (event.toolResults.length > 0 && this.conversationWriter) {
						let parentId = this.canonicalToolResultParentId ?? await this.conversationWriter.getConversationLeaf(this.conversationId);
						for (const toolResult of event.toolResults) {
							if (!parentId) throw new Error('[flue] Canonical tool result has no assistant parent.');
							const messageId = generateConversationEntryId();
							await this.appendCanonical([{
								...this.canonicalEnvelope('tool_result'), type: 'tool_result', messageId, parentId,
								toolCallId: toolResult.toolCallId, toolName: toolResult.toolName,
								isError: toolResult.isError,
								content: await Promise.all(toolResult.content.map(async (content, index) =>
									content.type === 'text'
										? { type: 'text' as const, text: content.text }
										: {
											type: 'attachment' as const,
											attachment: {
												id: `att_tool_${toolResult.toolCallId}_${index}`,
												mimeType: content.mimeType,
												size: content.data.length,
												digest: await sha256(content.data),
											},
										},
								)),
							}]);
							parentId = messageId;
							this.pendingToolPublications.get(toolResult.toolCallId)?.();
							this.pendingToolPublications.delete(toolResult.toolCallId);
						}
						this.canonicalToolResultParentId = parentId ?? undefined;
					}
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
					this.activeTurnId = undefined;
					await this.activeStreamChunkWriter?.close();
					this.activeStreamChunkWriter = undefined;
					break;
				}
				case 'agent_end':
					await this.activeStreamChunkWriter?.flush();
					await this.checkpointHarnessMessages();
					this.emit({ type: 'agent_end', messages: event.messages });
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

	async initializeCanonicalContext(): Promise<void> {
		await this.rebuildCanonicalContext();
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

	async inspectSubmissionInput(input: AgentSubmissionInput): Promise<AgentSubmissionInspection> {
		const legacyInput = input.kind === 'dispatch'
			? this.history.findDispatchInput(input.dispatchId)
			: this.history.findDirectSubmissionInput(input.submissionId);
		if (this.conversationWriter) {
			const conversation = await this.conversationWriter.getConversation(this.conversationId);
			if (conversation?.entries.has(this.canonicalInputEntryId(input))) {
				return this.inspectCanonicalState(classifyConversationSubmission(
					conversation,
					this.canonicalInputEntryId(input),
					{ contextWindow: this.agentLoop.state.model?.contextWindow ?? 0 },
				));
			}
		}
		return this.inspectPersistedInput(legacyInput);
	}

	/**
	 * Reconstruct the submission result from persisted history for a
	 * submission whose canonical response completed but whose settlement was
	 * interrupted. Mirrors the response shape of `processSubmissionInput`
	 * (text/usage/model) without replaying any provider work, so
	 * reconciliation can resolve a waiting observer with the real result.
	 * Returns undefined when the input or a completed response is absent.
	 */
	async reconstructSubmissionResult(input: AgentSubmissionInput): Promise<PromptResponse | undefined> {
		if (this.conversationWriter) {
			const conversation = await this.conversationWriter.getConversation(this.conversationId);
			const path = conversation ? getActiveConversationPath(conversation) : [];
			const inputIndex = path.findIndex((entry) => entry.id === this.canonicalInputEntryId(input));
			if (inputIndex !== -1) {
				const following = path.slice(inputIndex + 1);
				const assistantEntry = following.findLast(
					(entry) => entry.type === 'message' && entry.message.role === 'assistant',
				);
				if (assistantEntry?.type === 'message' && assistantEntry.message.role === 'assistant') {
					const assistant = assistantEntry.message as AssistantMessage;
					if (isCompletedAssistantResponse(assistant)) {
						let usage = emptyUsage();
						for (const entry of following) {
							if (entry.type === 'message' && entry.message.role === 'assistant') {
								const value = fromProviderUsage((entry.message as AssistantMessage).usage);
								if (value) usage = addUsage(usage, value);
							} else if (entry.type === 'compaction' && entry.usage) usage = addUsage(usage, entry.usage);
						}
						return {
							text: assistant.content.flatMap((block) => block.type === 'text' ? [block.text] : []).join('\n'),
							usage,
							model: { provider: assistant.provider, id: assistant.model },
						};
					}
				}
			}
		}
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
			usage: await this.aggregateCanonicalUsageSince(inputEntry.id),
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
		attempt?: import('./agent-execution-store.ts').SubmissionAttemptRef,
	): Promise<string | undefined> {
		if (attempt && this.conversationWriter) {
			this.activeSubmissionId = attempt.submissionId;
			this.activeSubmissionAttemptId = attempt.attemptId;
			const conversation = await this.conversationWriter.getConversation(this.conversationId);
			if (conversation) {
				const path = getActiveConversationPath(conversation);
				const assistant = path.findLast(
					(entry) => entry.type === 'message' && entry.message.role === 'assistant' && entry.message.stopReason === 'toolUse',
				);
				if (assistant?.type === 'message') {
					const assistantIndex = path.findIndex((entry) => entry.id === assistant.id);
					const knownResults = path.slice(assistantIndex + 1).filter(
						(entry) => entry.type === 'message' && entry.message.role === 'toolResult',
					);
					const records: ConversationRecord[] = [{
						...this.canonicalEnvelope('active_leaf_changed', `record_tool_repair_${assistant.id}_rewind`),
						type: 'active_leaf_changed',
						leafId: assistant.id,
						previousLeafId: conversation.activeLeafId,
						reason: 'interrupted_tool_batch_repair',
					}];
					let parentId = assistant.id;
					for (const toolCall of toolRequest.toolCalls) {
						const known = knownResults.find(
							(entry) => entry.type === 'message' &&
								entry.message.role === 'toolResult' &&
								entry.message.toolCallId === toolCall.id,
						);
						const knownResult = known?.type === 'message' && known.message.role === 'toolResult'
							? known.message
							: undefined;
						const messageId = `entry_tool_repair_${assistant.id}_${toolCall.id}`;
						records.push({
							...this.canonicalEnvelope('tool_result', `record_tool_repair_${assistant.id}_${toolCall.id}`),
							type: 'tool_result',
							messageId,
							parentId,
							toolCallId: toolCall.id,
							toolName: toolCall.name,
							isError: knownResult?.isError ?? true,
							content: knownResult
								? knownResult.content.flatMap((block) => block.type === 'text'
									? [{ type: 'text' as const, text: block.text }]
									: [])
								: [{
									type: 'text',
									text: JSON.stringify({
										type: 'interrupted',
										message: 'Tool execution was interrupted before completion. The outcome is unknown.',
									}),
								}],
						});
						parentId = messageId;
					}
					await this.appendCanonical(records);
					await this.rebuildCanonicalContext();
					return parentId;
				}
			}
		}

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
		attempt: import('./agent-execution-store.ts').SubmissionAttemptRef,
		turnId: string,
	): Promise<boolean> {
		if (this.conversationWriter) {
			this.activeSubmissionId = attempt.submissionId;
			this.activeSubmissionAttemptId = attempt.attemptId;
			this.activeTurnId = turnId;
			const inProgress = await this.conversationWriter.findInProgressAssistant(
				this.conversationId,
				attempt.submissionId,
			);
			if (!inProgress) {
				const conversation = await this.conversationWriter.getConversation(this.conversationId);
				const partial = conversation
					? getActiveConversationPath(conversation).findLast(
						(entry) => entry.type === 'message' &&
							entry.submissionId === attempt.submissionId &&
							entry.message.role === 'assistant' &&
							entry.message.stopReason === 'aborted' &&
							entry.message.content.some((block) => block.type === 'text' && block.text.length > 0),
					)
					: undefined;
				if (!partial) return false;
				let parentId = partial.id;
				const records: ConversationRecord[] = [];
				for (const signalType of ['stream_interrupted', 'stream_continued'] as const) {
					const messageId = `entry_recovery_${partial.id}_${signalType}`;
					records.push({
						...this.canonicalEnvelope('signal', `record_recovery_${partial.id}_${signalType}`),
						type: 'signal',
						messageId,
						parentId,
						signalType,
						content: signalType === 'stream_interrupted'
							? 'The previous assistant stream was interrupted.'
							: 'Continue from the durable partial assistant response.',
					});
					parentId = messageId;
				}
				await this.appendCanonical(records);
				await this.rebuildCanonicalContext();
				return true;
			}
			const blocks = [...inProgress.blocks.values()];
			const continuable = !blocks.some((block) => block.type === 'tool_call') &&
				blocks.some((block) =>
					(block.type === 'text' || block.type === 'reasoning') && block.deltas.join('').length > 0,
				);
			const records: ConversationRecord[] = [];
			for (const block of blocks) {
				if ((block.type === 'text' || block.type === 'reasoning') && !block.completed) {
					records.push(block.type === 'text'
						? {
							...this.canonicalEnvelope('assistant_text_completed', `record_recovery_${inProgress.messageId}_${block.blockId}_completed`),
							type: 'assistant_text_completed',
							messageId: inProgress.messageId,
							blockId: block.blockId,
							deltaCount: block.deltas.length,
						}
						: {
							...this.canonicalEnvelope('assistant_reasoning_completed', `record_recovery_${inProgress.messageId}_${block.blockId}_completed`),
							type: 'assistant_reasoning_completed',
							messageId: inProgress.messageId,
							blockId: block.blockId,
							deltaCount: block.deltas.length,
						});
				}
			}
			records.push({
				...this.canonicalEnvelope('assistant_message_completed', `record_recovery_${inProgress.messageId}_aborted`),
				type: 'assistant_message_completed',
				messageId: inProgress.messageId,
				stopReason: 'aborted',
				usage: zeroProviderUsage(),
				error: 'Stream interrupted before completion.',
			});
			if (!continuable) {
				await this.appendCanonical(records);
				await this.rebuildCanonicalContext();
				return false;
			}
			let parentId = inProgress.messageId;
			for (const signalType of ['stream_interrupted', 'stream_continued'] as const) {
				const messageId = `entry_recovery_${inProgress.messageId}_${signalType}`;
				records.push({
					...this.canonicalEnvelope('signal', `record_recovery_${inProgress.messageId}_${signalType}`),
					type: 'signal',
					messageId,
					parentId,
					signalType,
					content: signalType === 'stream_interrupted'
						? 'The previous assistant stream was interrupted.'
						: 'Continue from the durable partial assistant response.',
				});
				parentId = messageId;
			}
			await this.appendCanonical(records);
			await this.rebuildCanonicalContext();
			return true;
		}
		if (!this.submissionStore) return false;
		const streamKey = `${attempt.submissionId}:${turnId}:${attempt.attemptId}`;
		const segments = await this.submissionStore.getStreamChunkSegments(streamKey);
		const recovered = reconstructInterruptedStream(segments, streamKey);
		if (!recovered) return false;
		const turnCheckpointLeafId = this.history.getLeafId() ?? undefined;
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
					(event, detail) => this.emit(event, detail),
					command,
					options,
					this.scopeSignal ? AbortSignal.any([signal, this.scopeSignal]) : signal,
					this.executionContext({ operationId: this.activeOperationId }),
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
		const packaged = getSkillReferenceDirectory(reference);
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

	private toolTelemetry(source: ModelToolSource, tool: AgentTool<any>): ToolTelemetry {
		return {
			origin:
				source === 'adapter'
					? 'adapter'
					: source === 'framework' || source === 'result'
						? 'framework'
						: 'model',
			toolType: source === 'action' ? 'extension' : 'function',
			description: tool.description,
		};
	}

	private wrapModelTool(
		tool: AgentTool<any>,
		source: ModelToolSource,
		prepare: (
			toolCallId: string,
			params: unknown,
			signal?: AbortSignal,
		) => PreparedToolExecution = (toolCallId, params, signal) => ({
			args: params,
			run: () => tool.execute(toolCallId, params, signal),
			result: toolResultText,
		}),
	): AgentTool<any> {
		const telemetry = this.toolTelemetry(source, tool);
		const wrapped: AgentTool<any> = {
			...tool,
			execute: async (toolCallId, params, signal) => {
				let prepared: PreparedToolExecution;
				try {
					if (signal?.aborted) throw abortErrorFor(signal);
					prepared = prepare(toolCallId, params, signal);
				} catch (error) {
					const call = this.activeToolCalls.get(toolCallId) ?? {
						startedAt: Date.now(),
						toolName: tool.name,
						telemetry,
						startEmitted: false,
					};
					call.error = error;
					if (!call.startEmitted) {
						this.emit({ type: 'tool_start', toolName: tool.name, toolCallId }, telemetry);
						call.startEmitted = true;
					}
					this.activeToolCalls.set(toolCallId, call);
					throw error;
				}
				const call = this.activeToolCalls.get(toolCallId) ?? {
					startedAt: Date.now(),
					toolName: tool.name,
					telemetry,
					startEmitted: false,
				};
				call.telemetry = telemetry;
				this.activeToolCalls.set(toolCallId, call);
				if (!call.startEmitted) {
					this.emit(
						{ type: 'tool_start', toolName: tool.name, toolCallId },
						{ ...telemetry, args: prepared.args },
					);
					call.startEmitted = true;
				}
				try {
					const result = await interceptExecution(
						{ type: 'tool', toolCallId, toolName: tool.name },
						this.executionContext(),
						prepared.run,
					);
					call.effectiveResult = prepared.result ? prepared.result(result) : result;
					call.effectiveResultCaptured = true;
					return result;
				} catch (error) {
					call.error = error;
					throw error;
				}
			},
		};
		this.modelToolTelemetry.set(wrapped, telemetry);
		return wrapped;
	}

	private createCustomTools(tools: ToolDefinition[]): AgentTool<any>[] {
		return tools.map((toolDef): AgentTool<any> => {
			const preparedToolAdapter = getPreparedToolAdapter(toolDef);
			if (!preparedToolAdapter) assertToolDefinition(toolDef, `Tool "${toolDef.name}"`);
			const tool: AgentTool<any> = {
				name: toolDef.name,
				label: toolDef.name,
				description: toolDef.description,
				parameters: (preparedToolAdapter?.parameters ??
					(toolDef.input
						? valibotToJsonSchema(toolDef.input)
						: { type: 'object', properties: {}, additionalProperties: false })) as any,
				execute: async () => {
					throw new Error('unreachable');
				},
			};
			return this.wrapModelTool(tool, 'custom', (_toolCallId, params, signal) => {
				if (preparedToolAdapter) {
					return {
						args: params,
						run: async () => ({
							content: [
								{
									type: 'text' as const,
									text: await preparedToolAdapter.execute(params as Record<string, unknown>, signal),
								},
							],
							details: { customTool: toolDef.name },
						}),
						result: toolResultText,
					};
				}
				const parsed = parseToolInput(toolDef, params, signal, this.emitData);
				return {
					args: parsed.input,
					run: async () => {
						const output = validateToolOutput(toolDef, await toolDef.run(parsed.context));
						return {
							content: [
								{
									type: 'text' as const,
									text: output === undefined ? 'null' : JSON.stringify(output),
								},
							],
							details: { customTool: toolDef.name, output },
						};
					},
					result: (value) => (value.details as { output?: unknown }).output,
				};
			});
		});
	}

	private createActionTools(): AgentTool<any>[] {
		return this.actions.map((action) => {
			const tool: AgentTool<any> = {
				name: action.name,
				label: action.name,
				description: action.description,
				parameters: (action.input ? valibotToJsonSchema(action.input) : {
					type: 'object',
					properties: {},
					additionalProperties: false,
				}) as any,
				execute: async () => {
					throw new Error('unreachable');
				},
			};
			return this.wrapModelTool(tool, 'action', (toolCallId, input, signal) => {
				const parsedInput = parseActionInput(action, action.input ? input : undefined);
				return {
					args: parsedInput.declared ? parsedInput.value : undefined,
					run: () => this.executeActionTool(action, toolCallId, parsedInput, signal),
					result: (value) => (value.details as { output?: unknown }).output,
				};
			});
		});
	}

	private async executeActionTool(
		action: ActionDefinition,
		toolCallId: string,
		parsedInput: ReturnType<typeof parseActionInput>,
		signal?: AbortSignal,
	): Promise<AgentToolResult<any>> {
		if (!this.createActionHarness) throw new Error('[flue] This session cannot execute Actions.');
		if (this.delegationDepth >= MAX_DELEGATION_DEPTH) {
			throw new DelegationDepthExceededError({ maxDepth: MAX_DELEGATION_DEPTH });
		}
		const invocationId = crypto.randomUUID();
		const harness = this.createActionHarness({
			invocationId,
			depth: this.delegationDepth + 1,
			signal,
			executionContext: this.executionIdentity,
			eventCallback: this.eventCallback,
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
				{
					harness,
					log: this.createActionLogger(action.name, toolCallId),
					emitData: this.emitData,
				},
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
			READ_SKILL_RESOURCE_TOOL_NAME,
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
		return groups.flatMap((group) =>
			group.source === 'custom' || group.source === 'action'
				? group.tools
				: group.tools.map((tool) =>
					group.source === 'result'
						? this.wrapModelTool(tool, group.source, (toolCallId, params, signal) => {
							if (signal?.aborted) throw abortErrorFor(signal);
							return prepareResultTool(tool, params) ?? {
								args: params,
								run: () => tool.execute(toolCallId, params, signal),
								result: toolResultText,
							};
						})
						: this.wrapModelTool(tool, group.source),
				),
		);
	}

	/** Build built-in tools from the sandbox adapter or the framework defaults. */
	private createBuiltinToolGroups(
		env: SessionEnv,
		tools: ToolDefinition[],
		model?: string,
		thinkingLevel?: ThinkingLevel,
		activePackagedSkills?: Record<string, PackagedSkillDirectory>,
	): ModelToolGroup[] {
		const runTask = (params: TaskToolParams, signal?: AbortSignal, toolCallId?: string) =>
			this.runTaskForTool(params, tools, model, thinkingLevel, signal, toolCallId);
		const packagedSkills = {
			...getRegisteredPackagedSkills(this.config.skills),
			...activePackagedSkills,
		};
		const skillNames = Object.keys(this.config.skills);
		const activateSkillTool =
			skillNames.length > 0
				? createActivateSkillTool(skillNames, (name) => this.activateSkillForTool(name))
				: undefined;
		const packagedRead = Object.values(packagedSkills).some((skill) =>
			Object.keys(skill.files).some((path) => path !== 'SKILL.md'),
		)
			? createPackagedSkillReadTool(packagedSkills)
			: undefined;
		const frameworkTools = (taskTool: AgentTool<any>) => [
			taskTool,
			...(activateSkillTool ? [activateSkillTool] : []),
			...(packagedRead ? [packagedRead] : []),
		];

		if (this.toolFactory) {
			let adapterTools = this.toolFactory(env, { subagents: this.config.subagents ?? {} });
			if (packagedRead) {
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
		toolCallId?: string,
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
				toolCallId,
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
			this.emit({
				type: 'task_start',
				taskId,
				prompt: text,
				agent: taskAgent?.name,
				cwd: options?.cwd,
				parentSession: this.name,
				session: child.name,
				conversationId: child.conversationId,
			}, {
				agentInput: {
					text: buildPromptText(text, options?.result),
					...(options?.images?.length
						? { images: options.images.map((image) => ({ mimeType: image.mimeType })) }
						: {}),
				},
				...(options?.toolCallId ? { toolCallId: options.toolCallId } : {}),
			});

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

			const taskChild = child;
			const output: any = await interceptExecution(
				{ type: 'task', taskId },
				this.executionContext({
					conversationId: taskChild.conversationId,
					session: taskChild.name,
					taskId,
				}),
				async () => taskChild.prompt(text, childOptions as any),
			);
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
				session: child.name,
				conversationId: child.conversationId,
			}, { agentOutput: child.agentInvocationOutput(output) });
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
				...(child ? { session: child.name, conversationId: child.conversationId } : {}),
			}, { errorInfo: classifyError(error) });
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
				const execute = () => fn();
				const result =
					operation === 'prompt' || operation === 'skill'
						? await interceptExecution(
								{ type: 'agent', operationId, operationKind: operation },
								this.executionContext({ operationId }),
								execute,
							)
						: await execute();
				this.emit({
					type: 'operation',
					operationId,
					operationKind: operation,
					durationMs: durationSince(startedAt),
					isError: false,
					result,
					usage: usageFromResult(result),
				}, operation === 'prompt' || operation === 'skill'
					? { agentInput: this.activeAgentInput, agentOutput: this.agentInvocationOutput(result) }
					: undefined);
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
				}, operation === 'prompt' || operation === 'skill'
					? { agentInput: this.activeAgentInput, errorInfo: classifyError(surfaced) }
					: undefined);
				throw surfaced;
			} finally {
				operationSignal?.removeEventListener('abort', onAbort);
				this.emit({ type: 'idle' });
				this.activeOperationId = undefined;
				this.activeAgentInput = undefined;
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

	private executionContext(overrides: Partial<FlueExecutionContext> = {}): FlueExecutionContext {
		return {
			...this.executionIdentity,
			conversationId: this.conversationId,
			session: this.name,
			...(this.activeOperationId ? { operationId: this.activeOperationId } : {}),
			...(this.activeTurnId ? { turnId: this.activeTurnId } : {}),
			...overrides,
		};
	}

	private emit(event: FlueEventInput, observation?: FlueObservationDetail): void {
		const decorated = {
			...redactEventImages(event),
			conversationId: event.conversationId ?? this.conversationId,
			session: event.session ?? this.name,
		};
		const operationId = event.operationId ?? this.activeOperationId;
		if (operationId !== undefined) decorated.operationId = operationId;
		const turnId = event.turnId ?? this.activeTurnId;
		if (turnId !== undefined) decorated.turnId = turnId;
		this.eventCallback?.(decorated, redactObservationDetailImages(observation));
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

	private async rebuildCanonicalContext(): Promise<void> {
		if (!this.conversationWriter) return;
		const conversation = await this.conversationWriter.getConversation(this.conversationId);
		if (!conversation) return;
		if (getActiveConversationPath(conversation).some((entry) => entry.type === 'message' && entry.attachmentRefs?.size)) return;
		const messages = projectConversationModelContext(conversation);
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
				this.conversationId,
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

			const canonicalConversation = this.conversationWriter
				? await this.conversationWriter.getConversation(this.conversationId)
				: undefined;
			const canonicalPath = canonicalConversation ? getActiveConversationPath(canonicalConversation) : undefined;
			const contextEntries = this.history.buildContextEntries();
			const messages = canonicalConversation
				? projectConversationModelContext(canonicalConversation)
				: contextEntries.map((entry) => entry.message);
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
			const firstKeptEntry = canonicalPath
				? canonicalPath.filter((entry) => entry.type === 'message')[preparation.firstKeptIndex]
				: contextEntries[preparation.firstKeptIndex]?.entry;
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
						const handle = { turnId: generateTurnId() };
						this.emitTurnRequest(handle.turnId, purpose, model, context, options);
						return handle;
					},
					run: (handle, execute) =>
						interceptExecution(
							{ type: 'model', turnId: handle.turnId },
							this.executionContext({ operationId: this.activeOperationId, turnId: handle.turnId }),
							execute,
						),
					end: (purpose, handle, _model, response, error): void => {
						const request = this.modelRequests.get(handle.turnId);
						if (!request) throw new Error(`[flue] Missing model request telemetry for turn "${handle.turnId}".`);
						this.emitTurn(handle.turnId, purpose, response, request, error);
						this.modelRequests.delete(handle.turnId);
						this.modelRequestStartTimes.delete(handle.turnId);
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

			if (this.conversationWriter) {
				const conversation = await this.conversationWriter.getConversation(this.conversationId);
				const sourceLeafId = conversation?.activeLeafId;
				if (!sourceLeafId) throw new Error('[flue] Canonical compaction has no source leaf.');
				await this.appendCanonical([{
					...this.canonicalEnvelope('compaction'),
					type: 'compaction',
					entryId: generateConversationEntryId(),
					parentId: sourceLeafId,
					summary: result.summary,
					firstKeptEntryId: firstKeptEntry.id,
					sourceLeafId,
					tokensBefore: result.tokensBefore,
					details: result.details,
					usage: result.usage,
				}]);
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
	private async aggregateCanonicalUsageSince(beforeLeafId: string | null): Promise<PromptUsage> {
		if (!this.conversationWriter) return this.aggregateUsageSince(beforeLeafId);
		const conversation = await this.conversationWriter.getConversation(this.conversationId);
		if (!conversation) return emptyUsage();
		const path = getActiveConversationPath(conversation);
		const start = beforeLeafId ? path.findIndex((entry) => entry.id === beforeLeafId) + 1 : 0;
		let totals = emptyUsage();
		for (const entry of path.slice(start)) {
			if (entry.type === 'message' && entry.message.role === 'assistant') {
				const usage = fromProviderUsage((entry.message as AssistantMessage).usage);
				if (usage) totals = addUsage(totals, usage);
			} else if (entry.type === 'compaction' && entry.usage) totals = addUsage(totals, entry.usage);
		}
		return totals;
	}

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

	private agentInvocationOutput(result: unknown): FlueObservationDetail['agentOutput'] {
		if (typeof result !== 'object' || result === null) return undefined;
		if ('data' in result) return { type: 'data', data: result.data };
		if ('text' in result && typeof result.text === 'string') {
			const messages = this.agentLoop.state.messages;
			for (let i = messages.length - 1; i >= 0; i--) {
				const message = messages[i];
				if (message?.role === 'assistant') {
					return { type: 'text', text: result.text, finishReason: message.stopReason };
				}
			}
		}
		return undefined;
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

	private canonicalInputEntryId(input: AgentSubmissionInput): string {
		return input.kind === 'dispatch'
			? submissionEntryId('dispatch', input.dispatchId)
			: submissionEntryId('direct', input.submissionId);
	}

	private inspectCanonicalState(state: ReturnType<typeof classifyConversationSubmission>): AgentSubmissionInspection {
		switch (state.kind) {
			case 'absent':
				return 'absent';
			case 'completed':
				return 'completed';
			case 'interrupted_partial':
				return 'continuable';
			case 'resume':
				return state.mode === 'overflow' || state.mode === 'input_only'
					? 'uncertain'
					: 'continuable';
			default:
				return 'uncertain';
		}
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
		this.activeAgentInput = { text: renderSignalMessage(createDispatchInputSignal(input)) };
		return this.runPersistedContextInput({
			findInput: () => this.history.findDispatchInput(input.dispatchId),
			createCanonicalInput: (parentId) => ({
				...this.canonicalEnvelope('signal', `record_dispatch_input_${input.dispatchId}`),
				type: 'signal',
				messageId: submissionEntryId('dispatch', input.dispatchId),
				parentId,
				dispatchId: input.dispatchId,
				signalType: 'dispatch_input',
				content: renderSignalMessage(createDispatchInputSignal(input)),
			}),
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
		this.activeAgentInput = {
			text: input.payload.message,
			...(input.payload.images?.length
				? { images: input.payload.images.map((image) => ({ mimeType: image.mimeType })) }
				: {}),
		};
		return this.runPersistedContextInput({
			findInput: () => this.history.findDirectSubmissionInput(input.submissionId),
			createCanonicalInput: async (parentId) => ({
				...this.canonicalEnvelope('user_message', `record_direct_input_${input.submissionId}`),
				type: 'user_message',
				messageId: submissionEntryId('direct', input.submissionId),
				parentId,
				content: [
					{ type: 'text', text: input.payload.message },
					...await Promise.all((input.payload.images ?? []).map(async (image, index) => ({
						type: 'attachment' as const,
						attachment: {
							id: `att_direct_${input.submissionId}_${index}`,
							mimeType: image.mimeType,
							size: image.data.length,
							digest: await sha256(image.data),
						},
					}))),
				],
			}),
			persistInput: () =>
				this.history.appendMessage(
					createUserContextMessage(
						this.history.prepareImagePrompt(input.payload.message, input.payload.images),
						new Date().toISOString(),
						input.payload.images,
					),
					{ directSubmissionId: input.submissionId },
				),
			emitPersistedInput: (entry) => {
				this.emit({
					type: 'message_end',
					message: entry.message,
					turnId: `direct-submission:${input.submissionId}:input`,
				});
			},
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
		createCanonicalInput?: (parentId: string | null) => Promise<ConversationRecord> | ConversationRecord;
		emitPersistedInput?: (entry: MessageEntry) => void;
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
					let canonicalInputEntryId: string | undefined;
					const inputAlreadyPersisted = inputEntry !== undefined;
					if (options.createCanonicalInput && this.conversationWriter) {
						const parentId = await this.conversationWriter.getConversationLeaf(this.conversationId);
						const record = await options.createCanonicalInput(parentId);
						const entryId = record.type === 'user_message' || record.type === 'signal' ? record.messageId : undefined;
						canonicalInputEntryId = entryId;
						if (!entryId || !(await this.conversationWriter.hasConversationEntry(this.conversationId, entryId))) {
							await this.appendCanonical([record]);
						}
					}
					if (!inputEntry) {
						options.persistInput();
						this.rebuildHarnessContext();
						await this.save();
						inputEntry = options.findInput();
					}
					await this.rebuildCanonicalContext();
					if (!inputEntry) {
						throw new OperationFailedError({
							operation: options.errorLabel,
							reason: 'the input could not be persisted',
						});
					}
					if (!inputAlreadyPersisted) options.emitPersistedInput?.(inputEntry);
					await options.onInputApplied?.(durability);
					const state = this.conversationWriter
						? classifyConversationSubmission(
							await this.conversationWriter.getConversation(this.conversationId) ?? (() => { throw new Error('[flue] Canonical conversation is missing.'); })(),
							canonicalInputEntryId ?? inputEntry.id,
							{ contextWindow: this.agentLoop.state.model.contextWindow ?? 0 },
						)
						: classifySubmissionState(this.history.getActivePathSince(inputEntry.id), {
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
						usage: await this.aggregateCanonicalUsageSince(inputEntry.id),
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
		this.activeAgentInput = {
			text: args.promptText,
			...(args.images?.length
				? { images: args.images.map((image) => ({ mimeType: image.mimeType })) }
				: {}),
		};
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
				const beforeLeafId = this.conversationWriter
					? await this.conversationWriter.getConversationLeaf(this.conversationId)
					: this.history.getLeafId();
				if (this.conversationWriter) {
					const messageId = generateConversationEntryId();
					await this.appendCanonical([{
						...this.canonicalEnvelope('user_message'),
						type: 'user_message',
						messageId,
						parentId: beforeLeafId,
						content: [
							{ type: 'text', text: args.promptText },
							...await Promise.all((args.images ?? []).map(async (image, index) => ({
								type: 'attachment' as const,
								attachment: {
									id: `att_prompt_${messageId}_${index}`,
									mimeType: image.mimeType,
									size: image.data.length,
									digest: await sha256(image.data),
								},
							}))),
						],
					}]);
				}
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
						usage: await this.aggregateCanonicalUsageSince(beforeLeafId),
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
					usage: await this.aggregateCanonicalUsageSince(beforeLeafId),
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
		conversationId: session.conversationId,
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

function zeroProviderUsage(): AssistantMessage['usage'] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function submissionEntryId(kind: 'direct' | 'dispatch', id: string): string {
	return `entry_${kind}_${id.replaceAll(/[^A-Za-z0-9_-]/g, '_')}`;
}

async function sha256(value: string): Promise<string> {
	const bytes = new TextEncoder().encode(value);
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
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
