import type { ConversationStreamChunk, FlueEvent } from '@flue/sdk';

const CONVERSATION_CHUNK_TYPES = new Set<ConversationStreamChunk['type']>([
	'conversation-reset',
	'message-appended',
	'message-started',
	'part-start',
	'part-delta',
	'part-end',
	'tool-input',
	'tool-output',
	'tool-output-error',
	'message-completed',
	'submission-settled',
]);

function isConversationChunk(
	event: ConversationStreamChunk | FlueEvent,
): event is ConversationStreamChunk {
	return CONVERSATION_CHUNK_TYPES.has(event.type as ConversationStreamChunk['type']);
}

export interface LineEventPresenterOptions {
	write(line: string): void;
	dim?: (value: string) => string;
	textHeading?: string;
	textIndent?: string;
}

export interface LineEventPresenter {
	present(event: ConversationStreamChunk | FlueEvent): void;
	flush(): void;
}

export function createLineEventPresenter(options: LineEventPresenterOptions): LineEventPresenter {
	const dim = options.dim ?? ((value: string) => value);
	const textIndent = options.textIndent ?? '  ';
	let textBuffer = '';
	let thinkingBuffer = '';
	let textStarted = false;
	const beginText = () => {
		if (textStarted) return;
		textStarted = true;
		if (options.textHeading) options.write(options.textHeading);
	};
	const flushText = () => {
		if (!textBuffer) return;
		beginText();
		writeLines(textBuffer, (line) => `${textIndent}${line}`, options.write);
		textBuffer = '';
	};
	const flushThinking = () => {
		if (!thinkingBuffer) return;
		writeLines(thinkingBuffer, (line) => dim(`  ${line}`), options.write);
		thinkingBuffer = '';
	};
	const flush = () => {
		flushText();
		flushThinking();
	};

	const partKinds = new Map<string, 'text' | 'reasoning'>();
	const toolNames = new Map<string, string>();

	return {
		flush,
		present(event) {
			if (isConversationChunk(event)) {
				switch (event.type) {
					case 'part-start':
						partKinds.set(event.partId, event.kind);
						if (event.kind === 'reasoning') {
							flushText();
							options.write(dim('thinking'));
						}
						return;
					case 'part-delta':
						partKinds.set(event.partId, event.kind);
						if (event.kind === 'reasoning') {
							flushText();
							thinkingBuffer = consumeCompleteLines(
								thinkingBuffer + event.delta,
								options.write,
								(line) => dim(`  ${line}`),
							);
						} else {
							flushThinking();
							beginText();
							textBuffer = consumeCompleteLines(
								textBuffer + event.delta,
								options.write,
								(line) => `${textIndent}${line}`,
							);
						}
						return;
					case 'part-end':
						if (partKinds.get(event.partId) === 'reasoning') flushThinking();
						else flushText();
						return;
					case 'tool-input':
						toolNames.set(event.toolCallId, event.toolName);
						flush();
						options.write(`${dim('tool')} ${event.toolName}`);
						return;
					case 'tool-output':
						options.write(`${dim('tool done')} ${toolNames.get(event.toolCallId) ?? ''}`.trimEnd());
						return;
					case 'tool-output-error':
						options.write(`${dim('tool error')} ${toolNames.get(event.toolCallId) ?? ''}`.trimEnd());
						return;
					case 'message-completed':
					case 'submission-settled':
						flush();
						return;
					default:
						return;
				}
			}
			switch (event.type) {
				case 'text_delta':
					flushThinking();
					beginText();
					textBuffer = consumeCompleteLines(
						textBuffer + event.text,
						options.write,
						(line) => `${textIndent}${line}`,
					);
					break;
				case 'thinking_start':
					flushText();
					options.write(dim('thinking'));
					break;
				case 'thinking_delta':
					flushText();
					thinkingBuffer = consumeCompleteLines(
						thinkingBuffer + event.delta,
						options.write,
						(line) => dim(`  ${line}`),
					);
					break;
				case 'thinking_end':
					flushThinking();
					break;
				case 'tool_start':
					flush();
					options.write(`${dim('tool')} ${event.toolName}`);
					break;
				case 'tool':
					options.write(`${dim(`tool ${event.isError ? 'error' : 'done'}`)} ${event.toolName}`);
					break;
				case 'log':
					flush();
					options.write(`${dim(event.level)} ${event.message}`);
					break;
				case 'compaction_start':
					flush();
					options.write(dim(`compaction start reason=${event.reason} tokens=${event.estimatedTokens}`));
					break;
				case 'compaction':
					options.write(dim(`compaction done messages ${event.messagesBefore} → ${event.messagesAfter}`));
					break;
				case 'turn':
				case 'idle':
				case 'submission_settled':
				case 'run_end':
					flush();
					break;
			}
		},
	};
}

function consumeCompleteLines(
	value: string,
	write: (line: string) => void,
	format: (line: string) => string,
): string {
	const lines = value.split('\n');
	const remainder = lines.pop() ?? '';
	for (const line of lines) write(format(line));
	return remainder;
}

function writeLines(
	value: string,
	format: (line: string) => string,
	write: (line: string) => void,
): void {
	for (const line of value.split('\n')) {
		if (line) write(format(line));
	}
}
