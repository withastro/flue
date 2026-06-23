import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConsoleController, ConsoleSnapshot } from '../src/lib/console-controller.ts';
import { createConsoleTranscript, reduceConsoleTranscript } from '../src/lib/console-transcript.ts';
import { ConsoleUi, submitConsoleMessage } from '../src/lib/console-ui.tsx';

afterEach(cleanup);

function controller(snapshot: ConsoleSnapshot): ConsoleController {
	return {
		subscribe: () => () => {},
		getSnapshot: () => snapshot,
		start: vi.fn(async () => {}),
		submit: vi.fn(async () => {}),
		recordServerOutput: vi.fn(),
		setLifecycleStatus: vi.fn(),
		close: vi.fn(async () => {}),
		forceCloseSync: vi.fn(),
	};
}

describe('ConsoleUi', () => {
	it('renders user and agent labels above left-aligned messages', () => {
		let transcript = createConsoleTranscript();
		transcript = reduceConsoleTranscript(transcript, { type: 'prompt', message: 'Hello' });
		transcript = reduceConsoleTranscript(transcript, {
			type: 'event',
			event: {
				v: 1,
				eventIndex: 1,
				timestamp: '2026-06-22T00:00:00.000Z',
				type: 'message_end',
				turnId: 'turn-1',
				message: { role: 'assistant', content: [{ type: 'text', text: 'Hi there' }] },
			},
		});
		const value = controller({ resource: { kind: 'agent', name: 'support' }, id: 'instance-1', target: 'node', server: 'http://localhost:3000', remote: false, status: 'completed', active: false, composerEnabled: true, queuedPrompts: [], transcript });
		const view = render(<ConsoleUi controller={value} />);
		const output = view.lastFrame() ?? '';

		expect(output).toMatch(/you\s*\nHello/);
		expect(output).toMatch(/agent\s*\nHi there/);
	});

	it('pins queued prompts between incoming output and the composer', () => {
		let transcript = createConsoleTranscript();
		transcript = reduceConsoleTranscript(transcript, { type: 'server', line: 'incoming output', stream: 'stdout' });
		const value = controller({
			resource: { kind: 'agent', name: 'support' },
			id: 'instance-1',
			target: 'node',
			server: 'http://localhost:3000',
			remote: false,
			status: 'active',
			active: true,
			composerEnabled: true,
			queuedPrompts: [
				{ id: 1, message: 'next message' },
				{ id: 2, message: 'later message' },
			],
			transcript,
		});
		const view = render(<ConsoleUi controller={value} />);
		const output = view.lastFrame() ?? '';

		expect(output.indexOf('incoming output')).toBeLessThan(output.indexOf('next message'));
		expect(output.indexOf('next message')).toBeLessThan(output.indexOf('agent support'));
		expect(output.indexOf('agent support')).toBeLessThan(output.indexOf('Send another message'));
		expect(output).toMatch(/queue\s*\nnext message\s*\nlater message/);
		expect(output.match(/queue/g)).toHaveLength(1);
	});

	it('assigns the conventional exit code before Ctrl+C cleanup', async () => {
		const previous = process.exitCode;
		let release: (() => void) | undefined;
		const value = controller({ resource: { kind: 'agent', name: 'support' }, id: 'instance-1', target: 'node', server: 'http://localhost:3000', remote: false, status: 'active', active: true, composerEnabled: false, queuedPrompts: [], transcript: createConsoleTranscript() });
		value.close = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
		const view = render(<ConsoleUi controller={value} />);

		view.stdin.write('\u0003');
		await Promise.resolve();
		expect(process.exitCode).toBe(130);
		expect(value.close).toHaveBeenCalledOnce();
		release?.();
		process.exitCode = previous;
	});

	it('absorbs rapid duplicate submission rejections', async () => {
		const value = controller({ resource: { kind: 'agent', name: 'support' }, id: 'instance-1', target: 'node', server: 'http://localhost:3000', remote: false, status: 'ready', active: false, composerEnabled: true, queuedPrompts: [], transcript: createConsoleTranscript() });
		value.submit = vi.fn().mockRejectedValue(new Error('A prompt is already active.'));

		submitConsoleMessage(value, 'first');
		submitConsoleMessage(value, 'second');
		await Promise.resolve();

		expect(value.submit).toHaveBeenCalledTimes(2);
	});

});
