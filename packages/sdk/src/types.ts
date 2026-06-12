export type RunStatus = 'active' | 'completed' | 'errored';

/** Persisted workflow-run record. Runs are workflow-only; `workflowName` identifies the owning workflow. */
export interface RunRecord {
	runId: string;
	workflowName: string;
	status: RunStatus;
	startedAt: string;
	endedAt?: string;
	isError?: boolean;
	durationMs?: number;
	payload?: unknown;
	result?: unknown;
	error?: unknown;
}

/**
 * Sentinel string that replaces raw image `data` in event payloads. Events
 * never carry raw image bytes; image content blocks keep their `mimeType`
 * but have `data` replaced with this value.
 */
export const IMAGE_DATA_OMITTED = '[image data omitted from event]';

/** Aggregated token and cost usage for model work. */
export interface PromptUsage {
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

/**
 * Terminal result of one direct-agent prompt. Mirrors the runtime
 * `PromptResponse` shape served by `POST /agents/:name/:id?wait=result`.
 */
export interface AgentPromptResponse {
	/** Assistant text returned by the prompt. */
	text: string;
	/** Aggregated token and cost usage for model work performed by the prompt. */
	usage: PromptUsage;
	/** Model selected for the prompt's primary turn. */
	model: { provider: string; id: string };
}

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

/** Normalized tool call emitted with model-turn events. */
export type LlmToolCall = {
	type: 'toolCall';
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	thoughtSignature?: string;
};

/** Normalized assistant message emitted with model-turn events. */
export type LlmAssistantMessage = {
	role: 'assistant';
	content: (LlmTextContent | LlmThinkingContent | LlmToolCall)[];
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
			workflowName: string;
			startedAt: string;
			payload: unknown;
	  }
	| {
			type: 'run_resume';
			runId: string;
			workflowName: string;
			startedAt: string;
	  }
	| { type: 'agent_start' }
	| { type: 'agent_end'; messages: unknown[] }
	| { type: 'turn_start'; turnId: string; purpose: LlmTurnPurpose }
	| {
			type: 'turn_messages';
			turnId: string;
			purpose: LlmTurnPurpose;
			message: unknown;
			toolResults: unknown[];
	  }
	| { type: 'message_start'; message: unknown }
	| { type: 'message_update'; message: unknown }
	| { type: 'message_end'; message: unknown }
	| { type: 'text_delta'; text: string }
	| { type: 'thinking_start' }
	| { type: 'thinking_delta'; delta: string }
	| { type: 'thinking_end'; content: string }
	| { type: 'tool_start'; toolName: string; toolCallId: string; args?: unknown }
	| {
			type: 'tool';
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
			isError: boolean;
			error?: unknown;
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
	/** Durable event-format version. Readers branch on this when the format changes. */
	v: 1;
	eventIndex: number;
	timestamp: string;
	runId?: string;
	instanceId?: string;
	dispatchId?: string;
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


