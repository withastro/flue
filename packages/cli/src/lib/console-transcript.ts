import type { FlueEvent } from '@flue/sdk';

type TranscriptTone = 'normal' | 'dim' | 'error' | 'success' | 'accent' | 'user';

export interface TranscriptRecord {
	readonly id: number;
	readonly text: string;
	readonly tone: TranscriptTone;
	readonly layout?: 'thinking';
}

export interface ConsoleTranscript {
	readonly records: readonly TranscriptRecord[];
	readonly nextId: number;
	readonly streaming: Readonly<Record<string, string>>;
}

export type TranscriptAction =
	| { type: 'event'; event: FlueEvent }
	| { type: 'server'; stream: 'stdout' | 'stderr'; line: string }
	| { type: 'prompt'; message: string }
	| { type: 'result'; result: unknown }
	| { type: 'error'; error: unknown }
	| { type: 'status'; message: string };

export const TRANSCRIPT_LIMIT = 1000;
const DETAIL_LIMIT = 240;

export function createConsoleTranscript(): ConsoleTranscript {
	return { records: [], nextId: 0, streaming: {} };
}

export function reduceConsoleTranscript(
	state: ConsoleTranscript,
	action: TranscriptAction,
): ConsoleTranscript {
	if (action.type === 'server') {
		if (isSuppressedServerOutput(action.line)) return state;
		return append(state, `server ${action.stream}  ${action.line}`, action.stream === 'stdout' ? 'dim' : 'error');
	}
	if (action.type === 'prompt') return append(state, action.message, 'user');
	if (action.type === 'result') return state;
	if (action.type === 'error') return append(state, `error  ${errorMessage(action.error)}`, 'error');
	if (action.type === 'status') return append(state, action.message, 'dim');
	return reduceEvent(state, action.event);
}

function reduceEvent(state: ConsoleTranscript, event: FlueEvent): ConsoleTranscript {
	if (event.type === 'text_delta') {
		const key = event.turnId ?? `event:${event.eventIndex}`;
		return { ...state, streaming: { ...state.streaming, [key]: `${state.streaming[key] ?? ''}${event.text}` } };
	}
	if (event.type === 'message_end') {
		const key = event.turnId;
		const text = messageText(event.message) || (key ? state.streaming[key] : undefined) || '';
		const streaming = { ...state.streaming };
		if (key) delete streaming[key];
		return text ? append({ ...state, streaming }, text, 'normal') : { ...state, streaming };
	}
	if (event.type === 'thinking_start' || event.type === 'thinking_delta') return state;
	if (event.type === 'thinking_end') {
		const content = sanitize(event.content);
		return content ? append(state, `Thinking...\n${content}`, 'dim', 'thinking') : state;
	}
	if (event.type === 'tool_start') return append(state, `tool  ${event.toolName} ${toolDetail(event.toolName, event.args)}`, 'dim');
	if (event.type === 'tool') {
		return append(
			state,
			`tool ${event.isError ? 'failed' : 'done'}  ${event.toolName} ${event.durationMs}ms${event.result === undefined ? '' : `  ${detail(event.result)}`}`,
			event.isError ? 'error' : 'dim',
		);
	}
	if (event.type === 'operation_start' && event.operationKind === 'prompt') return state;
	if (event.type === 'operation' && event.operationKind === 'prompt') return state;
	if (event.type === 'operation_start') return append(state, `${event.operationKind} started`, 'dim');
	if (event.type === 'operation') {
		const value = event.error ?? event.result;
		return append(
			state,
			`${event.operationKind} ${event.isError ? 'failed' : 'completed'} ${event.durationMs}ms${value === undefined ? '' : `  ${detail(value)}`}`,
			event.isError ? 'error' : 'dim',
		);
	}
	if (event.type === 'task_start') return append(state, `task started  ${detail(event.prompt)}`, 'dim');
	if (event.type === 'task') return append(state, `task ${event.isError ? 'failed' : 'completed'} ${event.durationMs}ms  ${detail(event.result)}`, event.isError ? 'error' : 'dim');
	if (event.type === 'log') return append(state, `${event.level}  ${event.message}`, event.level === 'error' ? 'error' : event.level === 'warn' ? 'accent' : 'dim');
	if (event.type === 'run_start') return append(state, `run ${event.runId} started`, 'dim');
	if (event.type === 'run_resume') return append(state, `run ${event.runId} resumed`, 'dim');
	if (event.type === 'run_end') return append(state, `run ${event.runId} ${event.isError ? 'failed' : 'completed'} ${event.durationMs}ms`, event.isError ? 'error' : 'success');
	if (event.type === 'submission_settled') return state;
	return state;
}

