import type { McpUnavailableConnection } from './mcp-types.ts';
/**
 * Internal session implementation. Not exported publicly — user code receives
 * the facade from `createPublicSession()`, which exposes exactly the
 * `FlueSession` contract.
 */

import type {
	AgentLoopTurnUpdate,
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
import type * as v from 'valibot';
import { abortErrorFor, createCallHandle } from './abort.ts';
import {
	createActivateSkillTool,
	createBashTool,
	createEditTool,
	createGlobTool,
	createGrepTool,
	createPackagedSkillReadTool,
	createReadTool,
	createTaskTool,
	createWriteTool,
	overlayPackagedSkills,
	READ_SKILL_RESOURCE_TOOL_NAME,
	type TaskToolParams,
	type TaskToolResultDetails,
} from './agent.ts';
import {
	type AgentSubmission,
	DURABILITY_DEFAULT_MAX_ATTEMPTS,
	DURABILITY_DEFAULT_TIMEOUT_MS,
	type SubmissionDurability,
} from './agent-execution-store.ts';
import { decodeBase64, encodeBase64 } from './base64.ts';
import {
	type CompactionSettings,
	type CompactionTurnHandle,
	calculateContextTokens,
	compact,
	DEFAULT_COMPACTION_SETTINGS,
	deriveCompactionDefaults,
	isAssistantContextOverflow,
	prepareCompaction,
	shouldCompact,
} from './compaction.ts';
import { isWorkspaceSkill, skillsDirIn } from './context.ts';
import {
	aggregateConversationUsageSince,
	classifyConversationSubmission,
	getActiveConversationPathSince,
	getLatestConversationCompaction,
} from './conversation-projections.ts';
import {
	type CanonicalChildSessionRef,
	type CanonicalToolResultContent,
	type ConversationRecord,
	encodeCanonicalId,
	generateConversationEntryId,
	generateConversationRecordId,
	RESERVED_SIGNAL_TYPES,
	toolStepRecordId,
} from './conversation-records.ts';
import {
	buildConversationContext,
	buildConversationContextEntries,
	getActiveConversationPath,
	type IndexedConversationRecord,
	type InProgressAssistantMessage,
	type ReducedConversationState,
	toolOutcomeKey,
	toolResultEntryId,
} from './conversation-reducer.ts';
import type { ConversationRecordWriter } from './conversation-writer.ts';
import {
	AttachmentNotAvailableError,
	ConversationRecordInvariantError,
	classifyError,
	DelegationDepthExceededError,
	normalizeLogAttributes,
	OperationFailedError,
	SessionBusyError,
	SkillNotRegisteredError,
	SubagentNotDeclaredError,
	SubmissionTimeoutError,
	serializeEventError,
	ToolNameConflictError,
} from './errors.ts';
import {
	IMAGE_DATA_OMITTED,
	redactEventImages,
	redactObservationDetailImages,
} from './event-redaction.ts';
import { type FlueExecutionContext, interceptExecution } from './execution-interceptor.ts';
import { resolveSubagentDefinition } from './hooks/render.ts';
import type { HookStateBuffer, HookStateWrite } from './hooks/use-persistent-state.ts';
import {
	type AgentFinishContext,
	type AgentFinishDeclaration,
	type AgentOutputChannel,
	type AgentResponseToolCall,
	type AgentSignalAppend,
	type AgentStartContext,
	type AgentStartDeclaration,
	assertAppendMessage,
	type ResponseFinishContext,
	type ResponseStartContext,
	runResponseMetadataHooks,
} from './message-output.ts';
import { createUserContextMessage, renderSignalMessage } from './message-rendering.ts';
import { assertImagesWithinLimit } from './persisted-images.ts';
import { readProviderResponseDiagnostics } from './provider-diagnostics.ts';
import {
	diffResourceSnapshots,
	INSTRUCTIONS_UPDATED_SIGNAL_BODY,
	instructionsChanged,
	type ResourceKind,
	type ResourceSnapshot,
	renderEnvironmentSignalBody,
	renderMcpUnavailableSignalBody,
	renderResourceSignalBody,
} from './resources.ts';
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
	InterruptedToolCallRef,
	ProcessAgentSubmissionOptions,
	SubmissionJoinSource,
} from './runtime/agent-submissions.ts';
import { type AttachmentStore, createAttachmentRef } from './runtime/attachment-store.ts';
import {
	generateBlockId,
	generateInvocationId,
	generateOperationId,
	generateTaskId,
	generateTurnId,
} from './runtime/ids.ts';
import { getRuntimeModels, providerTelemetryName } from './runtime/providers.ts';
import { createCwdSessionEnv } from './sandbox.ts';
import { valibotToJsonSchema } from './schema.ts';
import { execShellWithEvents, getErrorMessage } from './shell.ts';
import { isSkillDefinition, packageSkillDefinition } from './skill-definition.ts';
import { getSkillReferenceDirectory } from './skill-package.ts';
import {
	countConsecutiveRetryableModelErrors,
	findTrailingPartialToolBatch,
	isRetryableModelError,
} from './submission-state.ts';
import {
	assertToolDefinition,
	claimStepName,
	cloneStepValue,
	parseToolInput,
	validateToolOutput,
} from './tool.ts';
import { getPreparedToolAdapter } from './tool-adapter.ts';
import type {
	AgentConfig,
	CallHandle,
	DeliveredMessage,
	FlueEvent,
	FlueEventInput,
	FlueEventInputCallback,
	FlueFs,
	FlueHarness,
	FlueLogger,
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
	RegisteredSkill,
	ResolvedSubagent,
	SandboxFactory,
	SessionEnv,
	SessionToolFactory,
	ShellOptions,
	ShellResult,
	Skill,
	SkillOptions,
	SubagentDefinition,
	TaskOptions,
	ThinkingLevel,
	ToolDefinition,
	ToolStep,
} from './types.ts';
import { addUsage, emptyUsage, fromProviderUsage } from './usage.ts';

const MAX_DELEGATION_DEPTH = 4;
const MAX_TRANSIENT_MODEL_RETRIES = 3;
/**
 * Defense-in-depth ceiling on `useAgentFinish` continuations per response —
 * far above sane usage (each continuation costs a model turn), matching the
 * result-tools follow-up ceiling. Not configurable: the submission's
 * durability timeout is the real budget; this only guards a hook that appends
 * unconditionally.
 */
const MAX_AGENT_FINISH_CYCLES = 32;
const TRANSIENT_MODEL_RETRY_BASE_DELAY_MS = 2_000;

type TurnInputMessage = Extract<
	FlueEvent,
	{ type: 'turn_request' }
>['request']['input']['messages'][number];
type TurnInputTool = NonNullable<
	Extract<FlueEvent, { type: 'turn_request' }>['request']['input']['tools']
>[number];
type TurnOutput = NonNullable<Extract<FlueEvent, { type: 'turn' }>['response']['output']>;
type ModelToolSource = 'builtin' | 'adapter' | 'framework' | 'custom' | 'result';
type ModelToolGroup = { source: ModelToolSource; tools: AgentTool<any>[] };
type ToolTelemetry = {
	origin: 'model' | 'caller' | 'framework' | 'adapter';
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
	/** The parent's live environment, or `undefined` when it has no sandbox. */
	parentEnv: SessionEnv | undefined;
	cwd?: string;
	agent?: ResolvedSubagent;
	depth: number;
	/**
	 * The parent `task` tool call that spawned this child, and the assistant
	 * entry holding it. Present only when the task was invoked by the model as a
	 * tool call; absent for a programmatic `session.task()`. Recorded on the
	 * child link (`child_session_retained`) as the durable join key for recovery.
	 */
	parentToolCallId?: string;
	parentAssistantEntryId?: string;
	/**
	 * Reattach to an existing child conversation instead of minting a new
	 * identity. Set during recovery, when the parent resumes an in-flight
	 * subagent in-process: the child `conversation_created` and
	 * `child_session_retained` records already exist durably, so creation is
	 * skipped and the existing conversation is loaded. Config is rebuilt from
	 * the (live, in-process) parent exactly as a fresh task would build it.
	 */
	existing?: { conversationId: string };
}

export type CreateTaskSession = (options: CreateTaskSessionOptions) => Promise<Session>;

interface CreateActionHarnessOptions {
	invocationId: string;
	depth: number;
	signal?: AbortSignal;
	executionContext: FlueExecutionContext;
	eventCallback?: FlueEventInputCallback;
	config: AgentConfig;
	env: SessionEnv | undefined;
	tools: ToolDefinition[];
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
	onAgentEvent?: FlueEventInputCallback;
	agentTools?: ToolDefinition[];
	/** Optional MCP connections that failed to resolve at initialization. */
	mcpUnavailable?: McpUnavailableConnection[];
	delegationDepth?: number;
	createTaskSession?: CreateTaskSession;
	createActionHarness?: CreateActionHarness;
	scopeSignal?: AbortSignal;
	onClose?: () => void;
	conversationWriter: ConversationRecordWriter;
	attachmentStore: AttachmentStore;
	executionContext?: FlueExecutionContext;
	/**
	 * `usePersistentState` write buffer from the harness's render (function agents
	 * only). Buffered writes drain into the same append batch as each tool
	 * batch's `tool_results_committed` record, so a state write shares the
	 * durability of the tool batch that made it.
	 */
	hookState?: HookStateBuffer;
	/**
	 * Re-render the agent function (function agents only).
	 * Called at each turn boundary after the tool batch commits: the session
	 * swaps in the fresh tools (closures over current state values) and the
	 * recomposed system prompt, so the next model call sees them.
	 */
	rerender?: SessionRerender;
	/**
	 * Client-facing output channel from the harness's render (function agents
	 * only): `useDataWriter` writes flow through its sink into
	 * immediate durable appends; lifecycle (`useAgentStart`/`useAgentFinish`)
	 * and response boundary (`useResponseStart`/`useResponseFinish`)
	 * declarations are read off it at their seams.
	 */
	output?: AgentOutputChannel;
	/**
	 * Advance the render state's delivery cursor (function agents only):
	 * `useDelivery()` returns the latest message put in front of the model,
	 * so the session moves it when a delivery joins the live response or a
	 * lifecycle callback appends a signal. Renders observe the new value from
	 * the next re-render.
	 */
	advanceDelivery?: (message: DeliveredMessage) => void;
	/**
	 * Dynamic-resource runtime (function agents only): the init render's
	 * resources, the durable baseline/narrated snapshots, and the rebaseline
	 * hook that swaps the frozen presentation surfaces at compaction.
	 */
	resources?: SessionResourceRuntime;
	/**
	 * The session's environment. Root harness sessions share the harness's
	 * mutable slot: the harness and every session it opens read the CURRENT
	 * env/toolFactory through it, so a turn-boundary environment swap in one
	 * session is immediately visible everywhere (`harness.sandbox`,
	 * later-opened sessions, new task children). Task sessions get a fresh
	 * detached slot instead — their environment is captured at creation.
	 */
	envSlot: SessionEnvSlot;
	/** Environment-swap wiring (function agents only); same routing as hookState. */
	envRuntime?: SessionEnvRuntime;
}

/** One re-render's session-facing output: what the next turn runs with. */
export type SessionRerender = () => {
	systemPrompt: string;
	tools: ToolDefinition[];
	resources: RenderedResources;
	/**
	 * The render's declared sandbox and cwd. The session only inspects
	 * PRESENCE at turn boundaries (a factory is a fresh object every render,
	 * so identity is meaningless): a presence flip triggers an environment
	 * swap; while presence holds steady the initialized environment stays.
	 */
	sandbox?: SandboxFactory;
	cwd?: string;
};

/**
 * The mutable environment of one root harness: the live `SessionEnv`, the
 * sandbox's tool factory, and the swap bookkeeping. One slot per harness,
 * shared by reference with every session the harness opens.
 */
export interface SessionEnvSlot {
	/** The live environment, or `undefined` when no sandbox is declared. */
	env: SessionEnv | undefined;
	toolFactory: SessionToolFactory | undefined;
	/**
	 * True when the environment swapped after the prompt-composition context
	 * last discovered the workspace. The prompt stays frozen mid-submission
	 * by design; the next compaction rebaseline re-discovers and clears this.
	 */
	rediscoverNeeded: boolean;
}

/**
 * Environment-swap callbacks the harness init wires in (function agents
 * only). They close over the initialization scope in client.ts — the
 * instance id, the default-env factory, and the discovery contexts backing
 * `recompose`/`mergeSkills` — so the session can swap environments without
 * owning any of that.
 */
export interface SessionEnvRuntime {
	/** Resolve a render-declared sandbox — or no environment when undefined. */
	resolve: (
		sandbox: SandboxFactory | undefined,
	) => Promise<{ env: SessionEnv | undefined; toolFactory?: SessionToolFactory }>;
	/**
	 * Re-run workspace discovery against the just-swapped env for the LIVE
	 * sets only (skill merge). The prompt-composition context is untouched —
	 * the system prompt keeps describing the init-time workspace until a
	 * compaction rebaseline, so the transcript stays coherent with the
	 * prompt the earlier turns actually ran under.
	 */
	swapDiscovery: (env: SessionEnv | undefined) => Promise<void>;
	/**
	 * Full re-discovery against the current env: rebuilds the
	 * prompt-composition context too. Called at compaction rebaseline when
	 * `rediscoverNeeded` is set — the post-compaction prompt must describe
	 * the environment the agent is actually in.
	 */
	rediscover: (env: SessionEnv | undefined) => Promise<void>;
}

/**
 * One render's model-facing resources. `snapshot` carries the declared sets
 * with content fingerprints for the narration diff; the live maps back
 * skill activation and task-agent resolution — always current, independent
 * of the frozen presentation baseline.
 */
export interface RenderedResources {
	snapshot: ResourceSnapshot;
	/** Live skill map: declared skills merged over workspace discovery. */
	skills: Record<string, RegisteredSkill>;
	/** Live subagent map for `task` resolution. */
	subagents: Record<string, SubagentDefinition>;
}

/**
 * Dynamic-resource wiring from the harness init (function agents only).
 * The session diffs each render's snapshot against the durable
 * last-narrated set and announces deltas as `resources` signals; the
 * frozen presentation surfaces (system-prompt skill catalog, task-tool
 * roster) compose from `baseline` until a compaction rebaseline calls
 * `rebaseline` with the then-current snapshot.
 */
export interface SessionResourceRuntime {
	/** Resources of the harness-init render — the model's turn-1 view. */
	initial: RenderedResources;
	/** Durable snapshots from the instance's reduced stream, when present. */
	baseline?: ResourceSnapshot;
	narrated?: ResourceSnapshot;
	/** Swap the frozen skill catalog to a new baseline (compaction). */
	rebaseline: (snapshot: ResourceSnapshot) => void;
}

interface CallOverrides {
	tools: ToolDefinition[];
	model?: string;
	thinkingLevel?: ThinkingLevel;
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
	skills: Record<string, RegisteredSkill>,
): Record<string, PackagedSkillDirectory> {
	const registered: Record<string, PackagedSkillDirectory> = {};
	for (const skill of Object.values(skills)) {
		if ('__flueSkillReference' in skill) {
			const packaged = getSkillReferenceDirectory(skill);
			if (packaged) registered[skill.id] = packaged;
		} else if (isSkillDefinition(skill)) {
			const packaged = packageSkillDefinition(skill);
			registered[packaged.id] = packaged;
		}
	}
	return registered;
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
					? (error: unknown) =>
							interceptExecution(operation, executionContext, () => throwIterator(error))
					: undefined,
			};
		},
		result() {
			return interceptExecution(operation, executionContext, () => stream.result());
		},
	} as T;
}

