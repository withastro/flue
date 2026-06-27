import { describe, expect, it } from 'vitest';
import { createLineEventPresenter } from '../src/lib/line-event-presenter.ts';

describe('createLineEventPresenter()', () => {
	it('renders agent conversation chunks for text and tool updates', () => {
		const lines: string[] = [];
		const presenter = createLineEventPresenter({ write: (line) => lines.push(line) });

		presenter.present({ type: 'part-delta', conversationId: 'c1', messageId: 'a1', partId: 'b1', kind: 'text', sequence: 0, delta: 'hello' });
		presenter.present({ type: 'part-end', conversationId: 'c1', messageId: 'a1', partId: 'b1' });
		presenter.present({ type: 'tool-input', conversationId: 'c1', messageId: 'a1', toolCallId: 't1', toolName: 'bash', input: {} });
		presenter.present({ type: 'tool-output', conversationId: 'c1', toolCallId: 't1', output: {} });

		expect(lines).toEqual(['  hello', 'tool bash', 'tool done bash']);
	});

	it('keeps partial line buffers isolated by presenter instance', () => {
		const first: string[] = [];
		const second: string[] = [];
		const firstPresenter = createLineEventPresenter({ write: (line) => first.push(line) });
		const secondPresenter = createLineEventPresenter({ write: (line) => second.push(line) });
		const event = { type: 'text_delta', text: 'partial' } as const;

		firstPresenter.present(event as never);
		secondPresenter.present({ ...event, text: 'other\n' } as never);
		firstPresenter.flush();

		expect(first).toEqual(['  partial']);
		expect(second).toEqual(['  other']);
	});

	it('renders tool and log events as lines', () => {
		const lines: string[] = [];
		const presenter = createLineEventPresenter({ write: (line) => lines.push(line) });

		presenter.present({ type: 'tool_start', toolName: 'bash', toolCallId: '1' } as never);
		presenter.present({ type: 'log', level: 'info', message: 'ready' } as never);

		expect(lines).toEqual(['tool bash', 'info ready']);
	});
});
