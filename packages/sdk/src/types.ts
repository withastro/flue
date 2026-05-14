export type RunStatus = 'active' | 'completed' | 'errored';

export interface RunRecord {
	runId: string;
	instanceId: string;
	agentName: string;
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
	agentName: string;
	instanceId: string;
	status: RunStatus;
	startedAt: string;
	endedAt?: string;
	durationMs?: number;
	isError?: boolean;
}

export interface AgentManifestEntry {
	name: string;
	triggers: { webhook?: boolean };
}

export interface InstanceSummary {
	agentName: string;
	instanceId: string;
}

export interface ListResponse<T> {
	items: T[];
	nextCursor?: string;
}

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

export type OperationKind = 'prompt' | 'skill' | 'task' | 'shell';

export type FlueEvent = (
	| {
			type: 'run_start';
			runId: string;
			instanceId: string;
			agentName: string;
			startedAt: string;
			payload: unknown;
		}
	| { type: 'text_delta'; text: string }
	| { type: 'thinking_start' }
	| { type: 'thinking_delta'; delta: string }
	| { type: 'thinking_end'; content: string }
	| { type: 'tool_start'; toolName: string; toolCallId: string; args?: unknown }
	| { type: 'tool_call'; toolName: string; toolCallId: string; isError: boolean; result?: unknown; durationMs: number }
	| { type: 'turn'; durationMs: number; model?: string; usage?: PromptUsage; stopReason?: string; isError: boolean; error?: unknown }
	| { type: 'task_start'; taskId: string; prompt: string; role?: string; cwd?: string }
	| { type: 'task'; taskId: string; isError: boolean; result?: unknown; durationMs: number }
	| { type: 'compaction_start'; reason: 'threshold' | 'overflow'; estimatedTokens: number }
	| { type: 'compaction'; messagesBefore: number; messagesAfter: number; durationMs: number; usage?: PromptUsage }
	| { type: 'operation_start'; operationId: string; operationKind: OperationKind }
	| { type: 'operation'; operationId: string; operationKind: OperationKind; durationMs: number; isError: boolean; error?: unknown; result?: unknown; usage?: PromptUsage }
	| { type: 'log'; level: 'info' | 'warn' | 'error'; message: string; attributes?: Record<string, unknown> }
	| { type: 'idle' }
	| { type: 'run_end'; runId: string; result?: unknown; isError: boolean; error?: unknown; durationMs: number }
	| { type: string; truncated: true; originalSize: number; preview: string }
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
