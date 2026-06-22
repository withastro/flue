import { describe, expect, it } from 'vitest';
import { createLineEventPresenter } from '../src/lib/line-event-presenter.ts';

describe('createLineEventPresenter()', () => {
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

		presenter.present({ type: 'tool_start', toolName: 'bash', toolCallId: '1', args: { command: 'pwd' } } as never);
		presenter.present({ type: 'log', level: 'info', message: 'ready' } as never);

		expect(lines).toEqual(['tool bash  $ pwd', 'info ready']);
	});
});
