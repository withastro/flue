export type RunStatus = 'active' | 'completed' | 'errored';

export type RunOwner = { kind: 'workflow'; workflowName: string; instanceId: string };

export interface RunRecord {
	runId: string;
	owner: RunOwner;
	status: RunStatus;
	startedAt: string;
	endedAt?: string;
	isError?: boolean;
	durationMs?: number;
	result?: unknown;
	error?: unknown;
}

export interface RunPointer {
	runId: string;
	owner: RunOwner;
	status: RunStatus;
	startedAt: string;
	endedAt?: string;
	durationMs?: number;
	isError?: boolean;
}

export interface AgentManifestEntry {
	name: string;
	channels: { http?: true; websocket?: true };
	created: boolean;
}

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

export interface FluePublicError {
	type: string;
	message: string;
	details: string;
	dev?: string;
	meta?: Record<string, unknown>;
}

export type AgentWebSocketClientMessage =
	| {
			version: 1;
			type: 'prompt';
			requestId: string;
			message: string;
			session?: string;
	  }
	| {
			version: 1;
			type: 'ping';
			requestId?: string;
	  };

export interface WorkflowWebSocketClientMessage {
	version: 1;
	type: 'invoke';
	requestId: string;
	payload?: unknown;
}

export type WebSocketErrorMessage = {
	version: 1;
	type: 'error';
	requestId?: string;
	error: FluePublicError;
};

export type AgentWebSocketServerMessage =
	| {
			version: 1;
			type: 'ready';
			target: 'agent';
			name: string;
			instanceId: string;
	  }
	| {
			version: 1;
			type: 'started';
			requestId: string;
	  }
	| {
			version: 1;
			type: 'event';
			requestId: string;
			event: FlueEvent;
	  }
	| {
			version: 1;
			type: 'result';
			requestId: string;
			result: unknown;
	  }
	| WebSocketErrorMessage
	| {
			version: 1;
			type: 'pong';
			requestId?: string;
	  };

export type WorkflowWebSocketServerMessage =
	| {
			version: 1;
			type: 'ready';
			target: 'workflow';
			name: string;
	  }
	| {
			version: 1;
			type: 'started';
			requestId: string;
			runId: string;
	  }
	| {
			version: 1;
			type: 'event';
			requestId: string;
			runId: string;
			event: FlueEvent;
	  }
	| {
			version: 1;
			type: 'result';
			requestId: string;
			runId: string;
			result: unknown;
	  }
	| WebSocketErrorMessage
	| {
			version: 1;
			type: 'error';
			requestId?: string;
			runId: string;
			error: FluePublicError;
	  };

export type WebSocketServerMessage = AgentWebSocketServerMessage | WorkflowWebSocketServerMessage;

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
	| { type: 'agent_start' }
	| { type: 'agent_end'; messages: unknown[] }
	| { type: 'turn_start' }
	| { type: 'turn_end'; message: unknown; toolResults: unknown[] }
	| { type: 'message_start'; message: unknown }
	| { type: 'message_update'; message: unknown; assistantMessageEvent: unknown }
	| { type: 'message_end'; message: unknown }
	| { type: 'tool_execution_start'; toolCallId: string; toolName: string; args: unknown }
	| { type: 'tool_execution_update'; toolCallId: string; toolName: string; args: unknown; partialResult: unknown }
	| { type: 'tool_execution_end'; toolCallId: string; toolName: string; result: unknown; isError: boolean }
	| { type: 'text_delta'; text: string }
	| { type: 'thinking_start' }
	| { type: 'thinking_delta'; delta: string }
	| { type: 'thinking_end'; content: string }
	| { type: 'tool_start'; toolName: string; toolCallId: string; args?: unknown }
	| { type: 'tool_call'; toolName: string; toolCallId: string; isError: boolean; result?: unknown; durationMs: number }
	| { type: 'turn'; durationMs: number; model?: string; usage?: PromptUsage; stopReason?: string; isError: boolean; error?: unknown }
	| { type: 'task_start'; taskId: string; prompt: string; agent?: string; cwd?: string }
	| { type: 'task'; taskId: string; agent?: string; isError: boolean; result?: unknown; durationMs: number }
	| { type: 'compaction_start'; reason: 'threshold' | 'overflow' | 'manual'; estimatedTokens: number }
	| { type: 'compaction'; messagesBefore: number; messagesAfter: number; durationMs: number; usage?: PromptUsage }
	| { type: 'operation_start'; operationId: string; operationKind: OperationKind }
	| { type: 'operation'; operationId: string; operationKind: OperationKind; durationMs: number; isError: boolean; error?: unknown; result?: unknown; usage?: PromptUsage }
	| { type: 'log'; level: 'info' | 'warn' | 'error'; message: string; attributes?: Record<string, unknown> }
	| { type: 'idle' }
	| { type: 'run_end'; runId: string; result?: unknown; isError: boolean; error?: unknown; durationMs: number }
) & {
	runId?: string;
	eventIndex?: number;
	timestamp?: string;
	session?: string;
	parentSession?: string;
	taskId?: string;
	harness?: string;
	operationId?: string;
};
