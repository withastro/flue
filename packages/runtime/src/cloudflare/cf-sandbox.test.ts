import { describe, expect, it, vi } from 'vitest';
import { type CloudflareSandboxStub, cloudflareSandbox, consumeExecStream } from './cf-sandbox.ts';

type StubExec = CloudflareSandboxStub['exec'];
type StubExecStream = CloudflareSandboxStub['execStream'];
const encoder = new TextEncoder();

function eventStream(events: readonly unknown[]): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			for (const event of events) {
				controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
			}
			controller.close();
		},
	});
}

function textStream(chunks: readonly string[]): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
			controller.close();
		},
	});
}

function createExecStream(events: readonly unknown[]): StubExecStream {
	return vi.fn(async () => eventStream(events));
}

function createStub(
	exec: StubExec,
	execStream: StubExecStream = createExecStream([{ type: 'complete', exitCode: 0 }]),
): CloudflareSandboxStub {
	return {
		exec,
		execStream,
		async readFile() {
			return { content: '' };
		},
		async writeFile() {},
		async exists() {
			return { exists: false };
		},
		async mkdir() {},
		async deleteFile() {},
		async getState() {
			return { status: 'running' };
		},
	};
}

describe('consumeExecStream', () => {
	it('parses fragmented SSE frames and collects the complete result', async () => {
		const chunks: Array<['stdout' | 'stderr', string]> = [];
		const stream = textStream([
			'event: output\r\ndata: {"type":"stdout","data":"hel',
			'lo "}\r\n\r\ndata: {"type":"stderr","data":"warning"}\n\n',
			'data: {"type":"stdout","data":"world"}\n\ndata: {"type":"complete",',
			'"exitCode":7}\n\n',
		]);

		const result = await consumeExecStream(Promise.resolve(stream), (channel, data) => {
			chunks.push([channel, data]);
		});

		expect(chunks).toEqual([
			['stdout', 'hello '],
			['stderr', 'warning'],
			['stdout', 'world'],
		]);
		expect(result).toEqual({
			success: false,
			stdout: 'hello world',
			stderr: 'warning',
			exitCode: 7,
		});
	});

	it('ignores non-JSON SSE data', async () => {
		const stream = textStream(['data: not-json\n\n', 'data: {"type":"complete","exitCode":0}\n\n']);

		await expect(consumeExecStream(Promise.resolve(stream), vi.fn())).resolves.toEqual({
			success: true,
			stdout: '',
			stderr: '',
			exitCode: 0,
		});
	});

	it('rejects Cloudflare error events', async () => {
		const stream = eventStream([{ type: 'error', error: 'command failed' }]);

		await expect(consumeExecStream(Promise.resolve(stream), vi.fn())).rejects.toThrow(
			'command failed',
		);
	});

	it('rejects a stream that ends without a completion event', async () => {
		const onOutput = vi.fn();
		const stream = eventStream([{ type: 'stdout', data: 'partial' }]);

		await expect(consumeExecStream(Promise.resolve(stream), onOutput)).rejects.toThrow(
			'ended without a completion event',
		);
		expect(onOutput).toHaveBeenCalledWith('stdout', 'partial');
	});
});

