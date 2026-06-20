/**
 * Daytona adapter for Flue.
 *
 * Wraps an already-initialized Daytona sandbox into Flue's SandboxFactory
 * interface. The user creates and configures the sandbox using the Daytona
 * SDK directly — Flue just adapts it.
 *
 * @example
 * ```typescript
 * import { Daytona } from '@daytona/sdk';
 * import { daytona } from './sandboxes/daytona';
 *
 * const client = new Daytona({ apiKey: process.env.DAYTONA_API_KEY });
 * const sandbox = await client.create({ image: 'ubuntu:latest' });
 * const agent = defineAgent(() => ({ sandbox: daytona(sandbox), model: 'anthropic/claude-sonnet-4-6' }));
 * export default defineWorkflow({ agent, async run({ harness }) {
 *   return await (await harness.session()).prompt('Inspect the workspace.');
 * }});
 * ```
 */

import type { Sandbox as DaytonaSandbox } from '@daytona/sdk';
import type { FileStat, SandboxApi, SandboxFactory, SessionEnv } from '@flue/runtime';
import { createSandboxSessionEnv, SandboxOperationUnsupportedError } from '@flue/runtime';

// ─── DaytonaSandboxApi ──────────────────────────────────────────────────────

/**
 * Implements SandboxApi by wrapping Daytona's TypeScript SDK.
 */
class DaytonaSandboxApi implements SandboxApi {
	constructor(private sandbox: DaytonaSandbox) {}

	async readFile(path: string): Promise<string> {
		const buffer = await this.sandbox.fs.downloadFile(path);
		return buffer.toString('utf-8');
	}

	async readFileBuffer(path: string): Promise<Uint8Array> {
		const buffer = await this.sandbox.fs.downloadFile(path);
		return new Uint8Array(buffer);
	}

	async writeFile(path: string, content: string | Uint8Array): Promise<void> {
		const buffer =
			typeof content === 'string' ? Buffer.from(content, 'utf-8') : Buffer.from(content);
		await this.sandbox.fs.uploadFile(buffer, path);
	}

	async stat(path: string): Promise<FileStat> {
		const info = await this.sandbox.fs.getFileDetails(path);
		// The Daytona SDK does not expose symlink information; omit unknown
		// fields rather than fabricating values.
		const stat: FileStat = {
			isFile: !info.isDir,
			isDirectory: info.isDir ?? false,
		};
		if (info.size !== undefined) stat.size = info.size;
		if (info.modTime) stat.mtime = new Date(info.modTime);
		return stat;
	}

	async readdir(path: string): Promise<string[]> {
		const entries = await this.sandbox.fs.listFiles(path);
		return entries.map((e) => e.name).filter((name): name is string => !!name);
	}

	async exists(path: string): Promise<boolean> {
		try {
			await this.sandbox.fs.getFileDetails(path);
			return true;
		} catch {
			return false;
		}
	}

	async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
		if (options?.recursive) {
			await this.exec(`mkdir -p '${path.replace(/'/g, "'\\''")}'`);
			return;
		}
		await this.sandbox.fs.createFolder(path, '755');
	}

	async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
		if (options?.force) {
			throw new SandboxOperationUnsupportedError({
				operation: 'rm',
				provider: 'Daytona',
				options: ['force'],
			});
		}
		await this.sandbox.fs.deleteFile(path, options?.recursive);
	}

	async exec(
		command: string,
		options?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number },
	): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		// Daytona's executeCommand timeout is in seconds. Round up so the
		// provider deadline is never shorter than the requested one.
		const timeoutSeconds =
			options?.timeoutMs === undefined ? undefined : Math.ceil(options.timeoutMs / 1000);
		const response = await this.sandbox.process.executeCommand(
			command,
			options?.cwd,
			options?.env,
			timeoutSeconds,
		);
		return {
			stdout: response.result ?? '',
			stderr: '',
			exitCode: response.exitCode ?? 0,
		};
	}
}

// ─── Sandbox Adapter ────────────────────────────────────────────────────────

/**
 * Create a Flue sandbox factory from an initialized Daytona sandbox.
 *
 * The user creates the sandbox using the Daytona SDK directly, then
 * passes it here. Flue wraps it into a SessionEnv for agent use.
 *
 * @param sandbox - An initialized Daytona Sandbox instance.
 */
export function daytona(sandbox: DaytonaSandbox): SandboxFactory {
	return {
		async createSessionEnv(): Promise<SessionEnv> {
			const sandboxCwd = (await sandbox.getWorkDir()) ?? '/home/daytona';
			const api = new DaytonaSandboxApi(sandbox);
			return createSandboxSessionEnv(api, sandboxCwd);
		},
	};
}
