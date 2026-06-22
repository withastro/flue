import type { FlueEvent } from '@flue/sdk';

export interface LineEventPresenterOptions {
	write(line: string): void;
	dim?: (value: string) => string;
}

export interface LineEventPresenter {
	present(event: FlueEvent): void;
	flush(): void;
}

export function createLineEventPresenter(options: LineEventPresenterOptions): LineEventPresenter {
	const dim = options.dim ?? ((value: string) => value);
	let textBuffer = '';
	let thinkingBuffer = '';
	const flushText = () => {
		if (!textBuffer) return;
		writeLines(textBuffer, (line) => `  ${line}`, options.write);
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
			switch (event.type) {
				case 'text_delta':
					flushThinking();
					textBuffer = consumeCompleteLines(textBuffer + event.text, options.write, (line) => `  ${line}`);
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
					options.write(`${dim('tool')} ${toolDetail(event.toolName, event.args)}`);
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

function toolDetail(toolName: string, args: unknown): string {
	if (!isRecord(args)) return toolName;
	const key = toolName === 'bash' ? 'command' : toolName === 'grep' || toolName === 'glob' ? 'pattern' : 'path';
	const value = args[key];
	if (typeof value !== 'string') return toolName;
	const detail = value.length > 120 ? `${value.slice(0, 120)}...` : value;
	return toolName === 'bash' ? `${toolName}  $ ${detail}` : `${toolName}  ${detail}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}
