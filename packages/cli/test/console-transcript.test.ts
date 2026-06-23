import type { FlueEvent } from '@flue/sdk';
import { describe, expect, it } from 'vitest';
import { createConsoleTranscript, reduceConsoleTranscript, sanitize, TRANSCRIPT_LIMIT } from '../src/lib/console-transcript.ts';

function event<T extends object>(value: T): T & Pick<FlueEvent, 'v' | 'eventIndex' | 'timestamp'> {
	return { ...value, v: 1, eventIndex: 1, timestamp: '2026-06-22T00:00:00.000Z' };
}

describe('reduceConsoleTranscript()', () => {
	it('uses authoritative message_end content and bounds sanitized detail', () => {
		let transcript = createConsoleTranscript();
		transcript = reduceConsoleTranscript(transcript, { type: 'event', event: event({ type: 'text_delta', text: 'partial', turnId: 'turn-1' }) });
		transcript = reduceConsoleTranscript(transcript, {
			type: 'event',
			event: event({ type: 'message_end', turnId: 'turn-1', message: { role: 'assistant', content: [{ type: 'text', text: '\u001b[31mfinal\u0007' }] } }),
		});
		transcript = reduceConsoleTranscript(transcript, { type: 'event', event: event({ type: 'tool', toolName: 'shell', toolCallId: 'tool-1', isError: false, durationMs: 5, result: 'x'.repeat(500) }) });

		expect(transcript.records[0]?.text).toBe('final');
		expect(transcript.records[1]?.text.length).toBeLessThan(300);
		expect(sanitize('\u001b[31mred\u0000')).toBe('red');
		expect(sanitize('before\u001b]8;;https://example.com\u001b\\linked\u001b]8;;\u001b\\ after')).toBe('beforelinked after');
		expect(sanitize('before\u001b]0;title\u0007after')).toBe('beforeafter');
	});

	it('suppresses internal runtime diagnostics from server output', () => {
		let transcript = createConsoleTranscript();
		transcript = reduceConsoleTranscript(transcript, {
			type: 'server',
			stream: 'stderr',
			line: '(node:123) ExperimentalWarning: SQLite is an experimental feature and might change at any time',
		});
		transcript = reduceConsoleTranscript(transcript, {
			type: 'server',
			stream: 'stderr',
			line: '(Use `node --trace-warnings ...` to show where the warning was created)',
		});
		transcript = reduceConsoleTranscript(transcript, {
			type: 'server',
			stream: 'stdout',
			line: '\u001b[2m    wrangler /app/wrangler.jsonc\u001b[22m',
		});

		expect(transcript.records).toEqual([]);
	});

	it('shows thinking only when the model returns thinking content', () => {
		let transcript = createConsoleTranscript();
		transcript = reduceConsoleTranscript(transcript, { type: 'event', event: event({ type: 'thinking_start' }) });
		transcript = reduceConsoleTranscript(transcript, { type: 'event', event: event({ type: 'thinking_end', content: '' }) });
		expect(transcript.records).toEqual([]);

		transcript = reduceConsoleTranscript(transcript, { type: 'event', event: event({ type: 'thinking_start' }) });
		transcript = reduceConsoleTranscript(transcript, { type: 'event', event: event({ type: 'thinking_delta', delta: 'Inspecting' }) });
		transcript = reduceConsoleTranscript(transcript, { type: 'event', event: event({ type: 'thinking_end', content: 'Inspecting the request.' }) });
		expect(transcript.records).toEqual([
			expect.objectContaining({ text: 'Thinking...\nInspecting the request.', tone: 'dim', layout: 'thinking' }),
		]);
	});

	it('retains only the latest 1000 records', () => {
		let transcript = createConsoleTranscript();
		for (let index = 0; index < TRANSCRIPT_LIMIT + 5; index++) transcript = reduceConsoleTranscript(transcript, { type: 'status', message: `record ${index}` });
		expect(transcript.records).toHaveLength(TRANSCRIPT_LIMIT);
		expect(transcript.records[0]?.text).toBe('record 5');
	});
});
