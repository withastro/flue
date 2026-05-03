/**
 * Vercel Sandbox connector for Flue.
 *
 * Adapts an initialized Vercel Sandbox to Flue's SandboxFactory interface.
 * Create and configure the sandbox with the Vercel SDK, then pass it to
 * init({ sandbox }) through this connector.
 *
 * @example
 * ```typescript
 * import { Sandbox } from '@vercel/sandbox';
 * import { vercel } from '@flue/connectors/vercel';
 *
 * const sandbox = await Sandbox.create({ runtime: 'node24' });
 * const agent = await init({ sandbox: vercel(sandbox) });
 * const session = await agent.session();
 * ```
 */
import { createSandboxSessionEnv } from '@flue/sdk/sandbox';
import type { SandboxApi, SandboxFactory, SessionEnv, FileStat } from '@flue/sdk/sandbox';
import type { Sandbox as VercelSandbox } from '@vercel/sandbox';

const DEFAULT_VERCEL_CWD = '/vercel/sandbox';

function isAbortError(err: unknown, signal: AbortSignal): boolean {
	if (err === signal.reason) {
		return true;
	}

	return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

// ─── Options ────────────────────────────────────────────────────────────────

export interface VercelConnectorOptions {
	/**
	 * Working directory to use when Flue does not receive an explicit cwd.
	 *
	 * Vercel sandboxes default to /vercel/sandbox.
	 */
	cwd?: string;

	/**
	 * Cleanup behavior when the owning Flue agent is destroyed.
	 *
	 * - `false` (default): No cleanup. User code manages the sandbox lifecycle.
	 * - `true`: Calls `sandbox.stop({ blocking: true })` on agent destroy.
	 * - Function: Calls the provided function on agent destroy.
	 */
	cleanup?: boolean | (() => Promise<void>);
}

// ─── VercelSandboxApi ───────────────────────────────────────────────────────

/** Implements SandboxApi by wrapping the Vercel Sandbox SDK. */
class VercelSandboxApi implements SandboxApi {
	constructor(private sandbox: VercelSandbox) {}

	async readFile(path: string): Promise<string> {
		return this.sandbox.fs.readFile(path, 'utf8');
	}

	async readFileBuffer(path: string): Promise<Uint8Array> {
		const buffer = await this.sandbox.fs.readFile(path);
		return new Uint8Array(buffer);
	}

	async writeFile(path: string, content: string | Uint8Array): Promise<void> {
		await this.sandbox.fs.writeFile(path, content);
	}

	async stat(path: string): Promise<FileStat> {
		const stat = await this.sandbox.fs.stat(path);
		return {
			isFile: stat.isFile(),
			isDirectory: stat.isDirectory(),
			isSymbolicLink: stat.isSymbolicLink(),
			size: stat.size,
			mtime: stat.mtime,
		};
	}

	async readdir(path: string): Promise<string[]> {
		return this.sandbox.fs.readdir(path);
	}

	async exists(path: string): Promise<boolean> {
		return this.sandbox.fs.exists(path);
	}

	async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
		await this.sandbox.fs.mkdir(path, options);
	}

	async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
		await this.sandbox.fs.rm(path, options);
	}

	async exec(
		command: string,
		options?: { cwd?: string; env?: Record<string, string>; timeout?: number },
	): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		let signal: AbortSignal | undefined;

		if (typeof options?.timeout === 'number') {
			signal = AbortSignal.timeout(options.timeout * 1000);
		}

		try {
			const response = await this.sandbox.runCommand({
				cmd: 'bash',
				args: ['-c', command],
				cwd: options?.cwd,
				env: options?.env,
				signal,
			});

			const [stdout, stderr] = await Promise.all([
				response.stdout({ signal }),
				response.stderr({ signal }),
			]);

			return {
				stdout,
				stderr,
				exitCode: response.exitCode,
			};
		} catch (err) {
			if (signal?.aborted && isAbortError(err, signal)) {
				return {
					stdout: '',
					stderr: `[flue:vercel] Command timed out after ${options?.timeout} seconds.`,
					exitCode: 124,
				};
			}

			throw err;
		}
	}
}

// ─── Connector ──────────────────────────────────────────────────────────────

/**
 * Create a Flue sandbox factory from an initialized Vercel Sandbox.
 *
 * The returned factory can be passed directly to `init({ sandbox })`.
 *
 * @param sandbox - An initialized Vercel Sandbox instance.
 * @param options - Connector options.
 */
export function vercel(sandbox: VercelSandbox, options?: VercelConnectorOptions): SandboxFactory {
	return {
		async createSessionEnv({ cwd }: { id: string; cwd?: string }): Promise<SessionEnv> {
			const sandboxCwd = cwd ?? options?.cwd ?? DEFAULT_VERCEL_CWD;
			const api = new VercelSandboxApi(sandbox);

			let cleanup: (() => Promise<void>) | undefined;
			if (options?.cleanup === true) {
				cleanup = async () => {
					try {
						await sandbox.stop({ blocking: true });
					} catch (err) {
						console.error('[flue:vercel] Failed to stop sandbox:', err);
					}
				};
			} else if (typeof options?.cleanup === 'function') {
				cleanup = options.cleanup;
			}

			return createSandboxSessionEnv(api, sandboxCwd, cleanup);
		},
	};
}
