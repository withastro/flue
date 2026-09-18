import { describe, expect, it, vi } from 'vitest';
import { type CloudflareSandboxStub, cloudflareSandbox } from './cf-sandbox.ts';

type StubExec = CloudflareSandboxStub['exec'];

function createStub(exec: StubExec): CloudflareSandboxStub {
	return {
		exec,
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

describe('cloudflareSandbox exec output', () => {
	it('streams stdout and stderr while preserving the complete result', async () => {
		const exec = vi.fn<StubExec>(async (_command, options) => {
			options?.onOutput?.('stdout', 'hello ');
			options?.onOutput?.('stderr', 'warning');
			options?.onOutput?.('stdout', 'world');
			return {
				success: true,
				stdout: 'hello world',
				stderr: 'warning',
				exitCode: 0,
			};
		});
		const sandbox = await cloudflareSandbox(createStub(exec), { cwd: '/workspace' }).createSandbox({
			id: 'agent-1',
		});
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
		expect(exec).toHaveBeenCalledWith(
			'run',
			expect.objectContaining({ cwd: '/workspace/project', stream: true }),
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
		const exec = vi.fn<StubExec>(async (_command, options) => {
			options?.onOutput?.('stdout', 'progress');
			return { success: true, stdout: 'progress', stderr: '', exitCode: 0 };
		});
		const sandbox = await cloudflareSandbox(createStub(exec), { onObserverError }).createSandbox({
			id: 'agent-1',
		});

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
		const exec = vi.fn<StubExec>(async (_command, options) => {
			options?.onOutput?.('stdout', 'progress');
			return { success: true, stdout: 'progress', stderr: '', exitCode: 0 };
		});
		const sandbox = await cloudflareSandbox(createStub(exec), { onObserverError }).createSandbox({
			id: 'agent-1',
		});

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
		const exec = vi.fn<StubExec>(async (_command, options) => {
			options?.onOutput?.('stdout', 'progress');
			return { success: true, stdout: 'progress', stderr: '', exitCode: 0 };
		});
		const sandbox = await cloudflareSandbox(createStub(exec), {
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
		const exec = vi.fn<StubExec>(async (_command, options) => {
			options?.onOutput?.('stdout', 'progress');
			return { success: true, stdout: 'progress', stderr: '', exitCode: 0 };
		});
		const sandbox = await cloudflareSandbox(createStub(exec), {
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
		const pending = Promise.withResolvers<{
			success: boolean;
			stdout: string;
			stderr: string;
			exitCode: number;
		}>();
		const controller = new AbortController();
		const exec = vi.fn<StubExec>((_command, options) => {
			options?.onOutput?.('stdout', 'started');
			return pending.promise;
		});
		const sandbox = await cloudflareSandbox(createStub(exec)).createSandbox({ id: 'agent-1' });
		const result = sandbox.exec('run', {
			signal: controller.signal,
			onOutput: () => controller.abort('stop'),
		});

		await expect(result).rejects.toMatchObject({ name: 'AbortError' });
		pending.resolve({ success: true, stdout: 'started', stderr: '', exitCode: 0 });
		await pending.promise;
	});

	it('stops publishing output after caller-facing abort', async () => {
		const pending = Promise.withResolvers<{
			success: boolean;
			stdout: string;
			stderr: string;
			exitCode: number;
		}>();
		let receivedOptions: Parameters<StubExec>[1];
		const exec = vi.fn<StubExec>((_command, options) => {
			receivedOptions = options;
			return pending.promise;
		});
		const sandbox = await cloudflareSandbox(createStub(exec)).createSandbox({ id: 'agent-1' });
		const controller = new AbortController();
		const chunks: string[] = [];
		const result = sandbox.exec('run', {
			signal: controller.signal,
			onOutput: (_stream, data) => chunks.push(data),
		});

		controller.abort('stop');
		await expect(result).rejects.toMatchObject({ name: 'AbortError' });
		receivedOptions?.onOutput?.('stdout', 'late output');
		pending.resolve({ success: true, stdout: 'late output', stderr: '', exitCode: 0 });
		await pending.promise;

		expect(chunks).toEqual([]);
	});
});