function parseProviderEndpoint(
	value: string | undefined,
): { address: string; port?: number } | undefined {
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
	/**
	 * The session's environment, read through the (possibly shared) slot so
	 * a turn-boundary swap is visible to every consumer at its next call —
	 * tool-group rebuilds, `session.shell()`, task creation, the fs facade.
	 */
	private envSlot: SessionEnvSlot;
	/**
	 * The live environment when a sandbox is attached, else `undefined`.
	 * Consumers that degrade gracefully (tool assembly, narration, discovery)
	 * read this one.
	 */
	private get attachedEnv(): SessionEnv | undefined {
		return this.envSlot.env;
	}

	/**
	 * The live environment, required. Sandbox-backed operations (`shell()`,
	 * `fs`, workspace-skill reads) throw here when the agent declared no
	 * sandbox — there is no default environment.
	 */
	private get env(): SessionEnv {
		const env = this.envSlot.env;
		if (!env) {
			throw new Error(
				'[flue] This agent has no sandbox. Declare one with useSandbox() to use shell and filesystem operations.',
			);
		}
		return env;
	}
	private get toolFactory(): SessionToolFactory | undefined {
		return this.envSlot.toolFactory;
	}
	private envRuntime: SessionEnvRuntime | undefined;
	private compactionAbortController: AbortController | undefined;
	private modelRetryAbortController: AbortController | undefined;
	private eventCallback: FlueEventInputCallback | undefined;
	private agentTools: ToolDefinition[];
	/**
	 * Optional MCP connections that failed to resolve when this submission
	 * initialized, announced once per session before the model's first turn.
	 */
	private mcpUnavailable: McpUnavailableConnection[];
	private mcpUnavailableNarrated = false;
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
	/** Per-turn request telemetry, set at `turn_request` and cleared at the turn's end. */
	private modelRequests = new Map<string, { info: ModelRequestInfo; startedAt: number }>();
	private activeTasks = new Set<Session>();
	private activeActionHarnesses = new Set<ActionHarness>();
	private delegationDepth: number;
	private createTaskSession: CreateTaskSession | undefined;
	private createActionHarness: CreateActionHarness | undefined;
	private scopeSignal: AbortSignal | undefined;
	private activeCallOverrides: CallOverrides | undefined;
	private onClose: (() => void) | undefined;
	private activeTimeoutAt: number | undefined;
	private activeSubmissionId: string | undefined;
	private activeSubmissionAttemptId: string | undefined;
	private conversationWriter: ConversationRecordWriter;
	private attachmentStore: AttachmentStore;
	private canonicalAssistant:
		| {
				messageId: string;
				blocks: Map<
					number,
					{ id: string; type: 'text' | 'reasoning'; deltaCount: number; completed: boolean }
				>;
		  }
		| undefined;
	private canonicalToolRequestMessageId: string | undefined;
	private pendingCanonicalWrites = new Set<Promise<void>>();
	private pendingToolPublications = new Map<string, () => void>();
	private executionIdentity: FlueExecutionContext;
	private hookState: HookStateBuffer | undefined;
	private rerender: SessionRerender | undefined;
	private outputChannel: AgentOutputChannel | undefined;
	private advanceDelivery: ((message: DeliveredMessage) => void) | undefined;
	/**
	 * Dynamic resources. The live maps track the CURRENT render (skill
	 * activation and task resolution always see what the agent declares now);
	 * the baseline roster freezes the task tool's description so a resource
	 * flip never rewrites the tool spec; `lastNarratedResources` is the
	 * in-memory copy of the durable diff base, advanced only after its
	 * snapshot record commits.
	 */
	private resourceRuntime: SessionResourceRuntime | undefined;
	private liveSkills: Record<string, RegisteredSkill>;
	private liveSubagents: Record<string, SubagentDefinition>;
	private lastNarratedResources: ResourceSnapshot | undefined;
	private lastRenderedResources: RenderedResources | undefined;
	/** First assistant messageId of the active submission (the response message). */
	private responseMessageId: string | undefined;
	/** Whether the active submission has a durably completed assistant step (the data-write anchor). */
	private responseHasCompletedStep = false;
	/** Aggregate usage across the active submission's completed assistant steps. */
	private responseUsage: PromptUsage | undefined;
	/** Merged `useResponseStart` metadata, stamped onto the response's first started record. */
	private responseStartMetadata: Record<string, unknown> | undefined;
	/** Ordered append chain for `useDataWriter` writes; awaited before the response settles. */
	private outputWriteQueue: Promise<unknown> = Promise.resolve();
	/**
	 * `useDataWriter` writes made before the response's first durable
	 * assistant step exists (`useAgentStart` and other pre-turn-1 callbacks):
	 * canonical data-write records need a completed step to anchor to, so
	 * these buffer until the first one commits and flush with it, in order.
	 */
	private pendingPreAnchorDataWrites: Array<{ name: string; data: unknown }> = [];
	/**
	 * Lifecycle-callback appends (`ctx.append` in `useAgentStart`/
	 * `useAgentFinish`) buffered since the last flush point, in call order.
	 * Appends are steered into the live loop immediately (the model sees
	 * them at the next turn start) and their canonical records flush
	 * batch-atomically with their callback's outcome — a start hook's
	 * adoption batch, or a finish cycle's record batch. Appends can only
	 * happen inside those callback windows, so those two batches are the
	 * only durability points.
	 */
	private pendingSignalAppends: Array<{
		messageId: string;
		timestamp: string;
		signalType: string;
		tagName?: string;
		content: string;
		attributes?: Record<string, string>;
	}> = [];
	/**
	 * Turn-boundary join seam for the active submission (dispatch-while-busy),
	 * bound to the host attempt by the coordinator. Set for the duration of
	 * `runPersistedContextInput`; absent everywhere else (subagent sessions,
	 * prompt() operations, degenerate/test setups), where the queue serializes
	 * exactly as before.
	 */
	private activeJoinSource: SubmissionJoinSource | undefined;
	/** The active submission's abort signal, for join work at turn boundaries. */
	private activeJoinSignal: AbortSignal | undefined;
	/** The active submission's canonical input entry id (delivery-cursor floor). */
	private activeInputEntryId: string | undefined;

	private emitTurnRequestAndStream: StreamFn = async (model, context, options) => {
		if (this.activeTurnId === undefined) this.activeTurnId = generateTurnId();
		const turnId = this.activeTurnId;
		const operationId = this.activeOperationId ?? generateOperationId();
		this.emitTurnRequest(turnId, 'agent', model, context, options);
		const operation = { type: 'model' as const, turnId };
		const executionContext = this.executionContext({ operationId, turnId });
		return interceptExecution(operation, executionContext, async () =>
			wrapProviderStream(
				getRuntimeModels().streamSimple(model, context, options),
				operation,
				executionContext,
			),
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
		const pending = this.conversationWriter
			.enqueue(records, this.canonicalAppendOptions())
			.then(() => publish());
		let tracked: Promise<void>;
		tracked = pending.finally(() => this.pendingCanonicalWrites.delete(tracked));
		this.pendingCanonicalWrites.add(tracked);
		// Side-branch handler: the writer's coalescing timer can reject the
		// shared pending flush before flushCanonical runs, and an unobserved
		// rejection here would crash the whole Node process. The tracked
		// promise itself stays rejected for flushCanonical to surface.
		tracked.catch(() => {});
	}

	private async flushCanonical(): Promise<void> {
		// Settle the writer flush and every tracked write before surfacing a
		// failure through the operation: a failed writer throws from flush()
		// immediately, and bailing there would leave the tracked rejections
		// racing this attempt's teardown.
		const results = await Promise.allSettled([
			this.conversationWriter.flush(),
			...this.pendingCanonicalWrites,
		]);
		for (const result of results) {
			if (result.status === 'rejected') throw result.reason;
		}
	}

	/**
	 * Render-per-turn: re-render the agent function and hand the
	 * loop a replacement context for its next provider request. The wrapper's
	 * `state.messages` tracks the run (every assistant/tool-result message got
	 * a `message_end`), so the rebuilt context loses nothing. Also syncs the
	 * wrapper state so later runs snapshot the fresh values. An invariance
	 * violation (conditional use()/hook) throws here and fails the run.
	 */
	private async prepareRerenderTurn(): Promise<AgentLoopTurnUpdate | undefined> {
		if (!this.rerender) return undefined;
		let next = this.rerender();
		// Environment swap: a conditional useSandbox() whose presence flipped
		// since initialization takes effect HERE, at the turn boundary — the
		// same rhythm as resource changes. The swap lands before the tool
		// rebuild below so the next model call already runs in the new env,
		// and the fresh render re-merges live skills over the re-discovered
		// workspace.
		const swapped = await this.maybeSwapEnvironment(next);
		if (swapped) next = this.rerender();
		this.agentTools = next.tools;
		// Live resource sets follow the render: skill activation and task
		// resolution always see what the agent declares NOW, even while the
		// frozen presentation surfaces still show the baseline.
		this.liveSkills = next.resources.skills;
		this.liveSubagents = next.resources.subagents;
		this.lastRenderedResources = next.resources;
		// Rebuild under any active per-call overrides — a structured-result
		// prompt's finish/give_up bundle and per-call tools must survive the
		// turn boundary, not just the first turn.
		const overrides = this.activeCallOverrides;
		const tools = this.assembleModelTools(
			this.createBuiltinToolGroups(
				this.attachedEnv,
				overrides?.model,
				overrides?.thinkingLevel,
				overrides?.activePackagedSkills,
			),
			overrides ? [...this.agentTools, ...overrides.tools] : this.agentTools,
			overrides?.extraTools ?? [],
		);
		this.agentLoop.state.tools = tools;
		this.agentLoop.state.systemPrompt = next.systemPrompt;
		// Narrate from the same render evaluation that just produced the tool
		// projection — the signal and the model's actual view cannot disagree.
		// The steered signal injects before the next provider request (the
		// loop polls steering after this returns). A swap turn narrates ONE
		// unconditional full environment snapshot instead of deltas.
		if (swapped) await this.narrateEnvironmentSnapshot(next.resources.snapshot);
		else await this.narrateResourceDelta();
		return {
			context: {
				systemPrompt: next.systemPrompt,
				messages: this.agentLoop.state.messages.slice(),
				tools: this.agentLoop.state.tools,
			},
		};
	}

	/**
	 * Swap the environment when the render's `useSandbox()` presence flipped
	 * since the environment was last resolved. Presence is the only reliable
	 * observation (factories are fresh objects every render), so an A→B swap
	 * that keeps the hook present takes effect at the next submission's
	 * initialization instead. Attach and detach both land here: detach
	 * removes the environment entirely — the built-in shell/fs tools drop
	 * with it. The declared `cwd` re-applies exactly as initialization
	 * applies it.
	 */
	private async maybeSwapEnvironment(next: ReturnType<SessionRerender>): Promise<boolean> {
		if (!this.envRuntime || !this.resourceRuntime) return false;
		const wantAttached = next.sandbox !== undefined;
		if (wantAttached === (this.envSlot.env !== undefined)) return false;
		const { env: baseEnv, toolFactory } = await this.envRuntime.resolve(next.sandbox);
		const env =
			baseEnv && next.cwd !== undefined
				? createCwdSessionEnv(baseEnv, baseEnv.resolvePath(next.cwd))
				: baseEnv;
		this.envSlot.env = env;
		this.envSlot.toolFactory = toolFactory;
		// The prompt still describes the init-time workspace (frozen by
		// design); the next compaction rebaseline re-discovers against the
		// then-current env and composes a truthful prompt.
		this.envSlot.rediscoverNeeded = true;
		// Live sets re-merge over the NEW workspace: old-env discovered
		// skills drop, new-env skills appear — both restated by the snapshot
		// signal, never silently dangling against a departed filesystem.
		await this.envRuntime.swapDiscovery(env);
		return true;
	}

	/**
	 * The environment swap's narration: ONE `environment` signal restating
	 * the complete current state (cwd + full tool/skill/agent rosters),
	 * emitted unconditionally — a swap can be tool-invisible while changing
	 * everything the model believed about its filesystem, so there is no
	 * delta to trust. Supersedes that boundary's delta narration: the
	 * narrated snapshot syncs to the current render batch-atomically with
	 * the signal, so the reconciler never restates the same change as
	 * deltas one turn later. The snapshot record is NON-baseline — baseline
	 * stays reserved for states the system prompt was actually composed
	 * from (first contact, compaction).
	 */
	private async narrateEnvironmentSnapshot(current: ResourceSnapshot): Promise<void> {
		if (!this.resourceRuntime || !this.activeSubmissionId) return;
		const previous = this.lastNarratedResources;
		const parentId = await this.conversationWriter.getConversationLeaf(this.conversationId);
		const records: ConversationRecord[] = [];
		// A swap at the very first boundary beats the lazy first-contact
		// baseline: record what the frozen presentation surfaces WERE
		// composed from before narrating the swap away from it.
		if (!previous) {
			records.push(this.resourceSnapshotRecord(this.resourceRuntime.initial.snapshot, true));
		} else if (instructionsChanged(previous, current)) {
			// The snapshot restates resources, not instruction prose — the
			// instructions marker still travels when the document moved.
			this.enqueueSignalAppend(
				{
					type: 'instructions',
					body: INSTRUCTIONS_UPDATED_SIGNAL_BODY,
				},
				{ advance: false },
			);
		}
		this.enqueueSignalAppend(
			{
				type: 'environment',
				body: renderEnvironmentSignalBody({
					cwd: this.attachedEnv?.cwd,
					tools: this.agentLoop.state.tools.map((tool) => tool.name),
					skills: Object.values(this.liveSkills).map((skill) => ({
						name: skill.name,
						...(skill.description ? { description: skill.description } : {}),
					})),
					subagents: Object.values(this.liveSubagents).map((subagent) => ({
						name: subagent.name,
						description: subagent.description,
					})),
				}),
			},
			{ advance: false },
		);
		const { records: signalRecords } = this.drainSignalAppendRecords(parentId);
		await this.appendCanonical([
			...records,
			...signalRecords,
			this.resourceSnapshotRecord(current, false),
		]);
		this.lastNarratedResources = current;
	}

	/**
	 * The dynamic-resources reconciler: diff the latest render's declared
	 * sets against the durable last-narrated snapshot and announce the delta
	 * — one `resources` signal per changed kind (delta lines + the kind's
	 * current roster), plus an `instructions` signal (announcement only, no
	 * diff — the live prompt already IS the new version) when the composed
	 * instruction document's digest moved. All batch-atomic with the updated
	 * `resource_snapshot` record. Crash between steer and commit re-diffs on
	 * the re-attempt and emits again; a committed batch never re-narrates.
	 * First contact (no durable snapshot) records the current render as the
	 * silent baseline — it IS what the frozen presentation surfaces were
	 * composed from.
	 */
	private async narrateResourceDelta(): Promise<void> {
		const rendered = this.lastRenderedResources;
		if (!this.resourceRuntime || !rendered || !this.activeSubmissionId) return;
		const current = rendered.snapshot;
		const previous = this.lastNarratedResources;
		if (!previous) {
			await this.appendCanonical([this.resourceSnapshotRecord(current, true)]);
			this.lastNarratedResources = current;
			return;
		}
		const deltas = diffResourceSnapshots(previous, current);
		const instructionsUpdated = instructionsChanged(previous, current);
		if (deltas.length === 0 && !instructionsUpdated) return;
		const parentId = await this.conversationWriter.getConversationLeaf(this.conversationId);
		if (instructionsUpdated) {
			this.enqueueSignalAppend(
				{
					type: 'instructions',
					body: INSTRUCTIONS_UPDATED_SIGNAL_BODY,
				},
				{ advance: false },
			);
		}
		for (const delta of deltas) {
			this.enqueueSignalAppend(
				{
					type: 'resources',
					body: renderResourceSignalBody(delta, this.resourceRoster(delta.kind)),
					attributes: { resource: delta.kind },
				},
				{ advance: false },
			);
		}
		const { records } = this.drainSignalAppendRecords(parentId);
		await this.appendCanonical([...records, this.resourceSnapshotRecord(current, false)]);
		this.lastNarratedResources = current;
	}

	/**
	 * Announce optional MCP connections that failed to resolve for this
	 * submission: one `resources` signal naming the servers and reasons,
	 * before the model's first turn. Once per session — a crashed attempt
	 * re-initializes (and re-resolves the connections), so a re-attempt
	 * re-narrates only when the servers are still down.
	 */
	private async narrateMcpUnavailable(): Promise<void> {
		if (this.mcpUnavailableNarrated || this.mcpUnavailable.length === 0) return;
		if (!this.activeSubmissionId) return;
		const parentId = await this.conversationWriter.getConversationLeaf(this.conversationId);
		this.enqueueSignalAppend(
			{
				type: 'resources',
				body: renderMcpUnavailableSignalBody(this.mcpUnavailable),
				attributes: { resource: 'mcp' },
			},
			{ advance: false },
		);
		const { records } = this.drainSignalAppendRecords(parentId);
		await this.appendCanonical(records);
		this.mcpUnavailableNarrated = true;
	}

	/** The names-only roster line of one resource kind, as the model sees it. */
	private resourceRoster(kind: ResourceKind): string[] {
		switch (kind) {
			case 'skill':
				return Object.keys(this.liveSkills);
			case 'tool':
				return this.agentLoop.state.tools.map((tool) => tool.name);
			case 'subagent':
				return Object.keys(this.liveSubagents);
		}
	}

	private resourceSnapshotRecord(
		snapshot: ResourceSnapshot,
		baseline: boolean,
	): ConversationRecord {
		return {
			...this.canonicalEnvelope('resource_snapshot'),
			type: 'resource_snapshot',
			baseline,
			snapshot,
		};
	}

	/**
	 * Compaction rebaseline: the post-compaction system prompt snapshots the
	 * CURRENT resource state — skill catalog and task roster included — just
	 * as the agent's first message did, so the pre-compaction add/remove
	 * bookkeeping stops mattering. Narrated advances with the baseline (the
	 * new prompt already tells the model everything; no signal needed).
	 *
	 * Owns the compaction record's append so the baseline snapshot rides the
	 * SAME batch: separate appends left a crash window where the context was
	 * durably compacted but the frozen baseline (and the env-swap rediscovery
	 * truth point) never advanced — a restart then recomposed pre-compaction
	 * catalogs/workspace over a post-compaction transcript until the next
	 * compaction. In-memory swaps land only after the single durable point.
	 */
	private async rebaselineResources(compactionRecord: ConversationRecord): Promise<void> {
		if (!this.resourceRuntime || !this.rerender || !this.lastRenderedResources) {
			await this.appendCanonical([compactionRecord]);
			return;
		}
		// An environment swap left the prompt describing the init-time
		// workspace on purpose (mid-submission recompose would gaslight the
		// transcript). The rebaseline is the truth point: re-discover against
		// the CURRENT env so the recomposed prompt's cwd, directory listing,
		// AGENTS.md, and skill catalog describe where the agent actually is.
		if (this.envRuntime && this.envSlot.rediscoverNeeded) {
			await this.envRuntime.rediscover(this.attachedEnv);
			this.envSlot.rediscoverNeeded = false;
		}
		// Render fresh so the recorded baseline and the recomposed surfaces
		// come from the same evaluation.
		const refreshed = this.rerender();
		const current = refreshed.resources.snapshot;
		await this.appendCanonical([compactionRecord, this.resourceSnapshotRecord(current, true)]);
		this.lastNarratedResources = current;
		this.agentTools = refreshed.tools;
		this.liveSkills = refreshed.resources.skills;
		this.liveSubagents = refreshed.resources.subagents;
		this.lastRenderedResources = refreshed.resources;
		this.resourceRuntime.rebaseline(current);
		// Recompose the prompt over the new catalogs (skills AND the task
		// roster both live in the system prompt) and rebuild the built-in
		// tools. The rebaseline call above swapped the catalogs, so recompose
		// again. Rebuild under any active per-call overrides, exactly as
		// prepareRerenderTurn does — a mid-call compaction must not drop a
		// structured-result prompt's finish/give_up bundle, per-call tools,
		// or active packaged skills for the turn that follows it.
		this.agentLoop.state.systemPrompt = this.rerender().systemPrompt;
		const overrides = this.activeCallOverrides;
		this.agentLoop.state.tools = this.assembleModelTools(
			this.createBuiltinToolGroups(
				this.attachedEnv,
				overrides?.model,
				overrides?.thinkingLevel,
				overrides?.activePackagedSkills,
			),
			overrides ? [...this.agentTools, ...overrides.tools] : this.agentTools,
			overrides?.extraTools ?? [],
		);
	}

	/**
	 * Sink for `useDataWriter` writers. Unlike `usePersistentState` writes (buffered,
	 * batch-atomic), data writes append immediately — live client progress is
	 * their whole point. The writer API is synchronous, so appends chain on an
	 * ordered queue; the queue is awaited before the response settles, and an
	 * append failure there fails the submission (fail fast, never silent).
	 * The one exception: writes made before the response's first assistant
	 * step completes buffer until that anchor commits (the record projection
	 * anchors data parts to a completed step).
	 */
	private enqueueMessageDataWrite(name: string, data: unknown): void {
		if (!this.activeSubmissionId) {
			throw new Error(
				`[flue] Message data "${name}" can only be written while the agent is responding — write from tool run functions (and other callbacks that run during a submission).`,
			);
		}
		// Pre-anchor window (a fresh submission's useAgentStart, before turn 1
		// completes a step): the record cannot anchor yet, so buffer it. A
		// delivery joining a live response has a completed step and writes
		// through directly — identical hook code either way.
		if (!this.responseHasCompletedStep) {
			this.pendingPreAnchorDataWrites.push({ name, data });
			return;
		}
		const record: ConversationRecord = {
			...this.canonicalEnvelope('message_data_write'),
			type: 'message_data_write',
			name,
			data,
		};
		// The queued closure is gated on attempt identity: record and append
		// authorization were minted by THIS attempt, but the closure may run
		// after the attempt failed and teardown cleared the active ids —
		// appending then would carry the stale envelope under the wrong (or no)
		// authorization, and the store's rejection would poison the shared
		// writer for the terminal advisory and any replacement attempt. A
		// failed attempt's unflushed data writes never happened, like its
		// signal appends and state writes.
		const attemptId = this.activeSubmissionAttemptId;
		const pending = this.outputWriteQueue.then(() =>
			this.activeSubmissionAttemptId === attemptId ? this.appendCanonical([record]) : undefined,
		);
		this.outputWriteQueue = pending;
		// The queue is consumed by flushResponseOutput; this handler only keeps
		// an interim rejection from surfacing as an unhandled-rejection warning.
		pending.catch(() => {});
	}

	/**
	 * Flush data writes buffered before the response's first completed
	 * assistant step, in write order. Runs at the moment the anchor commits;
	 * writes buffered by an attempt that never completes a step die with it,
	 * like every other live write of a failed attempt.
	 */
	private flushPreAnchorDataWrites(): void {
		const writes = this.pendingPreAnchorDataWrites;
		this.pendingPreAnchorDataWrites = [];
		for (const write of writes) this.enqueueMessageDataWrite(write.name, write.data);
	}

	/**
	 * Sink for `ctx.append` writes from lifecycle callbacks and for framework
	 * narration. The signal is steered into the live agent loop immediately —
	 * the model reads it at the next turn start — and buffered for canonical
	 * append with the owning callback's batch (`drainSignalAppendRecords`).
	 * Steering and the durable flush happen in the same order at the same
	 * boundary, so the live context and a rehydrated one can never disagree.
	 * `advance: false` (framework narration only) keeps the signal out of the
	 * `useDelivery()` cursor: narration is bookkeeping about the agent's own
	 * declared surface, not an input the response is answering.
	 */
	private enqueueSignalAppend(signal: AgentSignalAppend, options?: { advance?: boolean }): void {
		if (!this.activeSubmissionId) {
			throw new Error(
				'[flue] append() is only legal while the agent is responding to a submission. An appended signal steers the running response; to send input at any other time, use the dispatcher from useDispatchMessage().',
			);
		}
		const timestamp = new Date().toISOString();
		this.pendingSignalAppends.push({
			messageId: generateConversationEntryId(),
			timestamp,
			signalType: signal.type,
			...(signal.tagName ? { tagName: signal.tagName } : {}),
			content: signal.body,
			...(signal.attributes ? { attributes: signal.attributes } : {}),
		});
		// Steer the exact message the canonical projection rebuilds from the
		// durable record (signals reach the model as rendered user-context
		// messages — see buildConversationContext), so the live loop and a
		// rehydrated context can never disagree about what the model saw.
		this.agentLoop.steer(
			createUserContextMessage(
				renderSignalMessage({
					role: 'signal',
					type: signal.type,
					tagName: signal.tagName,
					content: signal.body,
					attributes: signal.attributes,
					timestamp: new Date(timestamp).getTime(),
				}),
				timestamp,
			),
		);
		// The delivery cursor tracks intentional inputs: agent-authored appends
		// advance it exactly like delivered messages — the append IS the input
		// the continuation turn answers. Framework narration passes
		// `advance: false` and stays invisible to `useDelivery()`.
		if (options?.advance === false) return;
		this.advanceDelivery?.({
			kind: 'signal',
			type: signal.type,
			body: signal.body,
			...(signal.attributes ? { attributes: signal.attributes } : {}),
			...(signal.tagName ? { tagName: signal.tagName } : {}),
		});
	}

	/**
	 * Turn buffered finish-continuation appends into canonical `signal`
	 * records chained linearly after `parentId`, returning the new leaf.
	 * Callers must append the records in the same batch (or immediately
	 * after) whatever made `parentId` the conversation tail.
	 */
	private drainSignalAppendRecords(parentId: string | null): {
		records: ConversationRecord[];
		leafId: string | null;
	} {
		if (this.pendingSignalAppends.length === 0) return { records: [], leafId: parentId };
		const drained = this.pendingSignalAppends;
		this.pendingSignalAppends = [];
		let leafId = parentId;
		const records = drained.map((pending): ConversationRecord => {
			const record: ConversationRecord = {
				...this.canonicalEnvelope('signal'),
				timestamp: pending.timestamp,
				type: 'signal',
				messageId: pending.messageId,
				parentId: leafId,
				signalType: pending.signalType,
				...(pending.tagName ? { tagName: pending.tagName } : {}),
				content: pending.content,
				...(pending.attributes ? { attributes: pending.attributes } : {}),
			};
			leafId = pending.messageId;
			return record;
		});
		return { records, leafId };
	}

	/**
	 * Run one delivery's start seam: evaluate the render's `useAgentStart`
	 * declarations after the input record, before the model's next turn. The
	 * callbacks run CONCURRENTLY, in no guaranteed order — event hooks are
	 * independent units with no durable identity; work that needs ordering
	 * composes into one hook. The seam commits atomically once every callback
	 * settles: appended signals (steered in declaration order, so concurrency
	 * never makes the conversation racy), buffered state writes, and one
	 * per-delivery `agent_start_run` marker in a single append batch — the
	 * marker is written for every delivery, hooks or not. Adoption is the
	 * marker: a re-entry for a delivery that has one skips the seam wholesale;
	 * a crash before it left nothing durable and re-runs every callback
	 * (at-least-once). A resume re-entry whose response already has durable
	 * assistant steps also skips: start hooks had their chance before turn one
	 * of the original attempt. A throw fails the submission (fail-fast, like
	 * the `useResponseStart` hooks).
	 */
	private async runAgentStartHooks(
		signal: AbortSignal,
		submissionId = this.activeSubmissionId,
		options?: {
			/**
			 * The seam runs for a delivery that JOINED the live response at a turn
			 * boundary: the completed-step skip below does not apply (the host's
			 * response having durable steps is the normal mid-run state, not
			 * evidence this delivery's hooks already had their chance).
			 */
			joined?: boolean;
		},
	): Promise<void> {
		if (!this.outputChannel || !submissionId) return;
		if (!options?.joined && this.responseHasCompletedStep) return;
		if (await this.hasAgentStartRun(submissionId)) return;
		// A joined delivery's hooks run mid-response, after earlier deliveries'
		// callbacks wrote durable state — re-render first (the render-per-turn
		// cadence, extended to join boundaries) so hook closures and guards
		// observe those writes instead of the stale pre-join render.
		if (options?.joined) await this.prepareRerenderTurn();
		const declarations = this.outputChannel.agentStarts;
		const outcomes = await Promise.allSettled(
			declarations.map((hook, index) => this.executeAgentStartHook(index, hook, signal)),
		);
		const failures = outcomes.flatMap((outcome) =>
			outcome.status === 'rejected' ? [outcome.reason] : [],
		);
		if (failures.length === 1) throw failures[0];
		if (failures.length > 1) {
			throw new AggregateError(failures, '[flue] Multiple useAgentStart callbacks threw.');
		}
		// Steer the callbacks' appends now, grouped in declaration order —
		// durable order equals steer order, deterministic regardless of how the
		// concurrent callbacks interleaved.
		for (const outcome of outcomes) {
			if (outcome.status !== 'fulfilled') continue;
			for (const message of outcome.value) this.enqueueSignalAppend(message);
		}
		const parentId =
			this.pendingSignalAppends.length > 0
				? await this.conversationWriter.getConversationLeaf(this.conversationId)
				: null;
		const { records: signalRecords } = this.drainSignalAppendRecords(parentId);
		await this.appendCanonical([
			...signalRecords,
			...this.drainHookStateRecords(),
			{
				...this.canonicalEnvelope('agent_start_run'),
				// The DELIVERY's id (differs from the active host submission when
				// the seam runs for a joined delivery) — adoption keys on it.
				submissionId,
				type: 'agent_start_run',
			},
		]);
	}

	/**
	 * All durable records of one type for this conversation and submission, in
	 * stream order. Records are submission-keyed, so this spans every turn of
	 * every prior attempt. Root conversation only: a delegate's records belong
	 * to its own detached task. Yields the reducer's index values — the full
	 * record for retained types, the typed stub for slimmed ones.
	 */
	private async submissionRecords<TType extends ConversationRecord['type']>(
		type: TType,
		submissionId: string,
	): Promise<Array<Extract<IndexedConversationRecord, { type: TType }>>> {
		const records: Array<Extract<IndexedConversationRecord, { type: TType }>> = [];
		for (const record of (await this.conversationWriter.loadReducedState()).recordsById.values()) {
			if (record.type !== type) continue;
			const scope = record as { conversationId?: string; submissionId?: string };
			if (scope.conversationId === this.conversationId && scope.submissionId === submissionId) {
				records.push(record as Extract<IndexedConversationRecord, { type: TType }>);
			}
		}
		return records;
	}

	/** Whether the delivery's start seam already committed its marker. */
	private async hasAgentStartRun(submissionId: string): Promise<boolean> {
		return (await this.submissionRecords('agent_start_run', submissionId)).length > 0;
	}

	/**
	 * Run one `useAgentStart` callback and collect its appends. Callbacks run
	 * concurrently, so nothing commits here: appends are validated at call
	 * time and buffered per callback (the seam steers and flushes them in
	 * declaration order once every callback settles), state writes ride the
	 * shared attempt buffer, and the seam owns the single durable batch. The
	 * harness materializes on first access (a callback that never touches it
	 * pays nothing) and closes when the run settles; the invocation id is per
	 * execution attempt, like harness-connected tools. Same window rule as
	 * the finish-context writer: append is legal only while the callback
	 * runs.
	 */
	private async executeAgentStartHook(
		index: number,
		hook: AgentStartDeclaration,
		signal: AbortSignal,
	): Promise<AgentSignalAppend[]> {
		let harness: ActionHarness | undefined;
		let appendWindowOpen = true;
		const appends: AgentSignalAppend[] = [];
		// `this` is shadowed inside the ctx getter below.
		const session = this;
		const ctx: AgentStartContext = {
			append: (message) => {
				if (!appendWindowOpen) {
					throw new Error(
						'[flue] append() was called after its useAgentStart callback settled. The append window is the callback itself — to send input at any other time, use the dispatcher from useDispatchMessage().',
					);
				}
				appends.push(assertAppendMessage(message));
			},
			log: this.createHookLogger('useAgentStart', index),
			signal,
			get harness() {
				harness ??= session.createInvocationHarness(generateInvocationId(), signal);
				return harness as unknown as FlueHarness;
			},
		};
		try {
			await hook.run(ctx);
		} catch (error) {
			throw new Error(
				`[flue] A useAgentStart callback (hook #${index} in declaration order) threw: ${error instanceof Error ? error.message : String(error)}`,
				{ cause: error },
			);
		} finally {
			appendWindowOpen = false;
			if (harness) {
				this.activeActionHarnesses.delete(harness);
				await harness.close();
			}
		}
		return appends;
	}

	/**
	 * The would-stop seam: the model has no more tool calls and the response
	 * is about to settle. Two kinds of work interleave here, in a strict
	 * order per iteration:
	 *
	 * 1. **Late-arrival joins** — queued dispatch deliveries claim-joined and
	 *    driven as continuation turns. The agent is not "finally done" while
	 *    delivered input awaits, so joins always drain BEFORE any finish
	 *    evaluation. (Deliveries arriving mid-run join at turn boundaries
	 *    inside the loop; this drain covers only the race where one lands
	 *    after the loop's final steering poll.)
	 * 2. **`useAgentFinish` cycles** — each cycle runs every declaration
	 *    sequentially; if any appended a signal, the cycle is recorded
	 *    batch-atomically with its signal records and the loop continues with
	 *    another turn (the appends were steered live; `continue()` runs
	 *    them). A dispatch made during a finish callback is a real delivery:
	 *    it joins on the next iteration and re-fires the hooks at the new
	 *    true end. Joined continuations never count against the append-cycle
	 *    ceiling.
	 *
	 * The response settles only when the queue is empty AND a finish cycle
	 * completes with no appends.
	 *
	 * Resume-safe by records: a continued cycle or an applied join whose
	 * continuation turn never ran (crash between the durable batch and the
	 * turn) classifies `completed` upstream with trailing unanswered entries
	 * — detected here and driven before the next evaluation, so a resumed
	 * response neither re-runs a completed cycle nor appends twice. The cycle
	 * count derives from durable records, so the runaway ceiling survives
	 * restarts. The submission's durability timeout remains the total
	 * wall-clock backstop — neither continuations nor joins extend it.
	 */
	private async runWouldStopPhase(options: {
		errorLabel: string;
		signal: AbortSignal;
	}): Promise<void> {
		const submissionId = this.activeSubmissionId;
		if (!submissionId) return;
		const driveContinuation = async () => {
			await this.runModelTurnWithRecovery({
				start: () => this.agentLoop.continue(),
				signal: options.signal,
			});
			this.throwIfError(options.errorLabel);
		};
		if (await this.hasPendingSteeredContinuation(submissionId)) {
			await driveContinuation();
		}
		for (;;) {
			if ((await this.applyQueuedJoins()) > 0) {
				await driveContinuation();
				continue;
			}
			const hooks = this.outputChannel?.agentFinishes ?? [];
			if (hooks.length === 0) return;
			const cycle = await this.countAgentFinishCycles(submissionId);
			const toolCalls = await this.collectResponseToolCalls(submissionId);
			const before = this.pendingSignalAppends.length;
			// Re-read declarations each cycle: render-per-turn agents re-render on
			// continuation turns, refreshing the closures.
			for (const [index, hook] of hooks.entries()) {
				await this.executeAgentFinishHook(index, hook, toolCalls, options.signal);
			}
			const stateRecords = this.drainHookStateRecords();
			if (this.pendingSignalAppends.length === before) {
				// No appends: the hooks are satisfied; commit any state writes.
				if (stateRecords.length > 0) await this.appendCanonical(stateRecords);
				// A callback may have dispatched instead of appending — that queued
				// delivery joins now (re-firing the hooks at the new true end)
				// rather than waking a serialized follow-up response.
				if ((await this.applyQueuedJoins()) === 0) return;
				await driveContinuation();
				continue;
			}
			if (cycle >= MAX_AGENT_FINISH_CYCLES) {
				throw new Error(
					`[flue] useAgentFinish appended a continuation signal after ${MAX_AGENT_FINISH_CYCLES} continued cycles in one response — a runaway loop. The response is failing loudly instead of settling as a success; if the model cannot satisfy the check, make the hook give up explicitly (log and return) after a bounded number of attempts.`,
				);
			}
			// Durable point: the cycle's signal records, state writes, and the
			// cycle record in one batch. The signals were already steered into
			// the live loop as they were appended; `continue()` runs them as the
			// continuation turn.
			const parentId = await this.conversationWriter.getConversationLeaf(this.conversationId);
			const { records } = this.drainSignalAppendRecords(parentId);
			await this.appendCanonical([
				...records,
				...stateRecords,
				{
					...this.canonicalEnvelope('agent_finish_cycle'),
					type: 'agent_finish_cycle',
				},
			]);
			await driveContinuation();
		}
	}

	/**
	 * Whether the response has durably steered content whose continuation
	 * turn never ran — the crash window between a durable batch (a continued
	 * `useAgentFinish` cycle, or an applied turn-boundary join) and the model
	 * turn that answers it. The rebuilt context already ends with the steered
	 * entries, so the caller drives `continue()` from them. Trailing
	 * straggler signals (flushed after the last boundary, never steered) do
	 * NOT count: absent cycle records they settle un-continued, exactly as
	 * before.
	 */
	private async hasPendingSteeredContinuation(submissionId: string): Promise<boolean> {
		const hasCycles = (await this.countAgentFinishCycles(submissionId)) > 0;
		const joined = this.activeJoinSource ? await this.activeJoinSource.listUnresolved() : [];
		const joinedEntryIds = new Set(
			joined.map((submission) => submissionEntryId(submission.input.kind, submission.submissionId)),
		);
		if (!hasCycles && joinedEntryIds.size === 0) return false;
		const conversation = await this.requireConversation();
		const path = getActiveConversationPath(conversation);
		for (let i = path.length - 1; i >= 0; i--) {
			const entry = path[i];
			if (entry?.type !== 'message') continue;
			if (entry.message.role === 'assistant') return false;
			if (joinedEntryIds.has(entry.id)) return true;
			if (entry.message.role === 'signal' && hasCycles) return true;
		}
		return false;
	}

	/**
	 * Turn-boundary join (dispatch-while-busy): claim the joinable queued
	 * prefix and absorb each delivery into the live response — canonical
	 * input record, the exact projected message steered into the loop, the
	 * delivery's own `useAgentStart` hooks, then the durable `joined`
	 * confirmation. Applied strictly in admission order. Claims once per
	 * boundary: a delivery dispatched DURING this application (e.g. from a
	 * start hook) waits for the next boundary, so every claim sits between
	 * model turns and the submission timeout stays the backstop.
	 *
	 * Returns the number of deliveries applied. No-op outside a submission
	 * with a join seam.
	 */
	private async applyQueuedJoins(): Promise<number> {
		const source = this.activeJoinSource;
		const signal = this.activeJoinSignal;
		if (!source || !signal || !this.activeSubmissionId) return 0;
		const claimed = await source.claim();
		for (const submission of claimed) {
			if (signal.aborted) throw abortErrorFor(signal);
			await this.applyJoinedDelivery(submission, source, signal);
		}
		return claimed.length;
	}

	/**
	 * Absorb one claimed delivery. Two-phase against the store: the row is
	 * already `joining` (durable intent); the canonical input record makes
	 * the join real; `finalize` confirms it `joined`. A crash anywhere in
	 * between resolves on the re-attempt by record existence
	 * (`resolveInterruptedJoins`) — record present adopts the join, record
	 * absent hands the row back to the queue. Errors propagate and fail the
	 * host attempt (recovery owns the row either way).
	 */
	private async applyJoinedDelivery(
		submission: AgentSubmission,
		source: SubmissionJoinSource,
		signal: AbortSignal,
	): Promise<void> {
		const input = submission.input;
		const entryId = submissionEntryId(input.kind, input.submissionId);
		const alreadyApplied = await this.conversationWriter.hasConversationEntry(
			this.conversationId,
			entryId,
		);
		if (!alreadyApplied) {
			const parentId = await this.conversationWriter.getConversationLeaf(this.conversationId);
			await this.appendCanonical([
				await this.buildSubmissionInputRecord(input, parentId, { asJoinedDelivery: true }),
			]);
			await this.steerJoinedEntry(entryId);
		}
		// An already-applied input (a reverted join whose record survived) is
		// in the rebuilt context — steering it again would duplicate it live.
		// Advance the delivery cursor before the delivery's hooks run: the
		// join boundary re-renders, so `useDelivery()` closures in those hooks
		// see THIS message.
		this.advanceDelivery?.(input.message);
		await this.runAgentStartHooks(signal, input.submissionId, { joined: true });
		await source.finalize(input.submissionId);
	}

	/**
	 * Steer the joined delivery's message into the live loop as the EXACT
	 * message the canonical projection rebuilds from its record — same code
	 * path (`buildConversationContextEntries`), so the live context
	 * and a rehydrated one can never disagree about what the model saw.
	 */
	private async steerJoinedEntry(entryId: string): Promise<void> {
		const conversation = await this.requireConversation();
		const resolved = await this.resolveCanonicalContextAttachments(conversation);
		const entries = buildConversationContextEntries(conversation, {
			resolveAttachment: (attachment) => {
				const image = resolved.get(attachment.id);
				if (!image) throw new AttachmentNotAvailableError({ attachmentId: attachment.id });
				return image;
			},
		});
		const entry = entries.findLast((candidate) => candidate.sourceEntry.id === entryId);
		if (!entry) {
			throw new Error(
				'[flue] A joined delivery input entry is missing from the projected context.',
			);
		}
		this.agentLoop.steer(entry.message);
	}

	/**
	 * Resolve joins a crash interrupted, on the host's re-attempt: a
	 * `joining` row whose canonical input record exists becomes `joined`
	 * (the rebuilt context already carries it); one whose record never
	 * landed reverts to `queued` and runs as its own submission (or re-joins
	 * fresh). `joined` rows re-adopt their start hooks — the per-delivery
	 * `agent_start_run` marker gates re-runs, so a completed seam is a no-op.
	 */
	private async resolveInterruptedJoins(signal: AbortSignal): Promise<void> {
		const source = this.activeJoinSource;
		if (!source || !this.activeSubmissionId) return;
		for (const submission of await source.listUnresolved()) {
			const input = submission.input;
			const entryId = submissionEntryId(input.kind, input.submissionId);
			if (submission.status === 'joining') {
				if (await this.conversationWriter.hasConversationEntry(this.conversationId, entryId)) {
					this.advanceDelivery?.(input.message);
					await this.runAgentStartHooks(signal, input.submissionId, { joined: true });
					await source.finalize(input.submissionId);
				} else {
					await source.revert(input.submissionId);
				}
				continue;
			}
			this.advanceDelivery?.(input.message);
			await this.runAgentStartHooks(signal, input.submissionId, { joined: true });
		}
		// The per-delivery advances above track hook re-runs in admission
		// order; the durable record stream then restores the true latest input
		// (which may be an appended signal after the last join).
		await this.restoreDeliveryCursor();
	}

	/**
	 * Point the delivery cursor at the latest input message of the ACTIVE
	 * submission on the rebuilt path — a resumed attempt's renders must see
	 * the same cursor the crashed attempt's renders saw. Entries at or before
	 * the submission's own input entry leave the threaded waking delivery in
	 * place; a later signal entry (joined or appended) reconstructs from its
	 * record, and a later user entry (a joined `kind: 'user'` delivery)
	 * reconstructs its attachments from the attachment store.
	 */
	private async restoreDeliveryCursor(): Promise<void> {
		const inputEntryId = this.activeInputEntryId;
		if (!this.advanceDelivery || !inputEntryId) return;
		const conversation = await this.requireConversation();
		const path = getActiveConversationPath(conversation);
		const inputIndex = path.findIndex((entry) => entry.id === inputEntryId);
		if (inputIndex === -1) return;
		for (let i = path.length - 1; i > inputIndex; i--) {
			const entry = path[i];
			if (entry?.type !== 'message') continue;
			const message = entry.message;
			if (message.role === 'signal') {
				// Reserved types are framework-authored by construction (admission
				// and `ctx.append` reject them) and none of them ever advanced the
				// live cursor: narration appends pass `advance: false`, and the
				// recovery pair / terminalization advisories are appended straight
				// to the record stream, outside the append path — the recovery
				// pair in particular lands during THIS resume (`repairResumableTail`
				// runs before this walk), after every render the crashed attempt
				// made. Skipping them restores exactly what the live renders saw.
				if (RESERVED_SIGNAL_TYPES.has(message.type)) continue;
				this.advanceDelivery({
					kind: 'signal',
					type: message.type,
					body: message.content,
					...(message.attributes ? { attributes: message.attributes } : {}),
					...(message.tagName ? { tagName: message.tagName } : {}),
				});
				return;
			}
			if (message.role !== 'user') continue;
			const body = Array.isArray(message.content)
				? message.content
						.filter((block) => block.type === 'text')
						.map((block) => ('text' in block ? block.text : ''))
						.join('\n')
				: String(message.content);
			const refs = [...(entry.attachmentRefs?.values() ?? [])];
			const attachments =
				refs.length > 0 ? await this.resolveCanonicalImages(refs.map((ref) => ref.id)) : undefined;
			this.advanceDelivery({
				kind: 'user',
				body,
				...(attachments?.length ? { attachments } : {}),
			});
			return;
		}
	}

	/** Count durably continued `useAgentFinish` cycles for one submission. */
	private async countAgentFinishCycles(submissionId: string): Promise<number> {
		return (await this.submissionRecords('agent_finish_cycle', submissionId)).length;
	}

	/**
	 * Every tool call the response has made so far, from durable
	 * `tool_outcome` records in stream order.
	 */
	private async collectResponseToolCalls(submissionId: string): Promise<AgentResponseToolCall[]> {
		return (await this.submissionRecords('tool_outcome', submissionId)).map((record) => ({
			tool: record.toolName,
			isError: record.isError,
		}));
	}

	/**
	 * Aggregate usage across the response's durably completed assistant
	 * steps — the resume counterpart of the live `message_end` accumulation.
	 */
	private async collectResponseUsage(submissionId: string): Promise<PromptUsage | undefined> {
		let usage: PromptUsage | undefined;
		for (const record of await this.submissionRecords(
			'assistant_message_completed',
			submissionId,
		)) {
			const stepUsage = fromProviderUsage(record.usage);
			if (stepUsage) usage = usage ? addUsage(usage, stepUsage) : stepUsage;
		}
		return usage;
	}

	/**
	 * Run one `useAgentFinish` callback for the current cycle. Same lazy
	 * harness and fail-fast wrapping as the start hooks; appends it makes are
	 * steered live and buffered — the cycle driver owns their durable flush.
	 */
	private async executeAgentFinishHook(
		index: number,
		hook: AgentFinishDeclaration,
		toolCalls: readonly AgentResponseToolCall[],
		signal: AbortSignal,
	): Promise<void> {
		let harness: ActionHarness | undefined;
		// The continuation writer is legal only during the callback's execution
		// window: a captured reference used later cannot steer a response that
		// has already moved on (or settled), so it throws instead of silently
		// buffering.
		let appendWindowOpen = true;
		// `this` is shadowed inside the ctx getter below.
		const session = this;
		const ctx: AgentFinishContext = {
			response: { toolCalls, usage: this.responseUsage ?? emptyUsage() },
			append: (message) => {
				if (!appendWindowOpen) {
					throw new Error(
						'[flue] append() was called after its useAgentFinish callback settled. The continuation window is the callback itself — to send input at any other time, use the dispatcher from useDispatchMessage().',
					);
				}
				this.enqueueSignalAppend(assertAppendMessage(message));
			},
			log: this.createHookLogger('useAgentFinish', index),
			signal,
			get harness() {
				harness ??= session.createInvocationHarness(generateInvocationId(), signal);
				return harness as unknown as FlueHarness;
			},
		};
		try {
			await hook.run(ctx);
		} catch (error) {
			throw new Error(
				`[flue] A useAgentFinish callback (hook #${index} in declaration order) threw: ${error instanceof Error ? error.message : String(error)}`,
				{ cause: error },
			);
		} finally {
			appendWindowOpen = false;
			if (harness) {
				this.activeActionHarnesses.delete(harness);
				await harness.close();
			}
		}
	}

	/** `ctx.log` for one lifecycle hook run, attributed by declaration index. */
	private createHookLogger(
		hook: 'useAgentStart' | 'useAgentFinish' | 'useResponseStart' | 'useResponseFinish',
		hookIndex: number,
	): FlueLogger {
		return this.createAttributedLogger({ hook, hookIndex });
	}

	/** Shared `{ info, warn, error }` factory behind ctx.log: every call emits
	 *  a `log` event with `base` merged onto the caller's own attributes. */
	private createAttributedLogger(base: Record<string, unknown>): FlueLogger {
		const emit = (
			level: 'info' | 'warn' | 'error',
			message: string,
			attributes?: Record<string, unknown>,
		) => this.emit({ type: 'log', level, message, attributes: { ...attributes, ...base } });
		return {
			info: (message: string, attributes?: Record<string, unknown>) =>
				emit('info', message, attributes),
			warn: (message: string, attributes?: Record<string, unknown>) =>
				emit('warn', message, attributes),
			error: (message: string, attributes?: Record<string, unknown>) =>
				emit('error', message, attributes),
		};
	}

	/**
	 * Begin the response's client-facing output: reset per-submission tracking
	 * and run the `useResponseStart` hooks — the response's wake, once per
	 * response, before the first model call and before any `useAgentStart`
	 * hook (fail-fast — a throw fails the submission before the model runs). A
	 * resume re-entry whose response already has durable assistant steps
	 * adopts them instead: the wake hooks ran on the original attempt.
	 */
	private async beginResponseOutput(): Promise<void> {
		this.responseMessageId = undefined;
		this.responseHasCompletedStep = false;
		this.responseUsage = undefined;
		this.responseStartMetadata = undefined;
		this.outputWriteQueue = Promise.resolve();
		this.pendingPreAnchorDataWrites = [];
		if (!this.activeSubmissionId || !this.outputChannel) return;
		const conversation = await this.conversationWriter.getConversation(this.conversationId);
		const durableAnchor = conversation?.lastAssistantEntryBySubmission.get(this.activeSubmissionId);
		if (durableAnchor) {
			this.responseMessageId = durableAnchor;
			this.responseHasCompletedStep = true;
			// The finish hooks' usage aggregate spans all turns and re-attempts;
			// live accumulation only sees this attempt's message_end events, so
			// rebuild the prior attempts' share from durable records the same
			// way collectResponseToolCalls does.
			this.responseUsage = await this.collectResponseUsage(this.activeSubmissionId);
			return;
		}
		const declarations = this.outputChannel.responseStarts;
		if (declarations.length === 0) return;
		this.responseStartMetadata = runResponseMetadataHooks(
			'useResponseStart',
			declarations,
			(metadata, index): ResponseStartContext => ({
				metadata,
				log: this.createHookLogger('useResponseStart', index),
			}),
			{},
		);
	}

	/**
	 * Settle the response's client-facing output: wait for queued data writes
	 * (surfacing any append failure) and run the `useResponseFinish` hooks —
	 * the response's true end, once per response, after the last
	 * `useAgentFinish` cycle — appending their merged result. Each hook sees
	 * the response's accumulated metadata (what the wake hooks attached, read
	 * from the durable log so it survives re-attempts) and the final
	 * aggregates. Runs inside the submission's normal execution path, so a
	 * throw here settles the submission `failed` — no retry, no recovery.
	 */
	private async flushResponseOutput(): Promise<void> {
		await this.outputWriteQueue;
		if (!this.activeSubmissionId || !this.outputChannel || !this.responseMessageId) return;
		const submissionId = this.activeSubmissionId;
		const declarations = this.outputChannel.responseFinishes;
		if (declarations.length === 0) return;
		const state = await this.conversationWriter.loadReducedState();
		// Copied out of reducer state: the first hook's ctx.metadata is this
		// object, and hook code must not be able to mutate the reduced view.
		const durableMetadata = {
			...state.conversations.get(this.conversationId)?.responseMetadata.get(submissionId),
		};
		const response: ResponseFinishContext['response'] = {
			usage: this.responseUsage ?? emptyUsage(),
			toolCalls: await this.collectResponseToolCalls(submissionId),
		};
		const metadata = runResponseMetadataHooks(
			'useResponseFinish',
			declarations,
			(current, index): ResponseFinishContext => ({
				metadata: current,
				response,
				log: this.createHookLogger('useResponseFinish', index),
			}),
			durableMetadata,
		);
		// usePersistentState writes made inside the finish hooks flush with the
		// metadata batch — this is the attempt's final durable point (the
		// would-stop drain ran before these hooks), so anything left buffered
		// here would otherwise be silently lost.
		const records: ConversationRecord[] = [
			...this.drainHookStateRecords(),
			...(metadata
				? [
						{
							...this.canonicalEnvelope('message_metadata'),
							type: 'message_metadata' as const,
							metadata,
						},
					]
				: []),
		];
		if (records.length > 0) await this.appendCanonical(records);
	}

	/** Turn buffered `usePersistentState` writes into canonical records, in write order. */
	private drainHookStateRecords(): ConversationRecord[] {
		if (!this.hookState) return [];
		return this.hookState.drain().map((write: HookStateWrite) => ({
			...this.canonicalEnvelope('state_write'),
			type: 'state_write' as const,
			name: write.name,
			value: write.value,
		}));
	}

	private modelRequestInfo(
		model: Model<any> | undefined,
		options?: SimpleStreamOptions,
	): ModelRequestInfo {
		if (!model) throw new Error('[flue] Missing configured model for turn telemetry.');
		const parsedEndpoint = parseProviderEndpoint(model.baseUrl);
		return {
			providerId: model.provider,
			providerName: providerTelemetryName(model.provider),
			requestedModel: model.id,
			api: model.api,
			serverAddress: parsedEndpoint?.address,
			serverPort: parsedEndpoint?.port,
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
		const tools = context.tools?.map((tool): TurnInputTool => ({
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		}));
		const request = this.modelRequestInfo(model, options);
		this.modelRequests.set(turnId, { info: request, startedAt: Date.now() });
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
		// Allowlisted provider-response metadata (raw finish reason, gateway
		// correlation) attached at the provider boundary — telemetry only.
		const providerDiagnostics = response ? readProviderResponseDiagnostics(response) : undefined;
		this.emit({
			type: 'turn',
			turnId,
			purpose,
			durationMs: durationSince(this.modelRequests.get(turnId)?.startedAt),
			request,
			response: {
				responseId: response?.responseId,
				responseModel: response?.responseModel,
				output,
				usage: fromProviderUsage(response?.usage),
				finishReason: response?.stopReason,
				...providerDiagnostics,
				...(error !== undefined || response?.errorMessage
					? { error: classifyError(error ?? response?.errorMessage) }
					: {}),
			},
			isError:
				error !== undefined ||
				response?.stopReason === 'error' ||
				response?.stopReason === 'aborted',
		});
	}

	constructor(options: SessionInitOptions) {
		this.name = options.name;
		this.conversationId = options.conversation.conversationId;
		this.affinityKey = options.conversation.affinityKey;
		this.config = options.config;
		this.envSlot = options.envSlot;
		this.envRuntime = options.envRuntime;
		// Live facade: every call reads the slot's CURRENT env, so a swapped
		// environment is immediately what `session.fs` operates on.
		this.fs = {
			readFile: (path) => this.env.readFile(path),
			readFileBuffer: (path) => this.env.readFileBuffer(path),
			writeFile: (path, content) => this.env.writeFile(path, content),
			stat: (path) => this.env.stat(path),
			readdir: (path) => this.env.readdir(path),
			exists: (path) => this.env.exists(path),
			mkdir: (path, mkdirOptions) => this.env.mkdir(path, mkdirOptions),
			rm: (path, rmOptions) => this.env.rm(path, rmOptions),
		};
		this.agentTools = options.agentTools ?? [];
		this.mcpUnavailable = options.mcpUnavailable ?? [];
		this.delegationDepth = options.delegationDepth ?? 0;
		this.createTaskSession = options.createTaskSession;
		this.createActionHarness = options.createActionHarness;
		this.scopeSignal = options.scopeSignal;
		this.onClose = options.onClose;
		this.conversationWriter = options.conversationWriter;
		this.attachmentStore = options.attachmentStore;
		this.executionIdentity = options.executionContext ?? {};
		this.hookState = options.hookState;
		this.rerender = options.rerender;
		this.outputChannel = options.output;
		this.advanceDelivery = options.advanceDelivery;
		this.outputChannel?.connect((name, data) => this.enqueueMessageDataWrite(name, data));
		// Dynamic resources (function agents): live sets start at the init
		// render; legacy agents keep their init-frozen config for life. The
		// task roster the model reads lives in the system prompt's "Available
		// Agents" section, frozen by the prompt-context baseline.
		this.resourceRuntime = options.resources;
		this.liveSkills = options.resources?.initial.skills ?? this.config.skills;
		this.liveSubagents = options.resources?.initial.subagents ?? this.config.subagents ?? {};
		this.lastNarratedResources = options.resources?.narrated;
		this.lastRenderedResources = options.resources?.initial;

		const systemPrompt = this.config.systemPrompt;

		const tools = this.assembleModelTools(
			this.createBuiltinToolGroups(this.attachedEnv),
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
			streamFn: this.emitTurnRequestAndStream,
			toolExecution: 'parallel',
			// Queued messages always drain together at the next boundary — 'all'
			// is Flue's only queue behavior. The steering queue carries joined
			// deliveries and finish-continuation appends: everything steered at a
			// boundary reaches the model together at the next turn start (pi's
			// one-at-a-time default would spread them across turns). Flue never
			// calls followUp(), but the mode is pinned so no latent
			// one-at-a-time behavior survives anywhere.
			steeringMode: 'all',
			followUpMode: 'all',
			sessionId: this.affinityKey,
			// Render-per-turn (function agents): runs after the turn_end handler
			// has committed the tool batch (state writes durable), so the next
			// provider request gets fresh tool closures and a recomposed prompt.
			...(options.rerender ? { prepareNextTurn: () => this.prepareRerenderTurn() } : {}),
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
						const parentId =
							(await this.conversationWriter.getConversationLeaf(this.conversationId)) ?? null;
						this.canonicalAssistant = { messageId, blocks: new Map() };
						this.canonicalToolRequestMessageId = undefined;
						const {
							role: _role,
							content: _content,
							stopReason: _stopReason,
							errorMessage: _errorMessage,
							timestamp: _timestamp,
							usage: _usage,
							...modelInfo
						} = event.message;
						// The submission's first assistant message is its response
						// message: it carries the precomputed start metadata (producers
						// already ran, safely, before the model call).
						const isResponseFirstMessage =
							this.activeSubmissionId !== undefined && this.responseMessageId === undefined;
						if (isResponseFirstMessage) this.responseMessageId = messageId;
						await this.appendCanonical([
							{
								...this.canonicalEnvelope('assistant_message_started'),
								type: 'assistant_message_started',
								messageId,
								parentId,
								modelInfo,
								...(isResponseFirstMessage && this.responseStartMetadata
									? { responseMetadata: this.responseStartMetadata }
									: {}),
							},
						]);
					}
					this.emit({ type: 'message_start', message: event.message, turnId });
					break;
				}
				case 'message_update': {
					const aEvent = event.assistantMessageEvent;
					const assistant = this.canonicalAssistant;
					if (assistant && aEvent.type === 'text_start') {
						const blockId = generateBlockId();
						assistant.blocks.set(aEvent.contentIndex, {
							id: blockId,
							type: 'text',
							deltaCount: 0,
							completed: false,
						});
						await this.appendCanonical([
							{
								...this.canonicalEnvelope('assistant_text_started'),
								type: 'assistant_text_started',
								messageId: assistant.messageId,
								blockId,
								blockIndex: aEvent.contentIndex,
							},
						]);
					} else if (assistant && aEvent.type === 'text_delta') {
						const block = assistant.blocks.get(aEvent.contentIndex);
						if (!block || block.type !== 'text')
							throw new Error('[flue] Canonical text delta has no started block.');
						this.enqueueCanonical(
							[
								{
									...this.canonicalEnvelope('assistant_text_delta'),
									type: 'assistant_text_delta',
									messageId: assistant.messageId,
									blockId: block.id,
									sequence: block.deltaCount++,
									delta: aEvent.delta,
								},
							],
							() => this.emit({ type: 'text_delta', text: aEvent.delta }),
						);
					} else if (assistant && aEvent.type === 'text_end') {
						const block = assistant.blocks.get(aEvent.contentIndex);
						if (!block || block.type !== 'text')
							throw new Error('[flue] Canonical text completion has no started block.');
						const content = aEvent.partial.content[aEvent.contentIndex];
						await this.flushCanonical();
						await this.appendCanonical([
							{
								...this.canonicalEnvelope('assistant_text_completed'),
								type: 'assistant_text_completed',
								messageId: assistant.messageId,
								blockId: block.id,
								deltaCount: block.deltaCount,
								...(content?.type === 'text' && content.textSignature
									? { textSignature: content.textSignature }
									: {}),
							},
						]);
						block.completed = true;
					} else if (assistant && aEvent.type === 'thinking_start') {
						const blockId = generateBlockId();
						assistant.blocks.set(aEvent.contentIndex, {
							id: blockId,
							type: 'reasoning',
							deltaCount: 0,
							completed: false,
						});
						await this.appendCanonical([
							{
								...this.canonicalEnvelope('assistant_reasoning_started'),
								type: 'assistant_reasoning_started',
								messageId: assistant.messageId,
								blockId,
								blockIndex: aEvent.contentIndex,
							},
						]);
						this.emit({ type: 'thinking_start', contentIndex: aEvent.contentIndex });
					} else if (assistant && aEvent.type === 'thinking_delta') {
						const block = assistant.blocks.get(aEvent.contentIndex);
						if (!block || block.type !== 'reasoning')
							throw new Error('[flue] Canonical reasoning delta has no started block.');
						this.enqueueCanonical(
							[
								{
									...this.canonicalEnvelope('assistant_reasoning_delta'),
									type: 'assistant_reasoning_delta',
									messageId: assistant.messageId,
									blockId: block.id,
									sequence: block.deltaCount++,
									delta: aEvent.delta,
								},
							],
							() =>
								this.emit({
									type: 'thinking_delta',
									contentIndex: aEvent.contentIndex,
									delta: aEvent.delta,
								}),
						);
					} else if (assistant && aEvent.type === 'thinking_end') {
						const block = assistant.blocks.get(aEvent.contentIndex);
						if (!block || block.type !== 'reasoning')
							throw new Error('[flue] Canonical reasoning completion has no started block.');
						const content = aEvent.partial.content[aEvent.contentIndex];
						await this.flushCanonical();
						await this.appendCanonical([
							{
								...this.canonicalEnvelope('assistant_reasoning_completed'),
								type: 'assistant_reasoning_completed',
								messageId: assistant.messageId,
								blockId: block.id,
								deltaCount: block.deltaCount,
								...(content?.type === 'thinking' && content.thinkingSignature
									? { encrypted: content.thinkingSignature }
									: {}),
								...(content?.type === 'thinking' && content.redacted ? { redacted: true } : {}),
							},
						]);
						block.completed = true;
						this.emit({
							type: 'thinking_end',
							contentIndex: aEvent.contentIndex,
							content: aEvent.content,
						});
					} else if (assistant && aEvent.type === 'toolcall_end') {
						await this.appendCanonical([
							{
								...this.canonicalEnvelope('assistant_tool_call'),
								type: 'assistant_tool_call',
								messageId: assistant.messageId,
								blockId: generateBlockId(),
								blockIndex: aEvent.contentIndex,
								toolCallId: aEvent.toolCall.id,
								name: aEvent.toolCall.name,
								arguments: aEvent.toolCall.arguments,
								...(aEvent.toolCall.thoughtSignature
									? { thoughtSignature: aEvent.toolCall.thoughtSignature }
									: {}),
							},
						]);
					} else if (aEvent.type === 'toolcall_delta') {
						// Emit-only, deliberately outside the canonical pipeline: partial
						// tool-call arguments are live-preview material for observe()
						// subscribers, never persisted or replayed. `toolcall_end` above
						// stays the sole source of the canonical assistant_tool_call.
						// Forwarded only once the streaming block knows its identity
						// (providers deliver id/name in the first fragment).
						const content = aEvent.partial.content[aEvent.contentIndex];
						if (content?.type === 'toolCall' && content.id && content.name) {
							this.emit({
								type: 'toolcall_delta',
								toolCallId: content.id,
								toolName: content.name,
								argumentTextDelta: aEvent.delta,
							});
						}
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
								await this.appendCanonical([
									block.type === 'text'
										? {
												...this.canonicalEnvelope('assistant_text_completed'),
												type: 'assistant_text_completed',
												messageId: canonical.messageId,
												blockId: block.id,
												deltaCount: block.deltaCount,
											}
										: {
												...this.canonicalEnvelope('assistant_reasoning_completed'),
												type: 'assistant_reasoning_completed',
												messageId: canonical.messageId,
												blockId: block.id,
												deltaCount: block.deltaCount,
											},
								]);
								block.completed = true;
							}
							await this.appendCanonical([
								{
									...this.canonicalEnvelope('assistant_message_completed'),
									type: 'assistant_message_completed',
									messageId: canonical.messageId,
									stopReason: event.message.stopReason,
									usage: event.message.usage,
									...(event.message.errorMessage ? { error: event.message.errorMessage } : {}),
								},
							]);
							if (this.activeSubmissionId) {
								this.responseHasCompletedStep = true;
								const stepUsage = fromProviderUsage(event.message.usage);
								if (stepUsage) {
									this.responseUsage = this.responseUsage
										? addUsage(this.responseUsage, stepUsage)
										: stepUsage;
								}
								this.flushPreAnchorDataWrites();
							}
							this.canonicalToolRequestMessageId = event.message.content.some(
								(content) => content.type === 'toolCall',
							)
								? canonical.messageId
								: undefined;
							this.canonicalAssistant = undefined;
						}
						const request =
							this.modelRequests.get(turnId)?.info ??
							this.modelRequestInfo(this.agentLoop.state.model);
						this.emitTurn(turnId, 'agent', event.message, request);
						this.modelRequests.delete(turnId);
					}
					this.emit({ type: 'message_end', message: event.message, turnId });
					break;
				}
				case 'tool_execution_start': {
					const tool = this.agentLoop.state.tools.find(
						(candidate) => candidate.name === event.toolName,
					);
					this.activeToolCalls.set(event.toolCallId, {
						startedAt: Date.now(),
						toolName: event.toolName,
						telemetry: tool
							? (this.modelToolTelemetry.get(tool) ?? { origin: 'model' })
							: { origin: 'model' },
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
						telemetry: { origin: 'model' as const },
						startEmitted: false,
					};
					const assistantMessageId = this.canonicalToolRequestMessageId;
					if (!assistantMessageId) {
						throw new Error('[flue] Canonical tool outcome has no assistant request.');
					}
					const outcomeKey = `${encodeCanonicalId(assistantMessageId)}_${encodeCanonicalId(event.toolCallId)}`;
					const messageId = `entry_tool_outcome_${outcomeKey}`;
					const result = event.result as AgentToolResult<any>;
					const outcomeContent = await this.persistToolResultContent(result, messageId);
					const details = result.details as { output?: unknown } | undefined;
					const hasStructuredOutput =
						!event.isError &&
						typeof details === 'object' &&
						details !== null &&
						'output' in details;
					// Measure once and reuse for both the durable record and the
					// ephemeral `tool` event so the two can never disagree.
					const toolDurationMs = durationSince(call.startedAt);
					await this.appendCanonical([
						{
							...this.canonicalEnvelope('tool_outcome', `record_tool_outcome_${outcomeKey}`),
							type: 'tool_outcome',
							assistantMessageId,
							toolCallId: event.toolCallId,
							toolName: event.toolName,
							isError: event.isError,
							content: outcomeContent,
							...(hasStructuredOutput ? { output: details?.output } : {}),
							durationMs: toolDurationMs,
						},
					]);
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
								durationMs: toolDurationMs,
							},
							{
								...call.telemetry,
								...(call.effectiveResultCaptured ? { effectiveResult: call.effectiveResult } : {}),
								// call.error is always set when isError is true: the tool
								// protocol expresses errors as throws (AgentToolResult has no
								// error flag), and every model tool runs inside wrapModelTool's
								// catch. The event.result fallback is unreachable belt.
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
						const parentId = await this.conversationWriter.getConversationLeaf(this.conversationId);
						if (!parentId)
							throw new Error('[flue] Canonical tool results have no assistant parent.');
						const assistantMessageId = this.canonicalToolRequestMessageId;
						if (!assistantMessageId)
							throw new Error('[flue] Canonical tool results have no assistant request.');
						const conversation = await this.requireConversation();
						const outcomeIds = event.toolResults.map((toolResult) => {
							const outcome = conversation.toolOutcomes.get(
								toolOutcomeKey(assistantMessageId, toolResult.toolCallId),
							);
							if (!outcome) throw new Error('[flue] Canonical tool result has no durable outcome.');
							return outcome;
						});
						const finalToolResult = event.toolResults.at(-1);
						if (!finalToolResult) {
							throw new ConversationRecordInvariantError({
								recordId: `record_tool_results_committed_${encodeCanonicalId(assistantMessageId)}`,
								recordType: 'tool_results_committed',
								reason: 'A committed canonical tool-result batch must contain at least one result.',
							});
						}
						// Buffered usePersistentState writes land in the same append batch as the
						// commit marker — one store.append, one durability point. If
						// recovery settles this batch as interrupted, the writes never
						// happened, exactly like the tool side effects they rode with.
						// (Signal appends never sit pending at turn boundaries:
						// `ctx.append` exists only inside lifecycle callbacks, and each
						// callback's own batch drains them before it returns.)
						await this.appendCanonical([
							...this.drainHookStateRecords(),
							{
								...this.canonicalEnvelope(
									'tool_results_committed',
									`record_tool_results_committed_${encodeCanonicalId(assistantMessageId)}`,
								),
								type: 'tool_results_committed',
								assistantMessageId,
								parentId,
								outcomeIds,
							},
						]);
						for (const toolResult of event.toolResults) {
							this.pendingToolPublications.get(toolResult.toolCallId)?.();
							this.pendingToolPublications.delete(toolResult.toolCallId);
						}
						this.canonicalToolRequestMessageId = undefined;
					} else {
						// No tool batch this turn: persist any stray buffered writes on
						// their own so nothing sits in memory past the turn boundary.
						const stateWrites = this.drainHookStateRecords();
						if (stateWrites.length > 0) await this.appendCanonical(stateWrites);
					}
					// Turn boundary: absorb queued dispatch deliveries into this live
					// response (dispatch-while-busy). The turn batch above committed,
					// so the leaf is settled and buffered appends are drained; steered
					// here, joined messages drain at the loop's post-turn steering
					// poll and reach the model at the next turn start — and when the
					// model would otherwise stop, the non-empty steering queue keeps
					// the loop running to answer them.
					await this.applyQueuedJoins();
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
					signal,
				});
			}),
		);
	}

	async inspectSubmissionInput(input: AgentSubmissionInput): Promise<AgentSubmissionInspection> {
		const conversation = await this.conversationWriter.getConversation(this.conversationId);
		if (!conversation?.entries.has(this.canonicalInputEntryId(input))) return 'absent';
		return this.inspectCanonicalState(
			classifyConversationSubmission(conversation, this.canonicalInputEntryId(input), {
				contextWindow: this.agentLoop.state.model?.contextWindow ?? 0,
			}),
		);
	}

	processSubmissionInput(
		input: AgentSubmissionInput,
		options?: ProcessAgentSubmissionOptions,
	): CallHandle<void> {
		return createCallHandle(undefined, (signal) =>
			this.runOperation('prompt', signal, () =>
				this.runPersistedSubmissionInput(input, signal, options),
			),
		);
	}

	/**
	 * Complete the trailing partial tool-result batch left by a turn that was
	 * interrupted mid-batch, so resumption continues from the repaired batch
	 * instead of replaying — and re-executing — tool calls whose results were
	 * already recorded. Conservative by construction: every recorded result is
	 * preserved (first-write-wins) and unresolved calls get explicit
	 * unknown-outcome error results — never a blind re-execution. Two scoped
	 * exceptions resolve real outcomes pre-commit: in-flight `task` children
	 * are resumed, and `durable: true` tool calls are re-executed with their
	 * completed steps replaying from durable memos. The batch is derived from
	 * persisted canonical history.
	 *
	 * `batchRequired` is the caller's assertion that classification proved a
	 * repairable batch exists: a finder miss then means the classifier and the
	 * finder disagree about the tail, and resuming anyway would replay the
	 * turn and re-execute recorded tool calls — refuse loudly instead. Without
	 * it, a missing batch is a legitimate no-op.
	 */
	private async repairTrailingPartialToolBatch(
		inputEntryId: string,
		signal: AbortSignal,
		options: { batchRequired: boolean },
	): Promise<void> {
		const conversation = await this.requireConversation();
		const following = getActiveConversationPathSince(conversation, inputEntryId);
		if (!following) {
			if (options.batchRequired) {
				throw new Error(
					'[flue] Classification found a trailing partial tool batch but repair cannot locate it — refusing to resume (a plain resume would re-execute recorded tool calls).',
				);
			}
			return;
		}
		const messages = following.flatMap((entry) => (entry.type === 'message' ? [entry] : []));
		const partial = findTrailingPartialToolBatch(messages);
		if (!partial) {
			if (options.batchRequired) {
				throw new Error(
					'[flue] Classification found a trailing partial tool batch but repair cannot locate it — refusing to resume (a plain resume would re-execute recorded tool calls).',
				);
			}
			return;
		}
		// Subagent recovery (Model B): resolve any unresolved `task` calls in this
		// batch by resuming their in-flight children in-process, BEFORE the atomic
		// commit, so the committed outcome is the real child result rather than an
		// interrupted marker. Sequential and pre-commit by design (see plan §P1.4).
		const resolvedOutcomes = await this.resumeUnresolvedTaskCalls(conversation, partial, signal);
		await this.resumeDurableToolCalls(conversation, partial, signal, resolvedOutcomes);
		await this.appendRepairedToolResultBatch(
			partial.entryId,
			partial.toolCalls,
			conversation,
			resolvedOutcomes,
		);
	}

	/**
	 * Resume each unresolved model-invoked `task` call in a trailing partial
	 * batch from its durable child conversation, returning a real `tool_outcome`
	 * record per resolved call (keyed by tool call id). Calls without a
	 * `child_session_retained` link (e.g. programmatic `session.task()`) are left
	 * for the interrupted-marker path. Failure policy (D-B): a provably-permanent
	 * config failure (`SubagentNotDeclaredError`) yields an error outcome so the
	 * parent continues degraded; every other failure propagates so the parent's
	 * retry budget re-attempts (never silently abandon possibly-recoverable work).
	 */
	private async resumeUnresolvedTaskCalls(
		conversation: ReducedConversationState,
		partial: {
			entryId: string;
			assistant: AssistantMessage;
			toolCalls: ReadonlyArray<{ id: string; name: string }>;
		},
		signal: AbortSignal,
	): Promise<Map<string, ConversationRecord>> {
		const resolved = new Map<string, ConversationRecord>();
		for (const toolCall of partial.toolCalls) {
			if (toolCall.name !== 'task') continue;
			if (conversation.toolOutcomes.has(toolOutcomeKey(partial.entryId, toolCall.id))) continue;
			const ref = [...conversation.childConversations.values()].find(
				(child): child is Extract<CanonicalChildSessionRef, { type: 'task' }> =>
					child.type === 'task' && child.parentToolCallId === toolCall.id,
			);
			if (!ref) continue;
			resolved.set(
				toolCall.id,
				await this.resumeChildTaskCall(
					partial.entryId,
					partial.assistant,
					toolCall.id,
					ref,
					signal,
				),
			);
		}
		return resolved;
	}

	/**
	 * Re-execute each unresolved `durable: true` tool call in a trailing
	 * partial batch — the scoped exception to the never-re-execute doctrine.
	 * The durable tool's contract is that every side effect goes through
	 * `step.do`, so the re-run replays completed steps from their durable
	 * memos (same toolCallId → same memo ids) and only executes what never
	 * finished. Semantics mirror live execution: a throw becomes an isError
	 * outcome the model sees (never a propagated failure burning the
	 * submission's retry budget); only an abort propagates. A call whose
	 * current render no longer declares the tool — or no longer marks it
	 * durable — is left for the interrupted-marker path, so a redeploy
	 * degrades to today's behavior instead of guessing.
	 */
	private async resumeDurableToolCalls(
		conversation: ReducedConversationState,
		partial: {
			entryId: string;
			assistant: AssistantMessage;
			toolCalls: ReadonlyArray<{ id: string; name: string }>;
		},
		signal: AbortSignal,
		resolved: Map<string, ConversationRecord>,
	): Promise<void> {
		for (const toolCall of partial.toolCalls) {
			if (resolved.has(toolCall.id)) continue;
			if (conversation.toolOutcomes.has(toolOutcomeKey(partial.entryId, toolCall.id))) continue;
			const toolDef = this.agentTools.find((candidate) => candidate.name === toolCall.name);
			if (!toolDef?.durable) continue;
			if (signal.aborted) throw abortErrorFor(signal);
			resolved.set(
				toolCall.id,
				await this.reexecuteDurableToolCall(partial, toolCall.id, toolDef, signal),
			);
		}
	}

	/** One durable re-execution, from the durable tool-call block to a real
	 *  `tool_outcome` record in the live outcome format. */
	private async reexecuteDurableToolCall(
		partial: { entryId: string; assistant: AssistantMessage },
		toolCallId: string,
		toolDef: ToolDefinition,
		signal: AbortSignal,
	): Promise<ConversationRecord> {
		const block = partial.assistant.content.find(
			(candidate): candidate is Extract<typeof candidate, { type: 'toolCall' }> =>
				candidate.type === 'toolCall' && candidate.id === toolCallId,
		);
		const params = block?.arguments ?? {};
		const startedAt = Date.now();
		const outcomeKey = `${encodeCanonicalId(partial.entryId)}_${encodeCanonicalId(toolCallId)}`;
		const buildOutcome = (
			isError: boolean,
			text: string,
			output?: unknown,
		): ConversationRecord => ({
			...this.canonicalEnvelope('tool_outcome', `record_tool_outcome_${outcomeKey}`),
			type: 'tool_outcome',
			assistantMessageId: partial.entryId,
			toolCallId,
			toolName: toolDef.name,
			isError,
			content: [{ type: 'text', text }],
			...(output !== undefined ? { output } : {}),
			durationMs: durationSince(startedAt),
		});
		const log = this.createToolLogger(toolDef.name, toolCallId);
		// Fresh invocation scope per execution attempt (see createCustomTools):
		// child sessions never collide with a prior attempt's retained
		// conversations, while step memos — keyed by toolCallId — carry across.
		let harness: ActionHarness | undefined;
		try {
			const invocationId = toolDef.harness ? generateInvocationId() : undefined;
			harness = invocationId ? this.createInvocationHarness(invocationId, signal) : undefined;
			const parsed = parseToolInput(toolDef, params, signal, {
				log,
				toolCallId,
				step: this.createToolStep(toolDef.name, toolCallId, log),
				...(harness ? { harness } : {}),
			});
			const output = validateToolOutput(toolDef, await toolDef.run(parsed.context));
			return buildOutcome(false, output === undefined ? 'null' : JSON.stringify(output), output);
		} catch (error) {
			if (signal.aborted) throw error;
			return buildOutcome(true, error instanceof Error ? error.message : String(error));
		} finally {
			if (harness) {
				this.activeActionHarnesses.delete(harness);
				await harness.close();
			}
		}
	}

	/** Reattach to one in-flight child, resume it to completion, and build the
	 *  parent's real `tool_outcome` for the originating `task` call. */
	private async resumeChildTaskCall(
		assistantEntryId: string,
		assistant: AssistantMessage,
		toolCallId: string,
		ref: Extract<CanonicalChildSessionRef, { type: 'task' }>,
		signal: AbortSignal,
	): Promise<ConversationRecord> {
		if (!this.createTaskSession) {
			throw new Error('[flue] This session cannot resume task sessions.');
		}
		const toolCallBlock = assistant.content.find(
			(block): block is Extract<typeof block, { type: 'toolCall' }> =>
				block.type === 'toolCall' && block.id === toolCallId,
		);
		const args = (toolCallBlock?.arguments ?? {}) as {
			agent?: string;
			cwd?: string;
			prompt?: string;
			attachments?: Array<{ id: string }>;
		};
		// D-B: a renamed/removed subagent across a deploy is deterministically
		// unrecoverable — fall back to an error outcome for this one call only.
		let taskAgent: ResolvedSubagent | undefined;
		try {
			// Rebuild the delegate's delivered message from the durable tool call
			// so the resume render's `useDelivery()` sees what attempt one saw.
			const delivery =
				args.agent && typeof args.prompt === 'string'
					? taskDeliveryMessage(
							args.prompt,
							await this.resolveCanonicalImages([
								...new Set((args.attachments ?? []).map((attachment) => attachment.id)),
							]),
						)
					: undefined;
			taskAgent = args.agent ? this.resolveSubagent(args.agent, delivery) : undefined;
		} catch (error) {
			if (error instanceof SubagentNotDeclaredError) {
				return this.taskResumeFailureOutcomeRecord(assistantEntryId, toolCallId, error);
			}
			throw error;
		}

		const taskStartMs = Date.now();
		let child: Session | undefined;
		try {
			child = await this.createTaskSession({
				parentSession: this.name,
				parentConversationId: this.conversationId,
				taskId: ref.taskId,
				parentEnv: this.attachedEnv,
				cwd: args.cwd,
				agent: taskAgent,
				depth: this.delegationDepth + 1,
				existing: { conversationId: ref.conversationId },
				...(ref.parentToolCallId ? { parentToolCallId: ref.parentToolCallId } : {}),
				...(ref.parentAssistantEntryId
					? { parentAssistantEntryId: ref.parentAssistantEntryId }
					: {}),
			});
			// Registering with activeTasks lets the parent operation's abort reach
			// the child (runOperation.onAbort aborts every active task).
			this.activeTasks.add(child);
			// Child shares the parent's deadline (D1). No `task_start` re-emit on
			// resume (D-C) — only the terminal `task` event below.
			const text = await child.resumeReattachedChild({ timeoutAt: this.activeTimeoutAt, signal });
			this.emit({
				type: 'task',
				taskId: ref.taskId,
				agent: taskAgent?.name,
				isError: false,
				result: text,
				durationMs: durationSince(taskStartMs),
				parentSession: this.name,
				session: child.name,
				conversationId: child.conversationId,
			});
			return this.taskResumeOutcomeRecord(assistantEntryId, toolCallId, text);
		} finally {
			if (child) {
				await child.close();
				this.activeTasks.delete(child);
			}
		}
	}

	private taskResumeOutcomeRecord(
		assistantEntryId: string,
		toolCallId: string,
		text: string,
	): ConversationRecord {
		const key = `${encodeCanonicalId(assistantEntryId)}_${encodeCanonicalId(toolCallId)}`;
		return {
			...this.canonicalEnvelope('tool_outcome', `record_tool_outcome_${key}`),
			type: 'tool_outcome',
			assistantMessageId: assistantEntryId,
			toolCallId,
			toolName: 'task',
			isError: false,
			content: [{ type: 'text', text: text || '(task completed with no text)' }],
		};
	}

	private taskResumeFailureOutcomeRecord(
		assistantEntryId: string,
		toolCallId: string,
		error: SubagentNotDeclaredError,
	): ConversationRecord {
		const key = `${encodeCanonicalId(assistantEntryId)}_${encodeCanonicalId(toolCallId)}`;
		return {
			...this.canonicalEnvelope('tool_outcome', `record_tool_resume_failed_${key}`),
			type: 'tool_outcome',
			assistantMessageId: assistantEntryId,
			toolCallId,
			toolName: 'task',
			isError: true,
			content: [
				{
					type: 'text',
					text: JSON.stringify({
						type: 'subagent_unavailable',
						message: error.message,
					}),
				},
			],
		};
	}

	/**
	 * Shared repair core: build a complete ordered result batch for
	 * `toolCalls`, preserving already-settled results (first-write-wins), using a
	 * pre-resolved outcome where one was produced (resumed subagent task), and
	 * synthesizing interrupted-marker error results for the remaining unresolved
	 * calls — never a fabricated or assumed outcome.
	 */
	private async appendRepairedToolResultBatch(
		assistantEntryId: string,
		toolCalls: ReadonlyArray<{ id: string; name: string }>,
		conversation: ReducedConversationState,
		resolved: Map<string, ConversationRecord>,
	): Promise<void> {
		// The commit invariant demands the toolUse assistant still be the leaf
		// (the reducer would reject the commit anyway) — a buried batch cannot
		// be repaired, and a silent skip here would resume into a turn replay
		// that re-executes recorded tool calls. `settleTrailingToolBatch`
		// pre-checks this exact condition before calling.
		if (conversation.activeLeafId !== assistantEntryId) {
			throw new Error(
				'[flue] Cannot repair the trailing tool batch: its toolUse assistant is no longer the conversation leaf — an entry was appended before repair.',
			);
		}
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
				outcomeIds.push(outcome);
				continue;
			}
			const resolvedRecord = resolved.get(toolCall.id);
			if (resolvedRecord) {
				outcomeRecords.push(resolvedRecord);
				outcomeIds.push(resolvedRecord.id);
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
				content: [
					{
						type: 'text',
						text: JSON.stringify({
							type: 'interrupted',
							message: 'Tool execution was interrupted before completion. The outcome is unknown.',
						}),
					},
				],
			});
			outcomeIds.push(recordId);
		}
		if (outcomeRecords.length > 0) await this.appendCanonical(outcomeRecords);
		await this.appendCanonical([
			{
				...this.canonicalEnvelope(
					'tool_results_committed',
					`record_tool_repair_commit_${encodeCanonicalId(assistantEntryId)}`,
				),
				type: 'tool_results_committed',
				assistantMessageId: assistantEntryId,
				parentId: assistantEntryId,
				outcomeIds,
			},
		]);
		await this.rebuildCanonicalContext();
	}

	/**
	 * Upgrade the trailing aborted partial to a stream continuation: when the
	 * committed partial has content worth continuing from (non-empty text or
	 * reasoning, no tool calls), append the deterministic
	 * `stream_interrupted`/`stream_continued` signal pair so the partial enters
	 * model context with the instruction to continue rather than being replayed
	 * from scratch. Semantic recovery, classification-driven — the structural
	 * half (materializing the in-progress stream as a committed aborted entry)
	 * already happened unconditionally at the ownership seam
	 * (`materializeGhostStream`).
	 *
	 * Idempotent: an already-upgraded partial (both signal entries present at
	 * the tail) reports success without appending. A partial that is no longer
	 * the active leaf is left alone — the signals must chain off the partial,
	 * and a moved-on conversation resumes by plain replay instead.
	 */
	private async upgradeAbortedPartialToContinuation(): Promise<boolean> {
		const conversation = await this.conversationWriter.getConversation(this.conversationId);
		if (!conversation) return false;
		const partial = getActiveConversationPath(conversation).findLast(
			(entry) =>
				entry.type === 'message' &&
				entry.submissionId === this.activeSubmissionId &&
				entry.message.role === 'assistant' &&
				entry.message.stopReason === 'aborted' &&
				!entry.message.content.some((block) => block.type === 'toolCall') &&
				entry.message.content.some(
					(block) =>
						(block.type === 'text' && block.text.length > 0) ||
						(block.type === 'thinking' && block.thinking.length > 0),
				),
		);
		if (!partial) return false;
		const continuedEntryId = `entry_recovery_${partial.id}_stream_continued`;
		if (
			conversation.entries.has(`entry_recovery_${partial.id}_stream_interrupted`) &&
			conversation.entries.has(continuedEntryId)
		) {
			return true;
		}
		if (conversation.activeLeafId !== partial.id) return false;
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
				content:
					signalType === 'stream_interrupted'
						? 'The previous assistant stream was interrupted.'
						: 'Continue from the durable partial assistant response.',
			});
			parentId = messageId;
		}
		await this.appendCanonical(records);
		await this.rebuildCanonicalContext();
		return true;
	}

	/**
	 * Build the canonical records that materialize an interrupted in-progress
	 * assistant stream as a completed aborted entry: completion markers for the
	 * unfinished text/reasoning blocks plus the aborted
	 * `assistant_message_completed`. Record ids are deterministic, so streams
	 * converged by earlier runtime versions (which had a second materialization
	 * path) reduce identically and a re-converge is a structural no-op.
	 */
	private materializeInProgressStreamRecords(
		inProgress: InProgressAssistantMessage,
	): ConversationRecord[] {
		const records: ConversationRecord[] = [];
		for (const block of inProgress.blocks.values()) {
			if ((block.type === 'text' || block.type === 'reasoning') && !block.completed) {
				records.push(
					block.type === 'text'
						? {
								...this.canonicalEnvelope(
									'assistant_text_completed',
									`record_recovery_${inProgress.messageId}_${block.blockId}_completed`,
								),
								type: 'assistant_text_completed',
								messageId: inProgress.messageId,
								blockId: block.blockId,
								deltaCount: block.deltas.length,
							}
						: {
								...this.canonicalEnvelope(
									'assistant_reasoning_completed',
									`record_recovery_${inProgress.messageId}_${block.blockId}_completed`,
								),
								type: 'assistant_reasoning_completed',
								messageId: inProgress.messageId,
								blockId: block.blockId,
								deltaCount: block.deltas.length,
							},
				);
			}
		}
		records.push({
			...this.canonicalEnvelope(
				'assistant_message_completed',
				`record_recovery_${inProgress.messageId}_aborted`,
			),
			type: 'assistant_message_completed',
			messageId: inProgress.messageId,
			stopReason: 'aborted',
			usage: zeroProviderUsage(),
			error: 'Stream interrupted before completion.',
		});
		return records;
	}

	/**
	 * A convergence scope names whose dangling state a repair may touch.
	 * `{ submissionId }` restricts to state stamped with that submission
	 * (`undefined` matches unowned state — programmatic prompts, subagent
	 * children); `'any'` matches regardless of owner — used at ownership seams,
	 * where per-session submission serialization guarantees any dangling state
	 * was abandoned by a previous driver.
	 */
	private ownsDanglingState(
		scope: { submissionId: string | undefined } | 'any',
	): (submissionId: string | undefined) => boolean {
		return (submissionId) => scope === 'any' || submissionId === scope.submissionId;
	}

	/**
	 * Structural convergence: materialize the in-progress assistant stream at
	 * the active leaf as a completed aborted entry, so no crash shape can leave
	 * the conversation with in-progress bookkeeping that blocks appends or
	 * projects as still-streaming. Runs unconditionally at every ownership seam
	 * — resume entry, new input, terminalization — and is idempotent: a clean
	 * stream is a no-op, and record ids are deterministic. Never wrong by
	 * construction: an in-progress message under a scope the caller owns is
	 * necessarily dead (its writer is fenced out or was never durable).
	 *
	 * Single-shot on purpose: materializing the leaf ghost advances the leaf,
	 * which strands any sibling ghost off-tail — and off-tail bookkeeping is the
	 * reducer's settle barrier's job (dropped at `submission_settled`), not an
	 * append-based repair's. No resumption signals are appended here; whether
	 * the materialized partial is worth continuing from is semantic recovery
	 * (`upgradeAbortedPartialToContinuation`), decided by classification.
	 *
	 * Returns true when a ghost was materialized.
	 */
	async materializeGhostStream(
		scope: { submissionId: string | undefined } | 'any',
	): Promise<boolean> {
		const owns = this.ownsDanglingState(scope);
		const conversation = await this.conversationWriter.getConversation(this.conversationId);
		if (!conversation) return false;
		const inProgress = [...conversation.inProgressMessages.values()].find(
			(message) => message.parentId === conversation.activeLeafId,
		);
		if (!inProgress || !owns(inProgress.submissionId)) return false;
		await this.appendCanonical(this.materializeInProgressStreamRecords(inProgress));
		await this.rebuildCanonicalContext();
		return true;
	}

	/**
	 * Marker-settle the trailing uncommitted tool batch so the conversation can
	 * come to rest. Recorded outcomes are preserved first-write-wins; every
	 * unresolved call gets an explicit unknown-outcome error — never a
	 * re-execution, and never a child resume (that is budgeted attempt-path
	 * work; see `resumeUnresolvedTaskCalls`). Returns the calls that were
	 * settled with interrupted markers.
	 *
	 * Settleable by construction: `tool_results_committed` is all-or-nothing,
	 * so a partial batch is always uncommitted and its toolUse assistant is
	 * still the active leaf (nothing can follow it until commit), which
	 * satisfies the commit-parent invariant. Deliberately NOT run at resume
	 * entry — a resumed attempt's trailing batch is live work that
	 * `repairTrailingPartialToolBatch` recovers precisely (task children
	 * resumed, durable tools replayed); a marker-settle would pre-empt it.
	 */
	private async settleTrailingToolBatch(
		scope: { submissionId: string | undefined } | 'any',
	): Promise<ReadonlyArray<InterruptedToolCallRef>> {
		const owns = this.ownsDanglingState(scope);
		const conversation = await this.conversationWriter.getConversation(this.conversationId);
		if (!conversation) return [];
		const messages = getActiveConversationPath(conversation).flatMap((entry) =>
			entry.type === 'message' ? [entry] : [],
		);
		const partial = findTrailingPartialToolBatch(messages);
		if (!partial || conversation.activeLeafId !== partial.entryId) return [];
		const batchEntry = conversation.entries.get(partial.entryId);
		if (!owns(batchEntry?.type === 'message' ? batchEntry.submissionId : undefined)) return [];

		const settled: InterruptedToolCallRef[] = [];
		const resolved = new Map<string, ConversationRecord>();
		for (const toolCall of partial.toolCalls) {
			if (conversation.toolOutcomes.has(toolOutcomeKey(partial.entryId, toolCall.id))) continue;
			settled.push({ name: toolCall.name, id: toolCall.id });
			if (toolCall.name !== 'task') continue;
			const ref = [...conversation.childConversations.values()].find(
				(child): child is Extract<CanonicalChildSessionRef, { type: 'task' }> =>
					child.type === 'task' && child.parentToolCallId === toolCall.id,
			);
			if (!ref) continue;
			resolved.set(
				toolCall.id,
				this.taskInterruptedOutcomeRecord(partial.entryId, toolCall.id, ref.conversationId),
			);
		}
		await this.appendRepairedToolResultBatch(
			partial.entryId,
			partial.toolCalls,
			conversation,
			resolved,
		);
		return settled;
	}

	/**
	 * Settle all dangling conversation state so the conversation comes to rest:
	 * the ghost stream materialized as an aborted entry (without resumption
	 * signals — the conversation is settling, not resuming), then the trailing
	 * uncommitted tool batch marker-settled. The two shapes are mutually
	 * exclusive per turn (a next-turn stream can only start after the batch
	 * commits), so ordering is a formality. Used by paths that terminate work;
	 * resume entry converges only the ghost half (its batch is live work).
	 */
	private async settleDanglingConversationState(
		scope: { submissionId: string | undefined } | 'any',
	): Promise<ReadonlyArray<InterruptedToolCallRef>> {
		await this.materializeGhostStream(scope);
		return await this.settleTrailingToolBatch(scope);
	}

	/**
	 * Interrupted-marker outcome for a `task` call settled at terminalization:
	 * identical semantics (and record id) to the generic interrupted marker,
	 * plus the retained child conversation id so apps and future turns can
	 * locate the child's durable transcript. The child reference itself
	 * (`child_session_retained`) is untouched.
	 */
	private taskInterruptedOutcomeRecord(
		assistantEntryId: string,
		toolCallId: string,
		childConversationId: string,
	): ConversationRecord {
		const key = `${encodeCanonicalId(assistantEntryId)}_${encodeCanonicalId(toolCallId)}`;
		return {
			...this.canonicalEnvelope('tool_outcome', `record_tool_repair_outcome_${key}`),
			type: 'tool_outcome',
			assistantMessageId: assistantEntryId,
			toolCallId,
			toolName: 'task',
			isError: true,
			content: [
				{
					type: 'text',
					text: JSON.stringify({
						type: 'interrupted',
						message: 'Tool execution was interrupted before completion. The outcome is unknown.',
						childConversationId,
					}),
				},
			],
		};
	}

	async recordSubmissionTerminal(
		input: AgentSubmissionInterruption,
	): Promise<ReadonlyArray<InterruptedToolCallRef>> {
		// Terminalizing a submission first settles its conversation to a
		// deterministic rest state — ghost stream materialized, trailing batch
		// marker-settled — so no tool call ever rests without a terminal outcome
		// and the turn stays visible to future model context. This is the
		// contract of terminalization, not a caller responsibility: every
		// terminal path (retry exhaustion, timeout, post-input interruption,
		// abort) routes through here.
		const interruptedTools = await this.settleDanglingConversationState({
			submissionId: input.submissionId,
		});
		let body = input.message;
		if (interruptedTools.length > 0) {
			const toolList = interruptedTools.map((t) => `  - ${t.name} (${t.id})`).join('\n');
			body += `\n\nInterrupted tool call(s):\n${toolList}`;
		}
		const aborted = input.reason === 'aborted';
		const signalType = aborted ? 'submission_aborted' : 'submission_interrupted';
		const slug = aborted ? 'submission_aborted' : 'submission_interrupted';
		const recordId = `record_${slug}_${input.submissionId}`;
		if (await this.conversationWriter.hasRecord(recordId)) return interruptedTools;
		const parentId = await this.conversationWriter.getConversationLeaf(this.conversationId);
		await this.appendCanonical([
			{
				...this.canonicalEnvelope('signal', recordId),
				type: 'signal',
				messageId: `entry_${slug}_${input.submissionId}`,
				parentId,
				signalType,
				content: body,
				attributes: {
					submissionId: input.submissionId,
					kind: input.kind,
					reason: input.reason,
					...(interruptedTools.length > 0
						? { interruptedTools: JSON.stringify(interruptedTools) }
						: {}),
				},
			},
		]);
		await this.rebuildCanonicalContext();
		return interruptedTools;
	}

	skill<S extends v.GenericSchema>(
		skill: Skill | string,
		options: SkillOptions<S> & { result: S },
	): CallHandle<PromptResultResponse<v.InferOutput<S>>>;
	skill(skill: Skill | string, options?: SkillOptions): CallHandle<PromptResponse>;
	skill(
		skill: Skill | string,
		options?: SkillOptions<v.GenericSchema | undefined>,
	): CallHandle<any> {
		return createCallHandle(options?.signal, (signal) =>
			this.runOperation('skill', signal, async () => {
				const schema = options?.result;

				let promptText: string;
				let skillName: string;
				let activePackagedSkills: Record<string, PackagedSkillDirectory> | undefined;
				if (typeof skill === 'string') {
					const registered = this.liveSkills[skill];
					if (!registered) {
						this.throwMissingSkill(skill);
					} else if (isWorkspaceSkill(registered)) {
						promptText = buildSkillByPathlessNamePrompt(skill, options?.args, schema);
					} else {
						const packaged = this.resolveRegisteredPackage(registered);
						promptText = buildPackagedSkillPrompt(packaged, options?.args, schema);
						activePackagedSkills = { [packaged.id]: packaged };
					}
					skillName = skill;
				} else {
					const packaged = this.resolveRegisteredPackage(skill);
					promptText = buildPackagedSkillPrompt(packaged, options?.args, schema);
					activePackagedSkills = { [packaged.id]: packaged };
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
				// later turns and lets compaction handle it via the same path
				// as real tool calls. The record hook appends the transcript
				// triple before each terminal tool event; harness.shell()
				// shares the same envelope without it.
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

	abort(reason?: unknown): void {
		this.agentLoop.abort();
		this.compactionAbortController?.abort(reason);
		this.modelRetryAbortController?.abort(reason);
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

	/**
	 * Precedence: call-level > agent-level default. A call-level specifier
	 * resolves via `resolveModel` (which throws on an invalid specifier and never
	 * returns undefined for a defined one); the agent default is always present.
	 */
	private resolveModelForCall(modelSpecifier: string | undefined): Model<any> {
		if (!modelSpecifier) return this.config.model;
		const model = this.config.resolveModel(modelSpecifier);
		if (!model) throw new Error(`[flue] Model "${modelSpecifier}" could not be resolved.`);
		return model;
	}

	/** Precedence: call-level > agent-level default > 'medium'. */
	private resolveThinkingLevelForCall(callValue: ThinkingLevel | undefined): ThinkingLevel {
		return callValue ?? this.config.thinkingLevel ?? 'medium';
	}

	/** The packaged directory behind a registered skill: import-attached or lazily built from an inline definition. */
	private resolveRegisteredPackage(skill: Skill): PackagedSkillDirectory {
		if ('__flueSkillReference' in skill) {
			const packaged = getSkillReferenceDirectory(skill);
			if (!packaged)
				throw new Error(
					`[flue] Packaged skill "${skill.name}" is unavailable for this application build.`,
				);
			return packaged;
		}
		return packageSkillDefinition(skill);
	}

	private async activateSkillForTool(name: string): Promise<string> {
		// Resolve against the LIVE skill set — the activate_skill schema is a
		// plain string (never a name union, which would rewrite the tool spec
		// on every dynamic-skill flip), so unknown names are a real model-facing
		// path: answer with a factual miss, not a thrown session error.
		const registered = this.liveSkills[name];
		if (!registered) {
			const available = Object.keys(this.liveSkills);
			return `Skill "${name}" is not available. Available skills: ${available.join(', ')}.`;
		}
		if (isWorkspaceSkill(registered)) {
			return buildWorkspaceSkillPrompt(
				registered.name,
				registered.directory,
				registered.skillMdPath,
				await this.env.readFile(registered.skillMdPath),
			);
		}
		return buildPackagedSkillPrompt(this.resolveRegisteredPackage(registered));
	}

	private throwMissingSkill(skill: string): never {
		throw new SkillNotRegisteredError({
			skill,
			available: Object.keys(this.liveSkills),
			...(this.attachedEnv ? { skillsDir: skillsDirIn(this.attachedEnv.cwd) } : {}),
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

	/**
	 * `ctx.log` for one tool call: progress lines emitted into the
	 * conversation stream as `log` events attributed to the call. Not part of
	 * the tool result; the model never sees them.
	 */
	private createToolLogger(tool: string, toolCallId: string): FlueLogger {
		return this.createAttributedLogger({ tool, toolCallId });
	}

	/**
	 * The invocation-scoped `step` behind `durable: true` tools. Each
	 * completed step settles as a `tool_step_settled` record under the
	 * deterministic id derived from `(toolCallId, stepName)`, and the append
	 * is awaited before `do` resolves — a checkpoint that has not landed is
	 * not a checkpoint. A recovery re-execution of the same toolCallId finds
	 * a prior attempt's memo by that id and replays the recorded value
	 * instead of running the step again. The returned value is always the
	 * JSON clone, so first execution and replay hand the caller identical
	 * shapes.
	 */
	private createToolStep(toolName: string, toolCallId: string, log: FlueLogger): ToolStep {
		const used = new Set<string>();
		return {
			do: async <T>(name: string, fn: () => T | Promise<T>): Promise<T> => {
				const stepName = claimStepName(name, toolName, used);
				const recordId = toolStepRecordId(toolCallId, stepName);
				const existing = await this.conversationWriter.getRecord(recordId);
				if (existing?.type === 'tool_step_settled') {
					log.info(`step "${stepName}" replayed`, { step: stepName });
					return existing.value as T;
				}
				const value = cloneStepValue(await fn(), toolName, stepName);
				await this.appendCanonical([
					{
						...this.canonicalEnvelope('tool_step_settled', recordId),
						type: 'tool_step_settled',
						toolCallId,
						toolName,
						stepName,
						value,
					},
				]);
				log.info(`step "${stepName}" completed`, { step: stepName });
				return value as T;
			},
		};
	}

	/**
	 * The invocation-scoped harness behind `harness: true` tools and
	 * lifecycle hook runs: the one interface between tool code and the agent's runtime
	 * (sandbox shell/fs, sessions, model calls). Scoped to the invocation
	 * (`close()` after the run), depth-counted against the general delegation
	 * cap — the fuse on tool→session→tool recursion — and every child
	 * conversation it opens is durably retained under the invocation id.
	 * Callers must remove it from {@link activeActionHarnesses} and `close()`
	 * it when the run settles.
	 */
	private createInvocationHarness(invocationId: string, signal?: AbortSignal): ActionHarness {
		if (!this.createActionHarness) {
			throw new Error('[flue] This session cannot run harness-connected tools.');
		}
		if (this.delegationDepth >= MAX_DELEGATION_DEPTH) {
			throw new DelegationDepthExceededError({ maxDepth: MAX_DELEGATION_DEPTH });
		}
		const harness = this.createActionHarness({
			invocationId,
			depth: this.delegationDepth + 1,
			signal,
			executionContext: this.executionIdentity,
			eventCallback: this.eventCallback,
			config: this.config,
			env: this.attachedEnv,
			tools: this.agentTools,
			retainSession: async (session, conversation, harnessScope) => {
				await this.conversationWriter.ensureChildConversation({
					parent: {
						conversationId: this.conversationId,
						harness: this.executionIdentity.harness ?? 'default',
						session: this.name,
					},
					child: {
						kind: 'action',
						conversationId: conversation.conversationId,
						harness: harnessScope,
						session,
						affinityKey: conversation.affinityKey,
						createdAt: conversation.createdAt,
						parentConversationId: this.conversationId,
						actionInvocationId: invocationId,
					},
					ref: {
						conversationId: conversation.conversationId,
						harness: harnessScope,
						session,
						type: 'action',
						invocationId,
					},
				});
			},
		});
		this.activeActionHarnesses.add(harness);
		return harness;
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
			return this.wrapModelTool(tool, 'custom', (toolCallId, params, signal) => {
				if (preparedToolAdapter) {
					return {
						args: params,
						run: async () => ({
							content: [
								{
									type: 'text' as const,
									text: await preparedToolAdapter.execute(
										params as Record<string, unknown>,
										signal,
									),
								},
							],
							details: { customTool: toolDef.name },
						}),
						result: toolResultText,
					};
				}
				const toolLogger = this.createToolLogger(toolDef.name, toolCallId);
				const parsed = parseToolInput(toolDef, params, signal, {
					log: toolLogger,
					toolCallId,
					...(toolDef.durable
						? { step: this.createToolStep(toolDef.name, toolCallId, toolLogger) }
						: {}),
				});
				return {
					args: parsed.data,
					run: async () => {
						// The harness materializes at run time (a refused/aborted call
						// never creates one) and closes when the run settles. The
						// invocation id is per execution ATTEMPT (a recovery re-run of
						// the same toolCallId gets a fresh scope, so its child sessions
						// never collide with a prior attempt's retained conversations).
						const invocationId = toolDef.harness ? generateInvocationId() : undefined;
						const harness = invocationId
							? this.createInvocationHarness(invocationId, signal)
							: undefined;
						try {
							const context = harness
								? ({ ...parsed.context, harness } as unknown as typeof parsed.context)
								: parsed.context;
							const output = validateToolOutput(toolDef, await toolDef.run(context));
							return {
								content: [
									{
										type: 'text' as const,
										text: output === undefined ? 'null' : JSON.stringify(output),
									},
								],
								details: {
									customTool: toolDef.name,
									output,
									...(invocationId ? { invocationId } : {}),
								},
							};
						} finally {
							if (harness) {
								this.activeActionHarnesses.delete(harness);
								await harness.close();
							}
						}
					},
					result: (value) => (value.details as { output?: unknown }).output,
				};
			});
		});
	}

	private assembleModelTools(
		baseGroups: ModelToolGroup[],
		customDefinitions: ToolDefinition[],
		extraTools: AgentTool<any>[],
	): AgentTool<any>[] {
		const groups: ModelToolGroup[] = [
			...baseGroups,
			{ source: 'custom' as const, tools: this.createCustomTools(customDefinitions) },
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
			group.source === 'custom'
				? group.tools
				: group.tools.map((tool) =>
						group.source === 'result'
							? this.wrapModelTool(tool, group.source, (_toolCallId, params, signal) => {
									if (signal?.aborted) throw abortErrorFor(signal);
									const prepared = prepareResultTool(tool, params);
									// createResultTools registers a preparer for every tool it
									// returns, and 'result'-source tools come only from it.
									if (!prepared) throw new Error('[flue] Result tool has no registered preparer.');
									return prepared;
								})
							: this.wrapModelTool(tool, group.source),
					),
		);
	}

	/** Build built-in tools from the sandbox adapter or the framework defaults. */
	private createBuiltinToolGroups(
		env: SessionEnv | undefined,
		model?: string,
		thinkingLevel?: ThinkingLevel,
		activePackagedSkills?: Record<string, PackagedSkillDirectory>,
	): ModelToolGroup[] {
		const runTask = (params: TaskToolParams, signal?: AbortSignal, toolCallId?: string) =>
			this.runTaskForTool(params, model, thinkingLevel, signal, toolCallId);
		const packagedSkills = {
			...getRegisteredPackagedSkills(this.liveSkills),
			...activePackagedSkills,
		};
		// Skill activation resolves against the LIVE skill set (dynamic skills
		// included); the tool's schema is a stable string so a skill flip never
		// rewrites the tool spec. Presence still keys on having any skill at
		// all — the first dynamic skill brings the tool with it.
		const activateSkillTool =
			Object.keys(this.liveSkills).length > 0
				? createActivateSkillTool((name) => this.activateSkillForTool(name))
				: undefined;
		const packagedRead = Object.values(packagedSkills).some((skill) =>
			Object.keys(skill.files).some((path) => path !== 'SKILL.md'),
		)
			? createPackagedSkillReadTool(packagedSkills)
			: undefined;
		// The task tool is ALWAYS in the set and its spec is fully static —
		// both presence flips and description edits would rewrite the
		// serialized tools block and bust the provider's prompt cache.
		// Delegation is still a declared capability: `agent` is
		// schema-required and the roster lives in the system prompt's
		// "Available Agents" section, so with an empty roster the tool is
		// inert (every name fails resolution) and `GeneralSubagent` is the
		// opt-in for agents that only want a blank fresh-context delegate.
		const frameworkTools = () => [
			createTaskTool(runTask),
			...(activateSkillTool ? [activateSkillTool] : []),
			...(packagedRead ? [packagedRead] : []),
		];

		// No sandbox, no environment-backed tools: the built-in shell/fs set
		// literally isn't added. Framework tools (task, skill activation,
		// packaged-skill reads) are environment-independent and stay.
		if (!env) {
			return [{ source: 'framework', tools: frameworkTools() }];
		}

		// Tool factories (standard and adapter alike) get the env with
		// packaged-skill routing layered onto readFile: any tool that reads
		// through the env resolves /.flue/packaged-skills/ paths, no
		// tool-level special-casing.
		const toolEnv = overlayPackagedSkills(env, packagedSkills);

		if (this.toolFactory) {
			return [
				{
					source: 'adapter',
					tools: this.toolFactory(toolEnv, { subagents: this.liveSubagents }),
				},
				{ source: 'framework', tools: frameworkTools() },
			];
		}

		const builtinTools = [
			createReadTool(toolEnv),
			createWriteTool(toolEnv),
			createEditTool(toolEnv),
			createBashTool(toolEnv),
			createGrepTool(toolEnv),
			createGlobTool(toolEnv),
		];
		return [
			{ source: 'builtin', tools: builtinTools },
			{ source: 'framework', tools: frameworkTools() },
		];
	}

	private async withCallOverrides<T>(
		options: CallOverrides,
		fn: (ctx: { resolvedModel: Model<any> }) => Promise<T>,
	): Promise<T> {
		const previousTools = this.agentLoop.state.tools;
		const previousModel = this.agentLoop.state.model;
		const previousThinkingLevel = this.agentLoop.state.thinkingLevel;

		const resolvedModel = this.resolveModelForCall(options.model);
		this.agentLoop.state.model = resolvedModel;
		this.agentLoop.state.thinkingLevel = this.resolveThinkingLevelForCall(options.thinkingLevel);
		const builtinToolGroups = this.createBuiltinToolGroups(
			this.attachedEnv,
			options.model,
			options.thinkingLevel,
			options.activePackagedSkills,
		);
		this.agentLoop.state.tools = this.assembleModelTools(
			builtinToolGroups,
			[...this.agentTools, ...options.tools],
			options.extraTools ?? [],
		);
		this.activeCallOverrides = options;
		try {
			return await fn({ resolvedModel });
		} finally {
			this.activeCallOverrides = undefined;
			// A re-render inside the overridden window makes the pre-call tool
			// snapshot stale — rebuild from the current render instead.
			this.agentLoop.state.tools = this.rerender
				? this.assembleModelTools(
						this.createBuiltinToolGroups(this.attachedEnv),
						this.agentTools,
						[],
					)
				: previousTools;
			this.agentLoop.state.model = previousModel;
			this.agentLoop.state.thinkingLevel = previousThinkingLevel;
		}
	}

	// ─── Tasks ────────────────────────────────────────────────────────────────

	private resolveSubagent(name: string, delivery?: DeliveredMessage): ResolvedSubagent {
		// The LIVE set: a dynamically declared subagent is delegable the same
		// turn its `resources` signal announced it, even while the task tool's
		// frozen roster description predates it.
		const subagents = this.liveSubagents;
		const subagent = subagents[name];
		if (!subagent) {
			throw new SubagentNotDeclaredError({ subagent: name, available: Object.keys(subagents) });
		}
		// Capability-backed delegates render here — at delegation time, fresh
		// per task (resume included), outside any parent render — into the
		// self-contained shape the task machinery consumes. The parent's task
		// prompt rides in as the delegate's delivered message.
		return resolveSubagentDefinition(subagent, delivery);
	}

	private async runTaskForTool(
		params: TaskToolParams,
		inheritedModel: string | undefined,
		inheritedThinkingLevel: ThinkingLevel | undefined,
		signal?: AbortSignal,
		toolCallId?: string,
	): Promise<AgentToolResult<TaskToolResultDetails>> {
		// The tool path always names a delegate: a blank `agent` fails the same
		// way an unknown one does, before any child session exists. Agent-less
		// blank children are reserved for programmatic `session.task()` calls,
		// which never enter through this path.
		if (!params.agent) {
			throw new SubagentNotDeclaredError({
				subagent: params.agent,
				available: Object.keys(this.liveSubagents),
			});
		}
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

		const taskId = generateTaskId();
		const taskAgent = options?.agent
			? this.resolveSubagent(options.agent, taskDeliveryMessage(text, options?.images))
			: undefined;
		let child: Session | undefined;
		let abortListener: (() => void) | undefined;

		const taskStartMs = Date.now();

		try {
			child = await this.createTaskSession({
				parentSession: this.name,
				parentConversationId: this.conversationId,
				taskId,
				parentEnv: this.attachedEnv,
				cwd: options?.cwd,
				agent: taskAgent,
				depth: this.delegationDepth + 1,
				// Present only on the model-invoked `task` tool path; a programmatic
				// `session.task()` has no parent tool call (canonicalToolRequestMessageId
				// is set only while the assistant's tool batch is executing).
				...(options?.toolCallId ? { parentToolCallId: options.toolCallId } : {}),
				...(options?.toolCallId && this.canonicalToolRequestMessageId
					? { parentAssistantEntryId: this.canonicalToolRequestMessageId }
					: {}),
			});
			this.activeTasks.add(child);
			this.emit(
				{
					type: 'task_start',
					taskId,
					prompt: text,
					agent: taskAgent?.name,
					cwd: options?.cwd,
					parentSession: this.name,
					session: child.name,
					conversationId: child.conversationId,
				},
				{
					agentInput: {
						text: buildPromptText(text, options?.result),
						...(options?.images?.length
							? { images: options.images.map((image) => ({ mimeType: image.mimeType })) }
							: {}),
					},
					...(options?.toolCallId ? { toolCallId: options.toolCallId } : {}),
				},
			);

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
			this.emit(
				{
					type: 'task',
					taskId,
					agent: taskAgent?.name,
					isError: false,
					result: taskResult.text,
					durationMs: durationSince(taskStartMs),
					parentSession: this.name,
					session: child.name,
					conversationId: child.conversationId,
				},
				{ agentOutput: child.agentInvocationOutput(output) },
			);
			return taskResult;
		} catch (error) {
			this.emit(
				{
					type: 'task',
					taskId,
					agent: taskAgent?.name,
					isError: true,
					result: getErrorMessage(error),
					durationMs: durationSince(taskStartMs),
					parentSession: this.name,
					...(child ? { session: child.name, conversationId: child.conversationId } : {}),
				},
				{ errorInfo: classifyError(error) },
			);
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
			const onAbort = () => this.abort(operationSignal?.reason);
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
				this.emit(
					{
						type: 'operation',
						operationId,
						operationKind: operation,
						durationMs: durationSince(startedAt),
						isError: false,
						result,
						usage: usageFromResult(result),
					},
					operation === 'prompt' || operation === 'skill'
						? { agentInput: this.activeAgentInput, agentOutput: this.agentInvocationOutput(result) }
						: undefined,
				);
				return result;
			} catch (error) {
				// Normalize post-abort fallout to a single AbortError for callers.
				const surfaced = operationSignal?.aborted ? abortErrorFor(operationSignal) : error;
				this.emit(
					{
						type: 'operation',
						operationId,
						operationKind: operation,
						durationMs: durationSince(startedAt),
						isError: true,
						error: serializeEventError(surfaced),
					},
					operation === 'prompt' || operation === 'skill'
						? { agentInput: this.activeAgentInput, errorInfo: classifyError(surfaced) }
						: { errorInfo: classifyError(surfaced) },
				);
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

	/** Resolve attachment ids visible in the live context to their images. */
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
			images.push({
				type: 'image',
				data: encodeBase64(stored.bytes),
				mimeType: attachment.mimeType,
			});
		}
		return images;
	}

	private visibleCanonicalAttachments(
		conversation: ReducedConversationState,
	): Map<string, import('./conversation-records.ts').AttachmentRef> {
		const available = new Map<string, import('./conversation-records.ts').AttachmentRef>();
		for (const contextEntry of buildConversationContextEntries(conversation, {
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

	/**
	 * Persist a tool result's image blocks as canonical attachments
	 * (`att_<messageId>_<index>`) and return the record-shaped content with
	 * each image replaced by its attachment ref.
	 */
	private async persistToolResultContent(
		result: AgentToolResult<any>,
		messageId: string,
	): Promise<CanonicalToolResultContent[]> {
		const refs = await this.persistCanonicalAttachments(
			result.content.flatMap((content, index) =>
				content.type === 'image'
					? [{ id: `att_${messageId}_${index}`, mimeType: content.mimeType, data: content.data }]
					: [],
			),
		);
		let imageIndex = 0;
		return result.content.map((content) => {
			if (content.type === 'text') return { type: 'text' as const, text: content.text };
			const attachment = refs[imageIndex++];
			if (!attachment) throw new Error('[flue] Canonical tool outcome attachment is missing.');
			return { type: 'attachment' as const, attachment };
		});
	}

	/** Append a `session.shell()` call as an LLM-shaped bash tool exchange. */
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
		const outcomeContent = await this.persistToolResultContent(toolResult, resultMessageId);
		await this.appendCanonical([
			{
				...this.canonicalEnvelope('user_message'),
				type: 'user_message',
				messageId: userMessageId,
				parentId,
				content: [
					{
						type: 'text',
						text: `Run this shell command:\n\n\`\`\`bash\n${String(args.command)}\n\`\`\``,
					},
				],
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
				blockId: generateBlockId(),
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
				...this.canonicalEnvelope(
					'tool_outcome',
					`record_tool_outcome_${encodeCanonicalId(assistantMessageId)}_${encodeCanonicalId(toolCallId)}`,
				),
				type: 'tool_outcome',
				assistantMessageId,
				toolCallId,
				toolName: 'bash',
				isError,
				content: outcomeContent,
			},
			{
				...this.canonicalEnvelope('tool_results_committed'),
				type: 'tool_results_committed',
				assistantMessageId,
				parentId: assistantMessageId,
				outcomeIds: [
					`record_tool_outcome_${encodeCanonicalId(assistantMessageId)}_${encodeCanonicalId(toolCallId)}`,
				],
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
		const messages = buildConversationContext(conversation, {
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
		/**
		 * Re-drive for a turn whose input never became canonical (the
		 * structured-result follow-up reminder rides only in the live loop).
		 * Recovery rebuilds the context from canonical records, so after such a
		 * turn fails the rebuilt context ends with the previous completed
		 * assistant and `continue()` would throw.
		 */
		restart?: () => Promise<void>;
	}): Promise<void> {
		let start = options.start;
		let assistant = options.resume?.assistant;
		let turnCompleted = false;
		let overflowRecoveryAttempted = false;

		// Evaluated lazily at start() time: overflow recovery appends a
		// compaction record after the rebuild, so the context's final message
		// is only settled once recovery work is done.
		const continueRebuilt = () => {
			if (options.restart && this.agentLoop.state.messages.at(-1)?.role === 'assistant') {
				return options.restart();
			}
			return this.agentLoop.continue();
		};

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
				isAssistantContextOverflow(assistant, this.agentLoop.state.model.contextWindow ?? 0);
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
				start = continueRebuilt;
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
				start = continueRebuilt;
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
				? this.resolveModelForCall(compactionConfig.model)
				: sessionModel;

			const canonicalConversation = await this.requireConversation();
			const resolvedAttachments =
				await this.resolveCanonicalContextAttachments(canonicalConversation);
			const contextEntries = buildConversationContextEntries(canonicalConversation, {
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
					end: (purpose, handle, response, error): void => {
						const request = this.modelRequests.get(handle.turnId);
						if (!request)
							throw new Error(
								`[flue] Missing model request telemetry for turn "${handle.turnId}".`,
							);
						this.emitTurn(handle.turnId, purpose, response, request.info, error);
						this.modelRequests.delete(handle.turnId);
					},
				},
			);

			if (this.compactionAbortController.signal.aborted) {
				const abortError = abortErrorFor(this.compactionAbortController.signal);
				this.emit(
					{
						type: 'compaction',
						messagesBefore,
						messagesAfter: this.agentLoop.state.messages.length,
						durationMs: durationSince(compactionStartMs),
						isError: true,
						error: serializeEventError(abortError),
					},
					{ errorInfo: classifyError(abortError) },
				);
				terminalPending = false;
				if (reason === 'manual') throw abortError;
				return false;
			}

			{
				const conversation = await this.requireConversation();
				const sourceLeafId = conversation.activeLeafId;
				if (!sourceLeafId) throw new Error('[flue] Canonical compaction has no source leaf.');
				// rebaselineResources owns this record's append so the new baseline
				// resource_snapshot rides the same batch — a crash between separate
				// appends would durably compact the context while stranding the
				// frozen baseline at its pre-compaction state.
				await this.rebaselineResources({
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
				});
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
				this.emit(
					{
						type: 'compaction',
						messagesBefore,
						messagesAfter: this.agentLoop.state.messages.length,
						durationMs: durationSince(compactionStartMs),
						isError: true,
						error: serializeEventError(error),
					},
					{ errorInfo: classifyError(error) },
				);
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
		return (
			aggregateConversationUsageSince(await this.requireConversation(), beforeLeafId) ??
			emptyUsage()
		);
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
		return submissionEntryId(input.kind, input.submissionId);
	}

	private inspectCanonicalState(
		state: ReturnType<typeof classifyConversationSubmission>,
	): AgentSubmissionInspection {
		switch (state.kind) {
			case 'absent':
				return 'absent';
			case 'completed':
				return 'completed';
			default:
				// Everything else is one bucket: reconciliation replaces the
				// attempt and hands the submission back to resume processing,
				// which converges the stream and classifies the fine-grained
				// state itself. Repair is never conditional on this mapping.
				return 'interrupted';
		}
	}

	/**
	 * Build the canonical `user_message` or `signal` record for a delivered
	 * message and drive the conversation from it — the single input path for
	 * both a direct HTTP prompt and a `dispatch()` call. Which kind of
	 * canonical record gets written depends only on `input.message.kind`, not
	 * on whether the submission is `input.kind === 'direct'` or `'dispatch'`
	 * (that distinction remains relevant only for record-id namespacing).
	 */
	private async runPersistedSubmissionInput(
		input: AgentSubmissionInput,
		signal: AbortSignal,
		options?: ProcessAgentSubmissionOptions,
	): Promise<void> {
		const message = input.message;
		this.activeAgentInput =
			message.kind === 'user'
				? {
						text: message.body,
						...(message.attachments?.length
							? {
									images: message.attachments.map((attachment) => ({
										mimeType: attachment.mimeType,
									})),
								}
							: {}),
					}
				: {
						text: renderSignalMessage({
							role: 'signal',
							type: message.type,
							tagName: message.tagName,
							content: message.body,
							attributes: message.attributes,
							timestamp: Date.now(),
						}),
					};
		return this.runPersistedContextInput({
			inputEntryId: submissionEntryId(input.kind, input.submissionId),
			createCanonicalInput: (parentId) => this.buildSubmissionInputRecord(input, parentId),
			errorLabel: `${input.kind}(${input.submissionId})`,
			onInputApplied: options?.onInputApplied,
			submissionAttempt: options?.submissionAttempt,
			startedAt: options?.startedAt,
			timeoutAt: options?.timeoutAt,
			joinSource: options?.joinSource,
			signal,
		});
	}

	/**
	 * The canonical `user_message`/`signal` record for a submission's
	 * delivered message. Shared by the submission's own input path and the
	 * turn-boundary join path. A joined delivery's record carries the
	 * DELIVERY's `submissionId` (not the active host's) — that is what keys
	 * its `agent_start_run` adoption marker and distinguishes joined input
	 * from the host's in the stream; the store authorizes the mismatch
	 * against the delivery's durable `joining`/`joined` claim.
	 */
	private async buildSubmissionInputRecord(
		input: AgentSubmissionInput,
		parentId: string | null,
		options?: { asJoinedDelivery?: boolean },
	): Promise<ConversationRecord> {
		const message = input.message;
		const owner = options?.asJoinedDelivery ? { submissionId: input.submissionId } : {};
		const messageId = submissionEntryId(input.kind, input.submissionId);
		const recordId = `record_${input.kind}_input_${input.submissionId}`;
		if (message.kind === 'user') {
			const refs = await this.persistCanonicalAttachments(
				(message.attachments ?? []).map((attachment, index) => ({
					id: `att_${input.kind}_${input.submissionId}_${index}`,
					mimeType: attachment.mimeType,
					data: attachment.data,
					...(attachment.filename ? { filename: attachment.filename } : {}),
				})),
			);
			return {
				...this.canonicalEnvelope('user_message', recordId),
				...owner,
				type: 'user_message',
				messageId,
				parentId,
				content: [
					{ type: 'text', text: message.body },
					...refs.map((attachment) => ({ type: 'attachment' as const, attachment })),
				],
			};
		}
		return {
			...this.canonicalEnvelope('signal', recordId),
			...owner,
			type: 'signal',
			messageId,
			parentId,
			signalType: message.type,
			...(message.tagName ? { tagName: message.tagName } : {}),
			content: message.body,
			...(message.attributes ? { attributes: message.attributes } : {}),
		};
	}

	/**
	 * Repair phase of the resume seam: classify the persisted state after the
	 * input and repair the conversation TAIL — upgrade a continuable aborted
	 * partial, repair a trailing (partial or unresolved) tool batch — BEFORE
	 * anything else appends. Repair requires the interrupted toolUse assistant
	 * (or aborted partial) to still be the conversation leaf, so at every
	 * ownership seam the order is converge → repair → only then append/steer/
	 * drive; structural convergence (`materializeGhostStream`) is the only
	 * append allowed earlier, because classification here reads committed
	 * entries only. Idempotent: a repaired tail reclassifies to a non-repair
	 * state and every branch below no-ops.
	 */
	private async repairResumableTail(inputEntryId: string, signal: AbortSignal): Promise<void> {
		const state = classifyConversationSubmission(await this.requireConversation(), inputEntryId, {
			contextWindow: this.agentLoop.state.model.contextWindow ?? 0,
		});
		// Semantic recovery for a materialized aborted partial: when it
		// carries content worth continuing from, append the recovery signal
		// pair so the model continues the partial instead of replaying the
		// turn from scratch. No-op when the partial is empty (the #477
		// zero-block ghost) or already upgraded.
		if (state.kind === 'resume' && state.mode === 'aborted_partial') {
			await this.upgradeAbortedPartialToContinuation();
		}
		// A turn interrupted mid-tool-batch must not replay: repair the batch
		// (recorded results preserved, unresolved calls marked interrupted;
		// `tool_use_unresolved` — no outcome recorded at all — is repaired
		// identically) so the resumed turn continues from the repaired results
		// instead of re-executing tool calls that already completed.
		if (
			(state.kind === 'resume' && state.mode === 'tool_results_partial') ||
			state.kind === 'tool_use_unresolved'
		) {
			await this.repairTrailingPartialToolBatch(inputEntryId, signal, {
				// tool_use_unresolved with ZERO toolCall blocks is a degenerate
				// provider shape with nothing to repair — the only tolerated
				// finder miss.
				batchRequired: state.kind === 'resume' || hasToolCallBlocks(state.assistant),
			});
		}
	}

	/**
	 * Resume the conversation from a persisted input entry to completion:
	 * repair the conversation tail, classify the canonical state after the
	 * input, then drive the model turn(s). Conversation-level and
	 * submission-agnostic — used both by the top-level submission resume
	 * (`runPersistedContextInput`) and by an in-process subagent reattach
	 * (`resumeReattachedChild`). Both callers converge the stream structurally
	 * (`materializeGhostStream`) before reaching here, so classification only
	 * ever sees complete units.
	 */
	private async resumeConversationToCompletion(options: {
		inputEntryId: string;
		errorLabel: string;
		signal: AbortSignal;
	}): Promise<void> {
		// The subagent-reattach caller reaches repair through this call; on the
		// main seam (`runPersistedContextInput`) the repair phase already ran
		// pre-append and this re-run is an idempotent no-op — a repaired batch
		// reclassifies `tool_results`, an upgraded partial reclassifies
		// `stream_continuation`.
		await this.repairResumableTail(options.inputEntryId, options.signal);
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
				// Only the degenerate zero-toolCall provider shape reaches the
				// drive with this classification — a repairable batch was
				// committed by the repair phase above and reclassifies
				// `tool_results`. Nothing was recorded and a replayed turn
				// re-executes nothing, so let the model proceed.
				await this.runModelTurnWithRecovery({
					start: () => this.agentLoop.continue(),
					signal: options.signal,
					resume: { assistant: state.assistant, errorLabel: options.errorLabel },
				});
				this.throwIfError(options.errorLabel);
				break;
			}
			default: {
				// Exhaustiveness backstop: a new classification state must be
				// handled here explicitly. A silent fall-through would settle
				// the submission 'completed' having done nothing — the exact
				// hole the deleted interrupted_partial state fell through.
				const unhandled: never = state;
				throw new Error(`[flue] Unhandled submission classification: ${JSON.stringify(unhandled)}`);
			}
		}
	}

	/**
	 * Resume a reattached subagent (recovery only) to completion, returning its
	 * final assistant text for the parent's `task` outcome. Runs in the child's
	 * own operation so child-internal events stay on the child context; inherits
	 * the parent's deadline; converges any interrupted partial stream (D-A,
	 * identical to top-level recovery) before classifying and continuing from the
	 * child's durable input. Idempotent: an already-completed child resumes as a
	 * no-op and returns its recorded text.
	 */
	private resumeReattachedChild(options: {
		timeoutAt?: number;
		signal?: AbortSignal;
	}): CallHandle<string> {
		return createCallHandle(options.signal, (signal) =>
			this.runOperation('prompt', signal, async () => {
				const previousTimeout = this.activeTimeoutAt;
				this.activeTimeoutAt = options.timeoutAt;
				try {
					return await this.withCallOverrides(
						{
							tools: [],
							// `model: undefined` resolves to the child's `config.model`,
							// which equals the model the child ran on: a profile subagent
							// uses its own configured model, and an agent-less task inherits
							// the parent's `config.model` (durable submissions carry no
							// per-call model override, so the parent always runs on
							// `config.model`). If per-call model overrides are ever added to
							// submissions, restore the model from the child's durable
							// `assistant_message_started.modelInfo` instead.
							model: undefined,
							thinkingLevel: undefined,
						},
						async () => {
							// Child records carry no submission identity, and child
							// conversations never receive settle records, so reattach
							// converges its own ghost (scoped to unowned state) before
							// the shared resume path classifies and, when the partial
							// has content, upgrades it to a stream continuation.
							await this.materializeGhostStream({ submissionId: undefined });
							const conversation = await this.requireConversation();
							// A task conversation's first user message is its single durable
							// input (the original task prompt); resume continues from there.
							const inputEntry = getActiveConversationPath(conversation).find(
								(entry) => entry.type === 'message' && entry.message.role === 'user',
							);
							if (!inputEntry) {
								throw new Error('[flue] Resumed task conversation has no durable input.');
							}
							await this.resumeConversationToCompletion({
								inputEntryId: inputEntry.id,
								errorLabel: 'task',
								signal,
							});
							return this.getAssistantText();
						},
					);
				} finally {
					this.activeTimeoutAt = previousTimeout;
				}
			}),
		);
	}

	private resolveSubmissionDurability(
		startedAt?: number,
		timeoutAt?: number,
	): SubmissionDurability {
		return {
			maxAttempts: this.config.durability?.maxAttempts ?? DURABILITY_DEFAULT_MAX_ATTEMPTS,
			timeoutAt:
				timeoutAt ??
				(startedAt ?? Date.now()) +
					(this.config.durability?.timeoutMs ?? DURABILITY_DEFAULT_TIMEOUT_MS),
		};
	}

	private async runPersistedContextInput(options: {
		inputEntryId: string;
		createCanonicalInput: (
			parentId: string | null,
		) => Promise<ConversationRecord> | ConversationRecord;
		startedAt?: number;
		timeoutAt?: number;
		errorLabel: string;
		onInputApplied?: (durability: SubmissionDurability) => Promise<void> | void;
		submissionAttempt?: import('./agent-execution-store.ts').SubmissionAttemptRef;
		joinSource?: SubmissionJoinSource;
		signal: AbortSignal;
	}): Promise<void> {
		return this.withCallOverrides(
			{
				tools: [],
				model: undefined,
				thinkingLevel: undefined,
			},
			async () => {
				this.activeSubmissionId = options.submissionAttempt?.submissionId;
				this.activeSubmissionAttemptId = options.submissionAttempt?.attemptId;
				this.activeJoinSource = options.joinSource;
				this.activeJoinSignal = options.signal;
				this.activeInputEntryId = options.inputEntryId;
				const durability = this.resolveSubmissionDurability(options.startedAt, options.timeoutAt);
				this.activeTimeoutAt = durability.timeoutAt;
				try {
					// Structural convergence, before anything else appends: any
					// in-progress assistant persisted in this conversation is dead by
					// construction here (per-session submissions are serialized and
					// this attempt owns the stream), so materialize it as an aborted
					// entry. Unconditional and idempotent — a clean stream is a no-op.
					// Running this at the ownership seam, not behind classification,
					// is what makes a crash shape a non-event instead of an
					// enumerated recovery case (#477).
					await this.materializeGhostStream('any');
					const inputAlreadyPersisted = await this.conversationWriter.hasConversationEntry(
						this.conversationId,
						options.inputEntryId,
					);
					if (!inputAlreadyPersisted) {
						// A genuinely new input: this submission is about to drive the
						// conversation, so a trailing uncommitted tool batch was
						// abandoned by a previous driver — marker-settle it before the
						// new input extends the leaf. Without this, the dangling turn
						// is buried mid-history where the context builder silently
						// drops it. Resume re-entries (input already persisted) must
						// NOT marker-settle: their trailing batch is live work the
						// classify/repair path below recovers precisely (task children
						// resumed, durable tools replayed), and a marker-settle here
						// would pre-empt it.
						await this.settleTrailingToolBatch('any');
						const parentId = await this.conversationWriter.getConversationLeaf(this.conversationId);
						await this.appendCanonical([await options.createCanonicalInput(parentId)]);
					}
					await this.rebuildCanonicalContext();
					await options.onInputApplied?.(durability);
					await this.beginResponseOutput();
					// Repair phase, before anything below appends: repairing a
					// trailing partial batch (or upgrading an aborted partial)
					// requires the interrupted entry to still be the conversation
					// leaf — a signal or joined entry appended first buries the
					// batch mid-history, where recorded tool outcomes are dropped
					// from model context and the replayed turn re-executes them.
					await this.repairResumableTail(options.inputEntryId, options.signal);
					// Wake diff: resource flips from a previous response's final
					// batch (no turn boundary followed them) narrate before turn 1
					// against the init render — the model's actual turn-1 view.
					await this.narrateResourceDelta();
					await this.narrateMcpUnavailable();
					await this.runAgentStartHooks(options.signal);
					// Joins interrupted by a crash resolve by record existence (the
					// rebuilt context above already carries every applied one), then
					// the queued prefix coalesces into this response before turn 1 —
					// N messages piled up while idle become one response with one
					// start-hook run per delivery.
					await this.resolveInterruptedJoins(options.signal);
					await this.applyQueuedJoins();
					await this.resumeConversationToCompletion({
						inputEntryId: options.inputEntryId,
						errorLabel: options.errorLabel,
						signal: options.signal,
					});
					await this.runWouldStopPhase({
						errorLabel: options.errorLabel,
						signal: options.signal,
					});
					await this.flushResponseOutput();
				} finally {
					// A failed attempt drops its unflushed signal appends (they never
					// happened, like the state writes and tool batch they rode with)
					// and clears the steering queue so nothing leaks into a re-attempt
					// whose context is rebuilt from canonical records.
					this.pendingSignalAppends = [];
					this.agentLoop.clearSteeringQueue();
					// Detach the data-write queue tail too: its closures no-op once
					// the attempt id clears below, and a rejected tail must not leak
					// into a replacement attempt on this cached session.
					this.outputWriteQueue = Promise.resolve();
					this.activeSubmissionId = undefined;
					this.activeSubmissionAttemptId = undefined;
					this.activeJoinSource = undefined;
					this.activeJoinSignal = undefined;
					this.activeInputEntryId = undefined;
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
				await this.appendCanonical([
					{
						...this.canonicalEnvelope('user_message'),
						type: 'user_message',
						messageId,
						parentId: beforeLeafId,
						content: [
							{ type: 'text', text: args.promptText },
							...refs.map((attachment) => ({ type: 'attachment' as const, attachment })),
						],
					},
				]);
				await this.rebuildCanonicalContext();
				const projectedPrompt = this.agentLoop.state.messages.pop();
				if (projectedPrompt?.role !== 'user') {
					throw new Error('[flue] Canonical prompt projection is missing its user message.');
				}
				const projectedContent = Array.isArray(projectedPrompt.content)
					? projectedPrompt.content
					: [{ type: 'text' as const, text: projectedPrompt.content }];
				const projectedText = projectedContent
					.filter(
						(block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text',
					)
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
				start: () =>
					this.agentLoop.prompt(
						attempt === 0 ? initialPrompt : buildResultFollowUpPrompt(),
						attempt === 0 ? initialImages : undefined,
					),
				// The reminder is never persisted (the session only persists
				// assistant-role messages), so a context rebuild during recovery
				// drops it; the initial prompt is canonical and continues fine.
				...(attempt > 0
					? { restart: () => this.agentLoop.prompt(buildResultFollowUpPrompt()) }
					: {}),
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
	return `entry_${kind}_${encodeCanonicalId(id)}`;
}

/**
 * The parent's task prompt as the delegate's delivered message — the same
 * `kind: 'user'` shape the child conversation records as its input, so a
 * delegate's `useDelivery()` mirrors a root agent's exactly.
 */
function taskDeliveryMessage(text: string, images?: PromptImage[]): DeliveredMessage {
	return { kind: 'user', body: text, ...(images?.length ? { attachments: images } : {}) };
}

function hasToolCallBlocks(message: AssistantMessage): boolean {
	return message.content.some((block) => block.type === 'toolCall');
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
