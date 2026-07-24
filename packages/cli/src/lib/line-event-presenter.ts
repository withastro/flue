import type { ConversationStreamChunk } from '@flue/sdk';

export interface LineEventPresenterOptions {
	write(line: string): void;
	dim?: (value: string) => string;
	textHeading?: string;
	textIndent?: string;
}

export interface LineEventPresenter {
	present(event: ConversationStreamChunk): void;
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

	let streamingKind: 'text' | 'reasoning' | undefined;
	const toolNames = new Map<string, string>();

	return {
		flush,
		present(event) {
			switch (event.type) {
				case 'message-delta':
					if (event.kind === 'reasoning') {
						flushText();
						if (streamingKind !== 'reasoning') options.write(dim('thinking'));
						streamingKind = 'reasoning';
						thinkingBuffer = consumeCompleteLines(
							thinkingBuffer + event.delta,
							options.write,
							(line) => dim(`  ${line}`),
						);
					} else {
						flushThinking();
						beginText();
						streamingKind = 'text';
						textBuffer = consumeCompleteLines(
							textBuffer + event.delta,
							options.write,
							(line) => `${textIndent}${line}`,
						);
					}
					return;
				case 'tool-input':
					toolNames.set(event.toolCallId, event.toolName);
					flush();
					streamingKind = undefined;
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
					streamingKind = undefined;
					return;
				default:
					return;
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
