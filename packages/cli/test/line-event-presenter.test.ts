import { describe, expect, it } from 'vitest';
import { createLineEventPresenter } from '../src/lib/line-event-presenter.ts';

describe('createLineEventPresenter()', () => {
	it('renders canonical agent text and tool updates', () => {
		const lines: string[] = [];
		const presenter = createLineEventPresenter({ write: (line) => lines.push(line) });
		const update = (id: string, type: string, fields: Record<string, unknown>) => ({
			v: 1 as const,
			type: 'conversation_record' as const,
			conversationId: 'conversation-1',
			record: {
				v: 1 as const,
				id,
				type,
				conversationId: 'conversation-1',
				harness: 'default',
				session: 'default',
				timestamp: '2026-06-26T00:00:00.000Z',
				...fields,
			},
		});

		presenter.present(update('delta-1', 'assistant_text_delta', { delta: 'hello' }));
		presenter.present(update('text-done', 'assistant_text_completed', {}));
		presenter.present(update('tool-call', 'assistant_tool_call', { name: 'bash' }));
		presenter.present(update('tool-result', 'tool_result', { toolName: 'bash', isError: false }));

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
