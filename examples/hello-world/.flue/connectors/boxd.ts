/**
 * boxd connector for Flue.
 *
 * Wraps an already-initialized boxd VM (a `Box` from `@boxd-sh/sdk`) into
 * Flue's SandboxFactory interface. The user creates and configures the VM
 * using the boxd SDK directly — Flue just adapts it.
 *
 * @example
 * ```typescript
 * import { Compute } from '@boxd-sh/sdk';
 * import { boxd } from './connectors/boxd';
 *
 * const c = new Compute({ apiKey: process.env.BOXD_API_KEY });
 * const box = await c.box.create({ name: 'my-agent' });
 * const agent = await init({ sandbox: boxd(box), model: 'anthropic/claude-sonnet-4-6' });
 * const session = await agent.session();
 * ```
 */
import { createSandboxSessionEnv } from '@flue/sdk/sandbox';
import type { SandboxApi, SandboxFactory, SessionEnv, FileStat } from '@flue/sdk/sandbox';
import type { Box as BoxdBox } from '@boxd-sh/sdk';

export interface BoxdConnectorOptions {
	cwd?: string;
	readyTimeoutMs?: number;
	cleanup?: boolean | (() => Promise<void>);
}

async function waitForReady(box: BoxdBox, timeoutMs: number): Promise<void> {
	if (timeoutMs <= 0) return;
	const deadline = Date.now() + timeoutMs;
	let lastErr: unknown;
	while (Date.now() < deadline) {
		try {
			const probe = await box.exec(['true']);
			if (probe.exitCode === 0) return;
		} catch (err) {
			lastErr = err;
		}
		await new Promise((r) => setTimeout(r, 500));
	}
	throw new Error(
		`[flue:boxd] VM ${box.name} did not become ready within ${timeoutMs}ms` +
			(lastErr ? `: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}` : ''),
	);
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

class BoxdSandboxApi implements SandboxApi {
	constructor(private box: BoxdBox) {}

	async readFile(path: string): Promise<string> {
		const bytes = await this.box.readFile(path);
		return new TextDecoder('utf-8').decode(bytes);
	}

	async readFileBuffer(path: string): Promise<Uint8Array> {
		return this.box.readFile(path);
	}

	async writeFile(path: string, content: string | Uint8Array): Promise<void> {
		await this.box.writeFile(path, content);
	}

	async stat(path: string): Promise<FileStat> {
		const result = await this.runShell(
			`stat -c '%F|%s|%Y' ${shellQuote(path)}`,
		);
		if (result.exitCode !== 0) {
			throw new Error(`[flue:boxd] stat failed for ${path}: ${result.stdout || result.stderr}`);
		}
		const [type = '', sizeStr = '0', mtimeStr = '0'] = result.stdout.trim().split('|');
		const size = Number.parseInt(sizeStr, 10);
		const mtimeSecs = Number.parseInt(mtimeStr, 10);
		return {
			isFile: type === 'regular file' || type === 'regular empty file',
			isDirectory: type === 'directory',
			isSymbolicLink: type === 'symbolic link',
			size: Number.isFinite(size) ? size : 0,
			mtime: new Date((Number.isFinite(mtimeSecs) ? mtimeSecs : 0) * 1000),
		};
	}

	async readdir(path: string): Promise<string[]> {
		const result = await this.runShell(`ls -A1 ${shellQuote(path)}`);
		if (result.exitCode !== 0) {
			throw new Error(
				`[flue:boxd] readdir failed for ${path}: ${result.stdout || result.stderr}`,
			);
		}
		return result.stdout.split('\n').filter((line) => line.length > 0);
	}

	async exists(path: string): Promise<boolean> {
		const result = await this.runShell(`test -e ${shellQuote(path)}`);
		return result.exitCode === 0;
	}

	async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
		const cmd = options?.recursive
			? `mkdir -p ${shellQuote(path)}`
			: `mkdir ${shellQuote(path)}`;
		const result = await this.runShell(cmd);
		if (result.exitCode !== 0) {
			throw new Error(`[flue:boxd] mkdir failed for ${path}: ${result.stdout || result.stderr}`);
		}
	}

	async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
		const flags: string[] = [];
		if (options?.recursive) flags.push('-r');
		if (options?.force) flags.push('-f');
		const flagStr = flags.length ? `${flags.join('')} ` : '';
		const result = await this.runShell(`rm ${flagStr}${shellQuote(path)}`);
		if (result.exitCode !== 0) {
			throw new Error(`[flue:boxd] rm failed for ${path}: ${result.stdout || result.stderr}`);
		}
	}

	async exec(
		command: string,
		options?: { cwd?: string; env?: Record<string, string>; timeout?: number },
	): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		return this.runShell(command, options);
	}

	private async runShell(
		command: string,
		options?: { cwd?: string; env?: Record<string, string>; timeout?: number },
	): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		const wrapped = options?.cwd
			? `cd ${shellQuote(options.cwd)} && ${command}`
			: command;
		const timeoutMs =
			typeof options?.timeout === 'number' ? options.timeout * 1000 : undefined;
		const result = await this.box.exec(['bash', '-lc', wrapped], {
			env: options?.env,
			timeoutMs,
		});
		return {
			stdout: result.stdout,
			stderr: result.stderr,
			exitCode: result.exitCode,
		};
	}
}

export function boxd(box: BoxdBox, options?: BoxdConnectorOptions): SandboxFactory {
	let readyPromise: Promise<void> | undefined;
	return {
		async createSessionEnv({ cwd }: { id: string; cwd?: string }): Promise<SessionEnv> {
			const sandboxCwd = cwd ?? options?.cwd ?? '/home/boxd';
			readyPromise ??= waitForReady(box, options?.readyTimeoutMs ?? 30_000);
			await readyPromise;
			const api = new BoxdSandboxApi(box);

			let cleanupFn: (() => Promise<void>) | undefined;
			if (options?.cleanup === true) {
				cleanupFn = async () => {
					try {
						await box.destroy();
					} catch (err) {
						console.error('[flue:boxd] Failed to destroy box:', err);
					}
				};
			} else if (typeof options?.cleanup === 'function') {
				cleanupFn = options.cleanup;
			}

			return createSandboxSessionEnv(api, sandboxCwd, cleanupFn);
		},
	};
}