function isSuppressedServerOutput(line: string): boolean {
	const clean = sanitize(line);
	return (
		clean.includes('ExperimentalWarning: SQLite is an experimental feature and might change at any time') ||
		clean.includes('Use `node --trace-warnings') ||
		clean.startsWith('wrangler ')
	);
}

function append(
	state: ConsoleTranscript,
	raw: string,
	tone: TranscriptTone,
	layout?: TranscriptRecord['layout'],
): ConsoleTranscript {
	const text = layout === 'thinking'
		? raw.split('\n').map(sanitize).filter(Boolean).join('\n')
		: sanitize(raw);
	if (!text) return state;
	const records = [...state.records, { id: state.nextId, text, tone, layout }].slice(-TRANSCRIPT_LIMIT);
	return { ...state, records, nextId: state.nextId + 1 };
}

export function transcriptDisplayRecords(state: ConsoleTranscript): readonly TranscriptRecord[] {
	const pending = Object.values(state.streaming)
		.filter(Boolean)
		.map((text, index) => ({ id: state.nextId + index, text: sanitize(text), tone: 'normal' as const }));
	return [...state.records, ...pending];
}

export function sanitize(value: string): string {
	let clean = '';
	let escapeState: 'none' | 'start' | 'csi' | 'osc' | 'oscEscape' = 'none';
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		if (escapeState === 'osc' && code === 27) {
			escapeState = 'oscEscape';
			continue;
		}
		if (escapeState === 'oscEscape') {
			escapeState = character === '\\' ? 'none' : 'osc';
			continue;
		}
		if (code === 27) {
			escapeState = 'start';
			continue;
		}
		if (escapeState === 'start') {
			escapeState = character === '[' ? 'csi' : character === ']' ? 'osc' : 'none';
			continue;
		}
		if (escapeState === 'csi') {
			if (code >= 64 && code <= 126) escapeState = 'none';
			continue;
		}
		if (escapeState === 'osc') {
			if (code === 7) escapeState = 'none';
			continue;
		}
		if ((code >= 0 && code <= 8) || (code >= 11 && code <= 31) || (code >= 127 && code <= 159)) {
			clean += code === 9 || code === 10 || code === 13 ? ' ' : '';
			continue;
		}
		clean += character;
	}
	return clean.replace(/\s+/g, ' ').trim();
}

function detail(value: unknown): string {
	let text: string;
	try {
		text = typeof value === 'string' ? value : JSON.stringify(value);
	} catch {
		text = String(value);
	}
	const clean = sanitize(text ?? String(value));
	return clean.length > DETAIL_LIMIT ? `${clean.slice(0, DETAIL_LIMIT - 1)}…` : clean;
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return detail(error.message);
	if (isRecord(error) && typeof error.message === 'string') return detail(error.message);
	return detail(error);
}

function toolDetail(name: string, args: unknown): string {
	if (!isRecord(args)) return '';
	const key = name === 'bash' || name === 'shell' ? 'command' : name === 'grep' || name === 'glob' ? 'pattern' : 'path';
	const value = args[key];
	return typeof value === 'string' ? detail(value) : '';
}

function messageText(message: unknown): string {
	if (!isRecord(message) || message.role !== 'assistant') return '';
	const { content } = message;
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return '';
	return content
		.map((part) => {
			if (!isRecord(part)) return '';
			if (typeof part.text === 'string') return part.text;
			return '';
		})
		.filter(Boolean)
		.join('\n');
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