describe('cloudflareSandbox exec output', () => {
	it('streams stdout and stderr while preserving the complete result', async () => {
		const exec = vi.fn<StubExec>();
		const execStream = createExecStream([
			{ type: 'start' },
			{ type: 'stdout', data: 'hello ' },
			{ type: 'stderr', data: 'warning' },
			{ type: 'stdout', data: 'world' },
			{ type: 'complete', exitCode: 0 },
		]);
		const sandbox = await cloudflareSandbox(createStub(exec, execStream), {
			cwd: '/workspace',
		}).createSandbox({ id: 'agent-1' });
		const chunks: Array<['stdout' | 'stderr', string]> = [];

		const result = await sandbox.exec('run', {
			cwd: 'project',
			onOutput: (stream, data) => chunks.push([stream, data]),
		});

		expect(chunks).toEqual([
			['stdout', 'hello '],
			['stderr', 'warning'],
			['stdout', 'world'],
		]);
		expect(result).toEqual({ stdout: 'hello world', stderr: 'warning', exitCode: 0 });
		expect(exec).not.toHaveBeenCalled();
		expect(execStream).toHaveBeenCalledWith(
			'run',
			expect.objectContaining({ cwd: '/workspace/project' }),
		);
	});

	it('keeps the buffered execution path when no output callback is supplied', async () => {
		let receivedOptions: Parameters<StubExec>[1];
		const exec = vi.fn<StubExec>(async (_command, options) => {
			receivedOptions = options;
			return { success: true, stdout: 'done', stderr: '', exitCode: 0 };
		});
		const sandbox = await cloudflareSandbox(createStub(exec)).createSandbox({ id: 'agent-1' });

		await sandbox.exec('run');

		expect(receivedOptions).not.toHaveProperty('stream');
		expect(receivedOptions).not.toHaveProperty('onOutput');
	});

	it('does not fail the command when the output callback throws', async () => {
		const observerError = new Error('logger failed');
		const onObserverError = vi.fn();
		const exec = vi.fn<StubExec>();
		const execStream = createExecStream([
			{ type: 'stdout', data: 'progress' },
			{ type: 'complete', exitCode: 0 },
		]);
		const sandbox = await cloudflareSandbox(createStub(exec, execStream), {
			onObserverError,
		}).createSandbox({ id: 'agent-1' });

		await expect(
			sandbox.exec('run', {
				onOutput: () => {
					throw observerError;
				},
			}),
		).resolves.toEqual({ stdout: 'progress', stderr: '', exitCode: 0 });
		expect(onObserverError).toHaveBeenCalledWith({ observer: 'onOutput', error: observerError });
	});

	it('reports an asynchronous output callback failure', async () => {
		const observerError = new Error('async logger failed');
		const onObserverError = vi.fn();
		const exec = vi.fn<StubExec>();
		const execStream = createExecStream([
			{ type: 'stdout', data: 'progress' },
			{ type: 'complete', exitCode: 0 },
		]);
		const sandbox = await cloudflareSandbox(createStub(exec, execStream), {
			onObserverError,
		}).createSandbox({ id: 'agent-1' });

		await expect(
			sandbox.exec('run', {
				onOutput: async () => {
					throw observerError;
				},
			}),
		).resolves.toEqual({ stdout: 'progress', stderr: '', exitCode: 0 });
		await vi.waitFor(() =>
			expect(onObserverError).toHaveBeenCalledWith({ observer: 'onOutput', error: observerError }),
		);
	});

	it('contains failures thrown by the observer failure reporter', async () => {
		const reportError = new Error('reporter failed');
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const exec = vi.fn<StubExec>();
		const execStream = createExecStream([
			{ type: 'stdout', data: 'progress' },
			{ type: 'complete', exitCode: 0 },
		]);
		const sandbox = await cloudflareSandbox(createStub(exec, execStream), {
			onObserverError: () => {
				throw reportError;
			},
		}).createSandbox({ id: 'agent-1' });

		try {
			await expect(
				sandbox.exec('run', {
					onOutput: () => {
						throw new Error('logger failed');
					},
				}),
			).resolves.toEqual({ stdout: 'progress', stderr: '', exitCode: 0 });
			expect(consoleError).toHaveBeenCalledWith(
				'[flue:sandbox] observer failure reporter failed:',
				reportError,
				'Original observer failure:',
				expect.objectContaining({ observer: 'onOutput' }),
			);
		} finally {
			consoleError.mockRestore();
		}
	});

	it('contains an asynchronous observer failure reporter rejection', async () => {
		const observerError = new Error('logger failed');
		const reportError = new Error('async reporter failed');
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const exec = vi.fn<StubExec>();
		const execStream = createExecStream([
			{ type: 'stdout', data: 'progress' },
			{ type: 'complete', exitCode: 0 },
		]);
		const sandbox = await cloudflareSandbox(createStub(exec, execStream), {
			onObserverError: async () => {
				throw reportError;
			},
		}).createSandbox({ id: 'agent-1' });

		try {
			await expect(
				sandbox.exec('run', {
					onOutput: () => {
						throw observerError;
					},
				}),
			).resolves.toEqual({ stdout: 'progress', stderr: '', exitCode: 0 });
			await vi.waitFor(() =>
				expect(consoleError).toHaveBeenCalledWith(
					'[flue:sandbox] observer failure reporter failed:',
					reportError,
					'Original observer failure:',
					{ observer: 'onOutput', error: observerError },
				),
			);
		} finally {
			consoleError.mockRestore();
		}
	});

	it('rejects when the output callback aborts during command startup', async () => {
		const controller = new AbortController();
		const exec = vi.fn<StubExec>();
		const execStream = createExecStream([
			{ type: 'stdout', data: 'started' },
			{ type: 'complete', exitCode: 0 },
		]);
		const sandbox = await cloudflareSandbox(createStub(exec, execStream)).createSandbox({
			id: 'agent-1',
		});
		const result = sandbox.exec('run', {
			signal: controller.signal,
			onOutput: () => controller.abort('stop'),
		});

		await expect(result).rejects.toMatchObject({ name: 'AbortError' });
	});

	it('stops publishing output after caller-facing abort', async () => {
		let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				streamController = controller;
			},
		});
		const exec = vi.fn<StubExec>();
		const execStream = vi.fn<StubExecStream>(async () => stream);
		const sandbox = await cloudflareSandbox(createStub(exec, execStream)).createSandbox({
			id: 'agent-1',
		});
		const controller = new AbortController();
		const chunks: string[] = [];
		const result = sandbox.exec('run', {
			signal: controller.signal,
			onOutput: (_stream, data) => chunks.push(data),
		});

		controller.abort('stop');
		await expect(result).rejects.toMatchObject({ name: 'AbortError' });
		streamController?.enqueue(
			encoder.encode(`data: ${JSON.stringify({ type: 'stdout', data: 'late output' })}\n\n`),
		);
		streamController?.enqueue(
			encoder.encode(`data: ${JSON.stringify({ type: 'complete', exitCode: 0 })}\n\n`),
		);
		streamController?.close();
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(chunks).toEqual([]);
	});
});
