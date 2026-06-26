import type { AgentConversationUpdate, FlueEvent } from '@flue/sdk';

export interface LineEventPresenterOptions {
	write(line: string): void;
	dim?: (value: string) => string;
	textHeading?: string;
	textIndent?: string;
}

export interface LineEventPresenter {
	present(event: AgentConversationUpdate | FlueEvent): void;
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

	return {
		flush,
		present(event) {
			if (event.v === 1) {
				if (event.type !== 'conversation_record') return;
				const record = event.record;
				switch (record.type) {
					case 'assistant_text_delta':
						if (typeof record.delta !== 'string') return;
						flushThinking();
						beginText();
						textBuffer = consumeCompleteLines(
							textBuffer + record.delta,
							options.write,
							(line) => `${textIndent}${line}`,
						);
						return;
					case 'assistant_text_completed':
						flushText();
						return;
					case 'assistant_reasoning_started':
						flushText();
						options.write(dim('thinking'));
						return;
					case 'assistant_reasoning_delta':
						if (typeof record.delta !== 'string') return;
						flushText();
						thinkingBuffer = consumeCompleteLines(
							thinkingBuffer + record.delta,
							options.write,
							(line) => dim(`  ${line}`),
						);
						return;
					case 'assistant_reasoning_completed':
						flushThinking();
						return;
					case 'assistant_tool_call':
						if (typeof record.name !== 'string') return;
						flush();
						options.write(`${dim('tool')} ${record.name}`);
						return;
					case 'tool_result':
						if (typeof record.toolName !== 'string') return;
						options.write(`${dim(`tool ${record.isError === true ? 'error' : 'done'}`)} ${record.toolName}`);
						return;
					case 'submission_settled':
					case 'assistant_message_completed':
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
