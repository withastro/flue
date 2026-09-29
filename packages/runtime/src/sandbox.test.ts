import { expect, it, vi } from 'vitest';
import { type SandboxDriver, sandboxFromDriver } from './sandbox.ts';

function createDriver(exec: SandboxDriver['exec']): SandboxDriver {
	return {
		exec,
		async readFile() {
			return '';
		},
		async readFileBuffer() {
			return new Uint8Array();
		},
		async writeFile() {},
		async stat() {
			return { isFile: false, isDirectory: false };
		},
		async readdir() {
			return [];
		},
		async exists() {
			return false;
		},
		async mkdir() {},
		async rm() {},
	};
}

it('reports an asynchronous orphan settlement callback failure', async () => {
	const pending = Promise.withResolvers<{ stdout: string; stderr: string; exitCode: number }>();
	const observerError = new Error('async orphan observer failed');
	const onObserverError = vi.fn();
	const sandbox = sandboxFromDriver(
		createDriver(() => pending.promise),
		'/workspace',
		{
			onOrphanSettled: async () => {
				throw observerError;
			},
			onObserverError,
		},
	);
	const controller = new AbortController();
	const result = sandbox.exec('run', { signal: controller.signal });

	controller.abort('stop');
	await expect(result).rejects.toMatchObject({ name: 'AbortError' });
	pending.resolve({ stdout: '', stderr: '', exitCode: 0 });
	await pending.promise;
	await vi.waitFor(() =>
		expect(onObserverError).toHaveBeenCalledWith({
			observer: 'onOrphanSettled',
			error: observerError,
		}),
	);
});
