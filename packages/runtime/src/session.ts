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
	aggregateConversationUsageSince,
	classifyConversationSubmission,
	getActiveConversationPathSince,
	getAssistantText,
	getLatestCompletedAssistantEntry,
	getLatestConversationCompaction,
	projectConversationModelContext,
	projectConversationModelContextEntries,
} from './conversation-projections.ts';
import {
	type ConversationRecord,
	generateConversationEntryId,
	generateConversationRecordId,
} from './conversation-records.ts';
import {
	getActiveConversationPath,
	type ReducedConversationState,
	type ReducedMessageEntry,
	toolOutcomeKey,
	toolResultEntryId,
} from './conversation-reducer.ts';
import type { ConversationRecordWriter } from './conversation-writer.ts';
import {
	AttachmentNotAvailableError,
	ConversationRecordInvariantError,
	DelegationDepthExceededError,
	ModelNotConfiguredError,
	OperationFailedError,
	SessionBusyError,
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
import { renderSignalMessage } from './message-rendering.ts';
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
import { type AttachmentStore, createAttachmentRef } from './runtime/attachment-store.ts';
import type { DispatchInput } from './runtime/dispatch-queue.ts';
import { generateOperationId, generateTurnId } from './runtime/ids.ts';
import {
	getProviderTelemetry,
	getRegisteredApiKey,
	getRegisteredStoreResponses,
} from './runtime/providers.ts';
import { createFlueFs } from './sandbox.ts';
import { valibotToJsonSchema } from './schema.ts';
import { execShellWithEvents, getErrorMessage } from './shell.ts';
import { getSkillReferenceDirectory } from './skill-package.ts';
import {
	countConsecutiveRetryableModelErrors,
	findTrailingPartialToolBatch,
	isRetryableModelError,
} from './submission-state.ts';
import { assertToolDefinition, parseToolInput, validateToolOutput } from './tool.ts';
import { getPreparedToolAdapter } from './tool-adapter.ts';
import type {
	AgentConfig,
	AgentProfile,
	CallHandle,
	FlueEvent,
	FlueEventInput,
	FlueEventInputCallback,
	FlueFs,
	FlueHarness,
	FlueObservationDetail,
	FlueSession,
	ModelRequestInfo,
	PackagedSkillDirectory,
	PromptImage,
	PromptModel,
	PromptOptions,
	PromptResponse,
	PromptResultResponse,
	PromptUsage,
	SessionEnv,
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
import { emptyUsage, fromProviderUsage } from './usage.ts';

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
	parentConversationId: string;
	taskId: string;
	parentEnv: SessionEnv;
	cwd?: string;
	agent?: AgentProfile;
	depth: number;
}

export type CreateTaskSession = (options: CreateTaskSessionOptions) => Promise<Session>;

interface CreateActionHarnessOptions {
	invocationId: string;
	parentConversationId: string;
	depth: number;
	signal?: AbortSignal;
	executionContext: FlueExecutionContext;
	eventCallback?: FlueEventInputCallback;
	config: AgentConfig;
	env: SessionEnv;
	tools: ToolDefinition[];
	actions: ActionDefinition[];
	retainSession(
		session: string,
		conversation: { conversationId: string; affinityKey: string; createdAt: string },
		harness: string,
	): Promise<void>;
}

export interface ActionHarness extends FlueHarness {
	close(): Promise<void>;
}

export type CreateActionHarness = (options: CreateActionHarnessOptions) => ActionHarness;

type OperationKind = 'prompt' | 'skill' | 'task' | 'shell' | 'compact';

interface SessionInitOptions {
	name: string;
	conversation: ReducedConversationState;
	config: AgentConfig;
	env: SessionEnv;
	onAgentEvent?: FlueEventInputCallback;
	agentTools?: ToolDefinition[];
	toolFactory?: SessionToolFactory;
	delegationDepth?: number;
	createTaskSession?: CreateTaskSession;
	actions?: ActionDefinition[];
	createActionHarness?: CreateActionHarness;
	scopeSignal?: AbortSignal;
	onClose?: () => void;
	conversationWriter: ConversationRecordWriter;
	attachmentStore: AttachmentStore;
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

	private agentLoop: Agent;
	private affinityKey: string;
	private config: AgentConfig;
	private env: SessionEnv;
	private compactionAbortController: AbortController | undefined;
	private modelRetryAbortController: AbortController | undefined;
	private eventCallback: FlueEventInputCallback | undefined;
	private agentTools: ToolDefinition[];
	private toolFactory: SessionToolFactory | undefined;
	private closed = false;
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
	private onClose: (() => void) | undefined;
	private activeTimeoutAt: number | undefined;
	private activeSubmissionId: string | undefined;
	private activeSubmissionAttemptId: string | undefined;
	private conversationWriter: ConversationRecordWriter;
	private attachmentStore: AttachmentStore;
	private canonicalAssistant:
		| {
				messageId: string;
				parentId: string | null;
				blocks: Map<number, { id: string; type: 'text' | 'reasoning'; deltaCount: number; completed: boolean }>;
		  }
		| undefined;
	private canonicalToolRequestMessageId: string | undefined;
	private canonicalToolResultParentId: string | undefined;
	private pendingCanonicalWrites = new Set<Promise<void>>();
	private pendingToolPublications = new Map<string, () => void>();
	private executionIdentity: FlueExecutionContext;

	private emitTurnRequestAndStream: StreamFn = async (model, context, options) => {
		if (this.activeTurnId === undefined) this.activeTurnId = generateTurnId();
		const turnId = this.activeTurnId;
		const operationId = this.activeOperationId ?? generateOperationId();
		this.emitTurnRequest(turnId, 'agent', model, context, options);
		const operation = { type: 'model' as const, turnId };
		const executionContext = this.executionContext({ operationId, turnId });
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
		return this.conversationWriter.append(records, this.canonicalAppendOptions());
	}

	private enqueueCanonical(records: readonly ConversationRecord[], publish: () => void): void {
		const pending = this.conversationWriter.enqueue(records, this.canonicalAppendOptions()).then(() => publish());
		let tracked: Promise<void>;
		tracked = pending.finally(() => this.pendingCanonicalWrites.delete(tracked));
		this.pendingCanonicalWrites.add(tracked);
	}

	private async flushCanonical(): Promise<void> {
		await this.conversationWriter.flush();
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
		this.conversationId = options.conversation.conversationId;
		this.affinityKey = options.conversation.affinityKey;
		this.config = options.config;
		this.env = options.env;
		this.fs = createFlueFs(options.env);
		this.agentTools = options.agentTools ?? [];
		this.toolFactory = options.toolFactory;
		this.delegationDepth = options.delegationDepth ?? 0;
		this.createTaskSession = options.createTaskSession;
		this.actions = options.actions ?? [];
		this.createActionHarness = options.createActionHarness;
		this.scopeSignal = options.scopeSignal;
		this.onClose = options.onClose;
		this.conversationWriter = options.conversationWriter;
		this.attachmentStore = options.attachmentStore;
		this.executionIdentity = options.executionContext ?? {};

		const systemPrompt = this.config.systemPrompt;

		const tools = this.assembleModelTools(
			this.createBuiltinToolGroups(this.env, []),
			this.agentTools,
			[],
		);

		const previousMessages: AgentMessage[] = [];

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

		this.eventCallback = options.onAgentEvent;
		this.agentLoop.subscribe(async (event) => {
			switch (event.type) {
				case 'agent_start':
					this.emit({ type: 'agent_start' });
					break;
				case 'turn_start':
					this.activeTurnId ??= generateTurnId();
					this.emit({ type: 'turn_start', turnId: this.activeTurnId, purpose: 'agent' });
					break;
				case 'message_start': {
					const turnId = this.activeTurnId ?? generateTurnId();
					this.activeTurnId = turnId;
					if (event.message.role === 'assistant') {
						const messageId = generateConversationEntryId();
						const parentId = await this.conversationWriter.getConversationLeaf(this.conversationId) ?? null;
						this.canonicalAssistant = { messageId, parentId, blocks: new Map() };
						this.canonicalToolRequestMessageId = undefined;
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
						const content = aEvent.partial.content[aEvent.contentIndex];
						await this.flushCanonical();
						await this.appendCanonical([{
							...this.canonicalEnvelope('assistant_text_completed'), type: 'assistant_text_completed',
							messageId: assistant.messageId, blockId: block.id, deltaCount: block.deltaCount,
							...(content?.type === 'text' && content.textSignature ? { textSignature: content.textSignature } : {}),
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
							...(content?.type === 'thinking' && content.redacted ? { redacted: true } : {}),
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
							this.canonicalToolRequestMessageId = event.message.content.some(
								(content) => content.type === 'toolCall',
							)
								? canonical.messageId
								: undefined;
							this.canonicalAssistant = undefined;
						}
						const request = this.modelRequests.get(turnId) ?? this.modelRequestInfo(this.agentLoop.state.model);
						this.emitTurn(turnId, 'agent', event.message, request);
						this.modelRequests.delete(turnId);
						this.modelRequestStartTimes.delete(turnId);
					}
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
					const assistantMessageId = this.canonicalToolRequestMessageId;
					if (!assistantMessageId) {
						throw new Error('[flue] Canonical tool outcome has no assistant request.');
					}
					const outcomeKey = `${encodeCanonicalId(assistantMessageId)}_${encodeCanonicalId(event.toolCallId)}`;
					const messageId = `entry_tool_outcome_${outcomeKey}`;
					const result = event.result as AgentToolResult<any>;
					const images = result.content.flatMap((content, index) =>
						content.type === 'image'
							? [{ id: `att_${messageId}_${index}`, mimeType: content.mimeType, data: content.data }]
							: [],
					);
					const refs = await this.persistCanonicalAttachments(images);
					let imageIndex = 0;
					const details = result.details as { output?: unknown } | undefined;
					const hasStructuredOutput =
						!event.isError && typeof details === 'object' && details !== null && 'output' in details;
					await this.appendCanonical([{
						...this.canonicalEnvelope('tool_outcome', `record_tool_outcome_${outcomeKey}`),
						type: 'tool_outcome',
						assistantMessageId,
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						isError: event.isError,
						content: result.content.map((content) => {
							if (content.type === 'text') return { type: 'text' as const, text: content.text };
							const attachment = refs[imageIndex++];
							if (!attachment) throw new Error('[flue] Canonical tool outcome attachment is missing.');
							return { type: 'attachment' as const, attachment };
						}),
						...(hasStructuredOutput ? { output: details?.output } : {}),
					}]);
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
					this.pendingToolPublications.set(event.toolCallId, publishTool);
					this.activeToolCalls.delete(event.toolCallId);
					break;
				}
				case 'turn_end': {
					const turnId = this.activeTurnId ?? generateTurnId();
					const committedToolResults = event.toolResults.length > 0;
					if (committedToolResults) {
						const parentId = this.canonicalToolResultParentId ?? await this.conversationWriter.getConversationLeaf(this.conversationId);
						if (!parentId) throw new Error('[flue] Canonical tool results have no assistant parent.');
						const assistantMessageId = this.canonicalToolRequestMessageId;
						if (!assistantMessageId) throw new Error('[flue] Canonical tool results have no assistant request.');
						const conversation = await this.requireConversation();
						const outcomeIds = event.toolResults.map((toolResult) => {
							const outcome = conversation.toolOutcomes.get(toolOutcomeKey(assistantMessageId, toolResult.toolCallId));
							if (!outcome) throw new Error('[flue] Canonical tool result has no durable outcome.');
							return outcome.recordId;
						});
						await this.appendCanonical([{
							...this.canonicalEnvelope('tool_results_committed', `record_tool_results_committed_${encodeCanonicalId(assistantMessageId)}`),
							type: 'tool_results_committed',
							assistantMessageId,
							parentId,
							outcomeIds,
						}]);
						for (const toolResult of event.toolResults) {
							this.pendingToolPublications.get(toolResult.toolCallId)?.();
							this.pendingToolPublications.delete(toolResult.toolCallId);
						}
						const finalToolResult = event.toolResults.at(-1);
						if (!finalToolResult) {
							throw new ConversationRecordInvariantError({
								recordId: `record_tool_results_committed_${encodeCanonicalId(assistantMessageId)}`,
								recordType: 'tool_results_committed',
								reason: 'A committed canonical tool-result batch must contain at least one result.',
							});
						}
						this.canonicalToolResultParentId = toolResultEntryId(assistantMessageId, finalToolResult.toolCallId);
						this.canonicalToolRequestMessageId = undefined;
					}
					this.emit({
						type: 'turn_messages',
						turnId,
						purpose: 'agent',
						message: event.message,
						toolResults: event.toolResults,
					});
					this.activeTurnId = undefined;
					break;
				}
				case 'agent_end':
					this.emit({ type: 'agent_end', messages: event.messages });
					this.activeTurnId = undefined;
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
		const conversation = await this.conversationWriter.getConversation(this.conversationId);
		if (!conversation?.entries.has(this.canonicalInputEntryId(input))) return 'absent';
		return this.inspectCanonicalState(classifyConversationSubmission(
			conversation,
			this.canonicalInputEntryId(input),
			{ contextWindow: this.agentLoop.state.model?.contextWindow ?? 0 },
		));
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
		const conversation = await this.conversationWriter.getConversation(this.conversationId);
		if (!conversation) return undefined;
		const following = getActiveConversationPathSince(conversation, this.canonicalInputEntryId(input));
		if (!following) return undefined;
		const assistantEntry = getLatestCompletedAssistantEntry(following);
		if (!assistantEntry || assistantEntry.message.role !== 'assistant') return undefined;
		const assistant = assistantEntry.message;
		const usage = aggregateConversationUsageSince(conversation, this.canonicalInputEntryId(input));
		if (!usage) return undefined;
		return {
			text: getAssistantText(assistant),
			usage,
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
	 * Complete the trailing partial tool-result batch left by a turn that was
	 * interrupted mid-batch, so resumption continues from the repaired batch
	 * instead of replaying — and re-executing — tool calls whose results were
	 * already recorded. Conservative by construction: every recorded result is
	 * preserved (first-write-wins) and unresolved calls get explicit
	 * unknown-outcome error results — never a re-execution. The batch is
	 * derived from persisted canonical history. No-op when no trailing partial
	 * batch exists.
	 */
	private async repairTrailingPartialToolBatch(inputEntryId: string): Promise<void> {
		const conversation = await this.requireConversation();
		const following = getActiveConversationPathSince(conversation, inputEntryId);
		if (!following) return;
		const messages = following.flatMap((entry) => entry.type === 'message' ? [entry] : []);
		const partial = findTrailingPartialToolBatch(messages);
		if (!partial) return;
		await this.appendRepairedToolResultBatch(
			partial.entryId,
			partial.toolCalls,
			messages,
			conversation.activeLeafId,
			conversation,
		);
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
		following: ReducedMessageEntry[],
		previousLeafId: string | null,
		conversation: ReducedConversationState,
	): Promise<string | undefined> {
		void following;
		if (previousLeafId !== assistantEntryId) return undefined;
		const finalToolCall = toolCalls.at(-1);
		if (!finalToolCall) {
			throw new ConversationRecordInvariantError({
				recordId: `record_tool_repair_commit_${encodeCanonicalId(assistantEntryId)}`,
				recordType: 'tool_results_committed',
				reason: 'A repaired canonical tool-result batch must contain at least one tool call.',
			});
		}
		const outcomeRecords: ConversationRecord[] = [];
		const outcomeIds: string[] = [];
		for (const toolCall of toolCalls) {
			const outcome = conversation.toolOutcomes.get(toolOutcomeKey(assistantEntryId, toolCall.id));
			if (outcome) {
				outcomeIds.push(outcome.recordId);
				continue;
			}
			const repairKey = `${encodeCanonicalId(assistantEntryId)}_${encodeCanonicalId(toolCall.id)}`;
			const recordId = `record_tool_repair_outcome_${repairKey}`;
			outcomeRecords.push({
				...this.canonicalEnvelope('tool_outcome', recordId),
				type: 'tool_outcome',
				assistantMessageId: assistantEntryId,
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				isError: true,
				content: [{ type: 'text', text: JSON.stringify({
					type: 'interrupted',
					message: 'Tool execution was interrupted before completion. The outcome is unknown.',
				}) }],
			});
			outcomeIds.push(recordId);
		}
		if (outcomeRecords.length > 0) await this.appendCanonical(outcomeRecords);
		await this.appendCanonical([{
			...this.canonicalEnvelope(
				'tool_results_committed',
				`record_tool_repair_commit_${encodeCanonicalId(assistantEntryId)}`,
			),
			type: 'tool_results_committed',
			assistantMessageId: assistantEntryId,
			parentId: assistantEntryId,
			outcomeIds,
		}]);
		await this.rebuildCanonicalContext();
		return toolResultEntryId(assistantEntryId, finalToolCall.id);
	}

	async recoverInterruptedStream(
		attempt: import('./agent-execution-store.ts').SubmissionAttemptRef,
		turnId?: string,
	): Promise<boolean> {
		{
			this.activeSubmissionId = attempt.submissionId;
			this.activeSubmissionAttemptId = attempt.attemptId;
			// `turnId` only cosmetically stamps the appended recovery records;
			// discovery of the partial to recover is by submissionId. Canonical-
			// only recovery passes no turnId (the journal that once carried it is
			// gone), which is harmless.
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
				const continuedEntryId = `entry_recovery_${partial.id}_stream_continued`;
				if (
					conversation?.activeLeafId === continuedEntryId &&
					conversation.entries.has(`entry_recovery_${partial.id}_stream_interrupted`) &&
					conversation.entries.has(continuedEntryId)
				) {
					await this.rebuildCanonicalContext();
					return true;
				}
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
	}

	async recordSubmissionTerminal(input: AgentSubmissionInterruption): Promise<void> {
		let body = input.message;
		if (input.interruptedTools && input.interruptedTools.length > 0) {
			const toolList = input.interruptedTools.map((t) => `  - ${t.name} (${t.id})`).join('\n');
			body += `\n\nInterrupted tool call(s):\n${toolList}`;
		}
		{
			const recordId = `record_submission_interrupted_${input.submissionId}`;
			if (await this.conversationWriter.hasRecord(recordId)) return;
			const parentId = await this.conversationWriter.getConversationLeaf(this.conversationId);
			await this.appendCanonical([{
				...this.canonicalEnvelope('signal', recordId),
				type: 'signal',
				messageId: `entry_submission_interrupted_${input.submissionId}`,
				parentId,
				signalType: 'submission_interrupted',
				content: body,
				attributes: {
					submissionId: input.submissionId,
					kind: input.kind,
					reason: input.reason,
				},
			}]);
			await this.rebuildCanonicalContext();
		}
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
			this.flushCanonical(),
			...[...this.activeTasks].map((task) => task.settle()),
			...[...this.activeActionHarnesses].map((harness) => harness.close()),
		]);
	}

	close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		this.closed = true;
		this.abort();
		this.closePromise = this.settle().finally(() => {
			this.onClose?.();
		});
		return this.closePromise;
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
				const parsed = parseToolInput(toolDef, params, signal);
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
			parentConversationId: this.conversationId,
			depth: this.delegationDepth + 1,
			signal,
			executionContext: this.executionIdentity,
			eventCallback: this.eventCallback,
			config: this.config,
			env: this.env,
			tools: this.agentTools,
			actions: this.actions,
			retainSession: async (session, conversation, harness) => {
				await this.conversationWriter.ensureChildConversation({
					parent: {
						conversationId: this.conversationId,
						harness: this.executionIdentity.harness ?? 'default',
						session: this.name,
					},
					child: {
						kind: 'action',
						conversationId: conversation.conversationId,
						harness,
						session,
						affinityKey: conversation.affinityKey,
						createdAt: conversation.createdAt,
						parentConversationId: this.conversationId,
						actionInvocationId: invocationId,
					},
					ref: {
						conversationId: conversation.conversationId,
						harness,
						session,
						type: 'action',
						invocationId,
					},
				});
			},
		});
		this.activeActionHarnesses.add(harness);
		try {
			const output = await runActionWithParsedInput(
				action,
				{
					harness,
					log: this.createActionLogger(action.name, toolCallId),
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
		const images = await this.resolveCanonicalImages(attachmentIds);
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
				parentConversationId: this.conversationId,
				taskId,
				parentEnv: this.env,
				cwd: options?.cwd,
				agent: taskAgent,
				depth: this.delegationDepth + 1,
			});
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
				messageId: await child.getLatestAssistantMessageId(),
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
		if (this.closed) throw abortErrorFor(AbortSignal.abort());
	}

	/** Append a `session.shell()` call as an LLM-shaped bash tool exchange. */
	private async resolveCanonicalImages(ids: readonly string[]): Promise<PromptImage[]> {
		const conversation = await this.conversationWriter.getConversation(this.conversationId);
		if (!conversation) throw new AttachmentNotAvailableError({ attachmentId: ids[0] ?? '' });
		const available = this.visibleCanonicalAttachments(conversation);
		const images: PromptImage[] = [];
		for (const id of ids) {
			const attachment = available.get(id);
			if (!attachment) throw new AttachmentNotAvailableError({ attachmentId: id });
			const stored = await this.attachmentStore.get({
				streamPath: this.conversationWriter.path,
				conversationId: this.conversationId,
				attachmentId: id,
			});
			if (!stored) throw new AttachmentNotAvailableError({ attachmentId: id });
			images.push({ type: 'image', data: encodeBase64(stored.bytes), mimeType: attachment.mimeType });
		}
		return images;
	}

	private visibleCanonicalAttachments(
		conversation: ReducedConversationState,
	): Map<string, import('./conversation-records.ts').AttachmentRef> {
		const available = new Map<string, import('./conversation-records.ts').AttachmentRef>();
		for (const contextEntry of projectConversationModelContextEntries(conversation, {
			resolveAttachment: (attachment) => ({ data: attachment.id, mimeType: attachment.mimeType }),
		})) {
			if (contextEntry.sourceEntry.type !== 'message') continue;
			for (const attachment of contextEntry.sourceEntry.attachmentRefs?.values() ?? []) {
				available.set(attachment.id, attachment);
			}
		}
		return available;
	}

	private async persistCanonicalAttachments(
		attachments: ReadonlyArray<{ id: string; mimeType: string; data: string; filename?: string }>,
	): Promise<import('./conversation-records.ts').AttachmentRef[]> {
		const refs: import('./conversation-records.ts').AttachmentRef[] = [];
		for (const attachment of attachments) {
			const bytes = decodeBase64(attachment.data);
			const ref = await createAttachmentRef({
				id: attachment.id,
				mimeType: attachment.mimeType,
				bytes,
				...(attachment.filename ? { filename: attachment.filename } : {}),
			});
			await this.attachmentStore.put({
				streamPath: this.conversationWriter.path,
				attachment: ref,
				bytes,
				conversationId: this.conversationId,
			});
			refs.push(ref);
		}
		return refs;
	}

	private async appendShellTriple(
		toolCallId: string,
		args: Record<string, unknown>,
		toolResult: AgentToolResult<any>,
		isError: boolean,
	): Promise<void> {
		const parentId = await this.conversationWriter.getConversationLeaf(this.conversationId);
		const userMessageId = generateConversationEntryId();
		const assistantMessageId = generateConversationEntryId();
		const resultMessageId = toolResultEntryId(assistantMessageId, toolCallId);
		const refs = await this.persistCanonicalAttachments(
				toolResult.content.flatMap((content, index) => content.type === 'image'
					? [{ id: `att_${resultMessageId}_${index}`, mimeType: content.mimeType, data: content.data }]
					: []),
		);
		let imageIndex = 0;
		const attachmentContent = () => {
			const attachment = refs[imageIndex++];
			if (!attachment) throw new Error('[flue] Canonical shell attachment is missing.');
			return { type: 'attachment' as const, attachment };
		};
		await this.appendCanonical([
				{
					...this.canonicalEnvelope('user_message'),
					type: 'user_message',
					messageId: userMessageId,
					parentId,
					content: [{ type: 'text', text: `Run this shell command:\n\n\`\`\`bash\n${String(args.command)}\n\`\`\`` }],
				},
				{
					...this.canonicalEnvelope('assistant_message_started'),
					type: 'assistant_message_started',
					messageId: assistantMessageId,
					parentId: userMessageId,
					modelInfo: { api: 'flue-shell', provider: 'flue', model: '' },
				},
				{
					...this.canonicalEnvelope('assistant_tool_call'),
					type: 'assistant_tool_call',
					messageId: assistantMessageId,
					blockId: `block_${crypto.randomUUID()}`,
					blockIndex: 0,
					toolCallId,
					name: 'bash',
					arguments: args,
				},
				{
					...this.canonicalEnvelope('assistant_message_completed'),
					type: 'assistant_message_completed',
					messageId: assistantMessageId,
					stopReason: 'toolUse',
					usage: zeroProviderUsage(),
				},
				{
					...this.canonicalEnvelope('tool_outcome', `record_tool_outcome_${encodeCanonicalId(assistantMessageId)}_${encodeCanonicalId(toolCallId)}`),
					type: 'tool_outcome',
					assistantMessageId,
					toolCallId,
					toolName: 'bash',
					isError,
					content: toolResult.content.map((content) => content.type === 'text'
						? { type: 'text' as const, text: content.text }
						: attachmentContent()),
				},
				{
					...this.canonicalEnvelope('tool_results_committed'),
					type: 'tool_results_committed',
					assistantMessageId,
					parentId: assistantMessageId,
					outcomeIds: [`record_tool_outcome_${encodeCanonicalId(assistantMessageId)}_${encodeCanonicalId(toolCallId)}`],
				},
		]);
		await this.rebuildCanonicalContext();
	}

	private async requireConversation(): Promise<ReducedConversationState> {
		const conversation = await this.conversationWriter.getConversation(this.conversationId);
		if (!conversation) throw new Error('[flue] Canonical conversation is missing.');
		return conversation;
	}

	private async resolveCanonicalContextAttachments(
		conversation: ReducedConversationState,
	): Promise<Map<string, PromptImage>> {
		const resolved = new Map<string, PromptImage>();
		for (const attachment of this.visibleCanonicalAttachments(conversation).values()) {
			const stored = await this.attachmentStore.get({
				streamPath: this.conversationWriter.path,
				conversationId: this.conversationId,
				attachmentId: attachment.id,
			});
			if (!stored) throw new AttachmentNotAvailableError({ attachmentId: attachment.id });
			resolved.set(attachment.id, {
				type: 'image',
				data: encodeBase64(stored.bytes),
				mimeType: stored.attachment.mimeType,
			});
		}
		return resolved;
	}

	private async rebuildCanonicalContext(): Promise<void> {
		const conversation = await this.requireConversation();
		const resolved = await this.resolveCanonicalContextAttachments(conversation);
		const messages = projectConversationModelContext(conversation, {
			resolveAttachment: (attachment) => {
				const image = resolved.get(attachment.id);
				if (!image) throw new AttachmentNotAvailableError({ attachmentId: attachment.id });
				return image;
			},
		});
		this.agentLoop.state.messages = messages;
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
						await this.rebuildCanonicalContext();
					}
				}
				return;
			}
			if (overflow && overflowRecoveryAttempted) {
				// Overflow persisting through a compaction attempt is not
				// recoverable here; the caller's `throwIfError` surfaces it.
				await this.rebuildCanonicalContext();
				return;
			}

			throwIfHalted();

			if (overflow && assistant !== undefined) {
				overflowRecoveryAttempted = true;
				this.internalLog('info', '[flue:compaction] Overflow detected, compacting and retrying...');
				await this.rebuildCanonicalContext();
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
				const canonicalConversation = await this.requireConversation();
				const transientRetries = countConsecutiveRetryableModelErrors(
					getActiveConversationPath(canonicalConversation).flatMap((entry) =>
						entry.type === 'message' ? [entry] : [],
					),
				);
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
			} catch (error) {
				await this.rebuildCanonicalContext();
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
			await this.rebuildCanonicalContext();
			return false;
		}
		const delayMs = modelRetryDelayMs(attempt);
		await this.rebuildCanonicalContext();
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
	 * calls) is persisted on the resulting canonical compaction usage, which
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

			const canonicalConversation = await this.requireConversation();
			const resolvedAttachments = await this.resolveCanonicalContextAttachments(canonicalConversation);
			const contextEntries = projectConversationModelContextEntries(canonicalConversation, {
				resolveAttachment: (attachment) => {
					const image = resolvedAttachments.get(attachment.id);
					if (!image) throw new AttachmentNotAvailableError({ attachmentId: attachment.id });
					return image;
				},
			});
			const messages = contextEntries.map((entry) => entry.message);
			const latestCompaction = getLatestConversationCompaction(canonicalConversation);

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
			const firstKeptEntry = contextEntries[preparation.firstKeptIndex]?.sourceEntry;
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

			{
				const conversation = await this.requireConversation();
				const sourceLeafId = conversation.activeLeafId;
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
			await this.rebuildCanonicalContext();

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
		return aggregateConversationUsageSince(await this.requireConversation(), beforeLeafId) ?? emptyUsage();
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

	private async getLatestAssistantMessageId(): Promise<string | undefined> {
		return getActiveConversationPath(await this.requireConversation()).findLast(
			(entry) => entry.type === 'message' && entry.message.role === 'assistant',
		)?.id;
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


	private async runPersistedDispatchInput(
		input: DispatchInput,
		signal: AbortSignal,
		options?: ProcessAgentSubmissionOptions,
	): Promise<PromptResponse> {
		this.activeAgentInput = { text: renderSignalMessage(createDispatchInputSignal(input)) };
		return this.runPersistedContextInput({
			inputEntryId: submissionEntryId('dispatch', input.dispatchId),
			createCanonicalInput: (parentId) => {
				const signal = createDispatchInputSignal(input);
				return {
					...this.canonicalEnvelope('signal', `record_dispatch_input_${input.dispatchId}`),
					type: 'signal',
					messageId: submissionEntryId('dispatch', input.dispatchId),
					parentId,
					dispatchId: input.dispatchId,
					signalType: signal.type,
					tagName: signal.tagName,
					content: signal.content,
					attributes: signal.attributes,
				};
			},
			errorLabel: `dispatch(${input.dispatchId})`,
			callSite: 'this dispatched input',
			onInputApplied: options?.onInputApplied,
			submissionAttempt: options?.submissionAttempt,
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
			inputEntryId: submissionEntryId('direct', input.submissionId),
			createCanonicalInput: async (parentId) => {
				const refs = await this.persistCanonicalAttachments(
					(input.payload.images ?? []).map((image, index) => ({
						id: `att_direct_${input.submissionId}_${index}`,
						mimeType: image.mimeType,
						data: image.data,
						...(image.filename ? { filename: image.filename } : {}),
					})),
				);
				return {
					...this.canonicalEnvelope('user_message', `record_direct_input_${input.submissionId}`),
					type: 'user_message',
					messageId: submissionEntryId('direct', input.submissionId),
					parentId,
					content: [
						{ type: 'text', text: input.payload.message },
						...refs.map((attachment) => ({ type: 'attachment' as const, attachment })),
					],
				};
			},
			errorLabel: `direct(${input.submissionId})`,
			callSite: 'this direct input',
			onInputApplied: options?.onInputApplied,
			submissionAttempt: options?.submissionAttempt,
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
		inputEntryId: string;
		createCanonicalInput: (parentId: string | null) => Promise<ConversationRecord> | ConversationRecord;
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
				this.activeSubmissionId = options.submissionAttempt?.submissionId;
				this.activeSubmissionAttemptId = options.submissionAttempt?.attemptId;
				const durability = this.resolveSubmissionDurability(options.startedAt, options.timeoutAt);
				this.activeTimeoutAt = durability.timeoutAt;
				try {
					const inputAlreadyPersisted = await this.conversationWriter.hasConversationEntry(
						this.conversationId,
						options.inputEntryId,
					);
					if (!inputAlreadyPersisted) {
						const parentId = await this.conversationWriter.getConversationLeaf(this.conversationId);
						await this.appendCanonical([await options.createCanonicalInput(parentId)]);
					}
					await this.rebuildCanonicalContext();
					await options.onInputApplied?.(durability);
					const state = classifyConversationSubmission(
						await this.requireConversation(),
						options.inputEntryId,
						{ contextWindow: this.agentLoop.state.model.contextWindow ?? 0 },
					);
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
								await this.repairTrailingPartialToolBatch(options.inputEntryId);
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
						case 'tool_use_unresolved': {
							// A tool turn made durable but interrupted before ANY tool
							// outcome was recorded. Repair the batch — every unresolved
							// call gets an explicit unknown-outcome error, never a
							// re-execution — and continue, identical to a partial batch.
							// (Before the turn-journal removal this was reached only when
							// the journal said the turn never started, and was settled
							// as-is; canonical recovery cannot prove "never started", so it
							// conservatively repairs and lets the model proceed.)
							await this.repairTrailingPartialToolBatch(options.inputEntryId);
							await this.runModelTurnWithRecovery({
								start: () => this.agentLoop.continue(),
								signal: options.signal,
								resume: { assistant: state.assistant, errorLabel: options.errorLabel },
							});
							this.throwIfError(options.errorLabel);
							break;
						}
					}
					return {
						text: this.getAssistantText(),
						usage: await this.aggregateCanonicalUsageSince(options.inputEntryId),
						model: { provider: resolvedModel.provider, id: resolvedModel.id },
					};
				} finally {
					this.activeSubmissionId = undefined;
					this.activeSubmissionAttemptId = undefined;
					this.activeTimeoutAt = undefined;
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
				const beforeLeafId = await this.conversationWriter.getConversationLeaf(this.conversationId);
				const messageId = generateConversationEntryId();
				const refs = await this.persistCanonicalAttachments(
					(args.images ?? []).map((image, index) => ({
						id: `att_prompt_${messageId}_${index}`,
						mimeType: image.mimeType,
						data: image.data,
					})),
				);
				await this.appendCanonical([{
					...this.canonicalEnvelope('user_message'),
					type: 'user_message',
					messageId,
					parentId: beforeLeafId,
					content: [
						{ type: 'text', text: args.promptText },
						...refs.map((attachment) => ({ type: 'attachment' as const, attachment })),
					],
				}]);
				await this.rebuildCanonicalContext();
				const projectedPrompt = this.agentLoop.state.messages.pop();
				if (projectedPrompt?.role !== 'user') {
					throw new Error('[flue] Canonical prompt projection is missing its user message.');
				}
				const projectedContent = Array.isArray(projectedPrompt.content)
					? projectedPrompt.content
					: [{ type: 'text' as const, text: projectedPrompt.content }];
				const projectedText = projectedContent
					.filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
					.map((block) => block.text)
					.join('\n');
				const projectedImages = projectedContent.filter(
					(block): block is ImageContent => block.type === 'image',
				);
				const model: PromptModel = { provider: resolvedModel.provider, id: resolvedModel.id };

				if (resultBundle) {
					const result = await this.runWithResultTools(
						projectedText,
						projectedImages,
						resultBundle,
						args.errorLabel,
						args.signal,
					);
					return {
						data: result,
						usage: await this.aggregateCanonicalUsageSince(beforeLeafId),
						model,
					};
				}

				await this.runModelTurnWithRecovery({
					start: () => this.agentLoop.prompt(projectedText, projectedImages),
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
		initialImages: ImageContent[],
		bundle: ResultToolBundle<T>,
		errorLabel: string,
		signal: AbortSignal,
	): Promise<T> {
		const MAX_FOLLOWUPS = 32;
		for (let attempt = 0; attempt <= MAX_FOLLOWUPS; attempt++) {
			if (signal.aborted) throw abortErrorFor(signal);
			await this.runModelTurnWithRecovery({
				start: () => this.agentLoop.prompt(
					attempt === 0 ? initialPrompt : buildResultFollowUpPrompt(),
					attempt === 0 ? initialImages : undefined,
				),
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

function encodeBase64(bytes: Uint8Array): string {
	let binary = '';
	for (let offset = 0; offset < bytes.length; offset += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
	}
	return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
	const binary = atob(value);
	return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encodeCanonicalId(id: string): string {
	const bytes = new TextEncoder().encode(id);
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function submissionEntryId(kind: 'direct' | 'dispatch', id: string): string {
	return `entry_${kind}_${encodeCanonicalId(id)}`;
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
