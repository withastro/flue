export type RunStatus = 'active' | 'completed' | 'errored';

/** Workflow identity recorded for a run. Direct agent interactions are not runs. */
export type RunOwner = { kind: 'workflow'; workflowName: string; instanceId: string };

/** Persisted workflow-run record. */
export interface RunRecord {
	runId: string;
	owner: RunOwner;
	status: RunStatus;
	startedAt: string;
	endedAt?: string;
	isError?: boolean;
	durationMs?: number;
	payload?: unknown;
	result?: unknown;
	error?: unknown;
}

/** Workflow-run summary returned by admin listing routes. */
export interface RunPointer {
	runId: string;
	owner: RunOwner;
	status: RunStatus;
	startedAt: string;
	endedAt?: string;
	durationMs?: number;
	isError?: boolean;
}

/** Agent discovery metadata returned by the read-only admin route. */
export interface AgentManifestEntry {
	name: string;
	transports: { http?: true };
	created: boolean;
}

/** Payload for a direct interaction with a persistent agent instance. */
export interface DirectAgentPayload {
	message: string;
}

/** Cursor-paginated list response. */
export interface ListResponse<T> {
	items: T[];
	nextCursor?: string;
}

interface PromptUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

type OperationKind = 'prompt' | 'skill' | 'task' | 'shell' | 'compact';

/** Normalized text content emitted with model-turn events. */
export type LlmTextContent = {
	type: 'text';
	text: string;
	textSignature?: string;
};

/** Normalized reasoning content emitted with model-turn events. */
export type LlmThinkingContent = {
	type: 'thinking';
	thinking: string;
	thinkingSignature?: string;
	redacted?: boolean;
};

/** Normalized image content emitted with model-turn events. */
export type LlmImageContent = {
	type: 'image';
	data: string;
	mimeType: string;
};

/** Normalized tool call emitted with model-turn events. */
export type LlmToolCall = {
	type: 'toolCall';
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	thoughtSignature?: string;
};

/** Normalized user message emitted with model-turn events. */
export type LlmUserMessage = {
	role: 'user';
	content: string | (LlmTextContent | LlmImageContent)[];
};

/** Normalized assistant message emitted with model-turn events. */
export type LlmAssistantMessage = {
	role: 'assistant';
	content: (LlmTextContent | LlmThinkingContent | LlmToolCall)[];
};

/** Normalized tool-result message emitted with model-turn events. */
export type LlmToolResultMessage = {
	role: 'toolResult';
	toolCallId: string;
	toolName: string;
	content: (LlmTextContent | LlmImageContent)[];
	isError: boolean;
};

/** Normalized model message emitted with model-turn events. */
export type LlmMessage = LlmUserMessage | LlmAssistantMessage | LlmToolResultMessage;

/** Normalized tool definition emitted with model-turn events. */
export type LlmTool = {
	name: string;
	description: string;
	parameters: unknown;
};

/** Purpose of a model turn emitted with model-turn events. */
export type LlmTurnPurpose = 'agent' | 'compaction' | 'compaction_prefix';

/** Structured server error data. */
export interface FluePublicError {
	type: string;
	message: string;
	details: string;
	dev?: string;
	meta?: Record<string, unknown>;
}

/** Observable workflow-run event. */
export type FlueEvent = (
	| {
			type: 'run_start';
			runId: string;
			owner: RunOwner;
			instanceId: string;
			workflowName: string;
			startedAt: string;
			payload: unknown;
	  }
	| {
			type: 'run_resume';
			runId: string;
			owner: RunOwner;
			instanceId: string;
			workflowName: string;
			startedAt: string;
	  }
	| { type: 'agent_start' }
	| { type: 'agent_end'; messages: unknown[] }
	| { type: 'turn_start'; turnId: string; purpose: LlmTurnPurpose }
	| {
			type: 'turn_request';
			turnId: string;
			purpose: LlmTurnPurpose;
			model: string;
			provider: string;
			api: string;
			input: { systemPrompt?: string; messages: LlmMessage[]; tools?: LlmTool[] };
			reasoning?: string;
	  }
	| {
			type: 'turn_end';
			turnId: string;
			purpose: LlmTurnPurpose;
			message: unknown;
			toolResults: unknown[];
	  }
	| { type: 'message_start'; message: unknown }
	| { type: 'message_update'; message: unknown; assistantMessageEvent: unknown }
	| { type: 'message_end'; message: unknown }
	| { type: 'text_delta'; text: string }
	| { type: 'thinking_start' }
	| { type: 'thinking_delta'; delta: string }
	| { type: 'thinking_end'; content: string }
	| { type: 'tool_start'; toolName: string; toolCallId: string; args?: unknown }
	| {
			type: 'tool_call';
			toolName: string;
			toolCallId: string;
			isError: boolean;
			result?: unknown;
			durationMs: number;
	  }
	| {
			type: 'turn';
			turnId: string;
			purpose: LlmTurnPurpose;
			durationMs: number;
			model?: string;
			provider?: string;
			api?: string;
			output?: LlmAssistantMessage;
			usage?: PromptUsage;
			stopReason?: string;
			isError: boolean;
			error?: unknown;
	  }
	| { type: 'task_start'; taskId: string; prompt: string; agent?: string; cwd?: string }
	| {
			type: 'task';
			taskId: string;
			agent?: string;
			isError: boolean;
			result?: unknown;
			durationMs: number;
	  }
	| {
			type: 'compaction_start';
			reason: 'threshold' | 'overflow' | 'manual';
			estimatedTokens: number;
	  }
	| {
			type: 'compaction';
			messagesBefore: number;
			messagesAfter: number;
			durationMs: number;
			usage?: PromptUsage;
	  }
	| { type: 'operation_start'; operationId: string; operationKind: OperationKind }
	| {
			type: 'operation';
			operationId: string;
			operationKind: OperationKind;
			durationMs: number;
			isError: boolean;
			error?: unknown;
			result?: unknown;
			usage?: PromptUsage;
	  }
	| {
			type: 'log';
			level: 'info' | 'warn' | 'error';
			message: string;
			attributes?: Record<string, unknown>;
	  }
	| { type: 'idle' }
	| {
			type: 'run_end';
			runId: string;
			result?: unknown;
			isError: boolean;
			error?: unknown;
			durationMs: number;
	  }
) & {
	runId?: string;
	instanceId?: string;
	dispatchId?: string;
	eventIndex?: number;
	timestamp?: string;
	session?: string;
	parentSession?: string;
	taskId?: string;
	harness?: string;
	operationId?: string;
	turnId?: string;
};

/** Direct-agent event attached to an agent instance rather than a workflow run. */
export type AttachedAgentEvent = Exclude<
	FlueEvent,
	{ type: 'run_start' } | { type: 'run_resume' } | { type: 'run_end' }
> & {
	runId?: never;
	instanceId: string;
};

/** Structured error envelope received while streaming a direct agent interaction. Streams throw the error message rather than yielding this envelope. */
export interface AttachedAgentStreamError {
	type: 'error';
	instanceId: string;
	error: FluePublicError;
}
