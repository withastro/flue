/** Wraps a @cloudflare/sandbox instance (from getSandbox()) into SessionEnv. */
import { abortErrorFor } from '../abort.ts';
import { SandboxOperationUnsupportedError } from '../errors.ts';
import type { SandboxApi } from '../sandbox.ts';
import { createSandboxSessionEnv } from '../sandbox.ts';
import type { SandboxFactory, SessionEnv } from '../types.ts';

/**
 * Minimal structural surface of a `@cloudflare/sandbox` Durable Object stub
 * (the value returned by `getSandbox()`). Kept structural so `@flue/runtime`
 * does not depend on `@cloudflare/sandbox` and stays importable on Node;
 * only the methods Flue calls are listed. A wrong object fails loudly on
 * the first method call.
 */
export interface CloudflareSandboxStub {
	exec(
		command: string,
		options?: {
			cwd?: string;
			env?: Record<string, string>;
			timeout?: number;
		},
	): Promise<{ success: boolean; stdout: string; stderr: string; exitCode?: number }>;
	readFile(path: string, options?: { encoding?: string }): Promise<{ content: string }>;
	writeFile(path: string, content: string, options?: { encoding?: string }): Promise<unknown>;
	exists(path: string): Promise<{ exists: boolean }>;
	mkdir(path: string, options?: { recursive?: boolean }): Promise<unknown>;
	deleteFile(path: string): Promise<unknown>;
}

export interface CloudflareSandboxOptions {
	/** Working directory inside the container. Defaults to `/workspace`. */
	cwd?: string;
}

/**
 * Wrap a Cloudflare Sandbox Durable Object stub into a Flue
 * {@link SandboxFactory}:
 *
 * ```ts
 * import { getSandbox } from '@cloudflare/sandbox';
 * import { cloudflareSandbox } from '@flue/runtime/cloudflare';
 *
 * export default createAgent(({ id, env }) => ({
 *   sandbox: cloudflareSandbox(getSandbox(env.Sandbox, id)),
 * }));
 * ```
 */
export function cloudflareSandbox(
	sandbox: CloudflareSandboxStub,
	options?: CloudflareSandboxOptions,
): SandboxFactory {
	return {
		createSessionEnv: async () => cfSandboxToSessionEnv(sandbox, options?.cwd),
	};
}

export function cfSandboxToSessionEnv(
	sandbox: CloudflareSandboxStub,
	cwd: string = '/workspace',
): SessionEnv {
	const api: SandboxApi = {
		async readFile(path: string): Promise<string> {
			const file = await sandbox.readFile(path);
			return file.content;
		},

		async readFileBuffer(path: string): Promise<Uint8Array> {
			const file = await sandbox.readFile(path, { encoding: 'base64' });
			const binary = atob(file.content);
			const bytes = new Uint8Array(binary.length);
			for (let i = 0; i < binary.length; i++) {
				bytes[i] = binary.charCodeAt(i);
			}
			return bytes;
		},

		async writeFile(path: string, content: string | Uint8Array): Promise<void> {
			if (typeof content === 'string') {
				await sandbox.writeFile(path, content);
			} else {
				let binary = '';
				for (const byte of content) {
					binary += String.fromCharCode(byte);
				}
				const b64 = btoa(binary);
				await sandbox.writeFile(path, b64, { encoding: 'base64' });
			}
		},

		async stat(path: string) {
			const quoted = `'${path.replace(/'/g, "'\\''")}'`;
			// `stat -L` follows symlinks so isFile/isDirectory/size/mtime match
			// fs.stat semantics on the node target; the second (non-following)
			// stat reports whether the path itself is a symlink.
			const result = await sandbox.exec(
				`stat -L -c '%s/%Y/%F' ${quoted} && stat -c '%F' ${quoted}`,
			);
			if (!result.success) {
				throw new Error(`stat failed for ${path}: ${result.stderr}`);
			}
			const [target = '', self = ''] = (result.stdout ?? '').trim().split('\n');
			const [size = '0', mtime = '0', type = ''] = target.split('/');
			return {
				isFile: type.includes('regular'),
				isDirectory: type === 'directory',
				isSymbolicLink: self.trim() === 'symbolic link',
				size: parseInt(size, 10),
				mtime: new Date(parseInt(mtime, 10) * 1000),
			};
		},

		async readdir(path: string): Promise<string[]> {
			// NUL-separated `find` includes dotfiles (unlike plain `ls`) and
			// survives filenames containing newlines.
			const result = await sandbox.exec(
				`find '${path.replace(/'/g, "'\\''")}' -mindepth 1 -maxdepth 1 -printf '%f\\0'`,
			);
			if (!result.success) {
				throw new Error(`readdir failed for ${path}: ${result.stderr}`);
			}
			return result.stdout.split('\0').filter((s: string) => s.length > 0);
		},

		async exists(path: string): Promise<boolean> {
			const result = await sandbox.exists(path);
			return result.exists;
		},

		async mkdir(path: string, opts?: { recursive?: boolean }): Promise<void> {
			await sandbox.mkdir(path, opts);
		},

		async rm(path: string, opts?: { recursive?: boolean; force?: boolean }): Promise<void> {
			const unsupported = [
				opts?.recursive ? 'recursive' : undefined,
				opts?.force ? 'force' : undefined,
			].filter((option): option is string => option !== undefined);
			if (unsupported.length > 0) {
				throw new SandboxOperationUnsupportedError({
					operation: 'rm',
					provider: 'Cloudflare Sandbox',
					options: unsupported,
				});
			}
			await sandbox.deleteFile(path);
		},

		async exec(
			command: string,
			execOpts?: {
				cwd?: string;
				env?: Record<string, string>;
				timeoutMs?: number;
				signal?: AbortSignal;
			},
		): Promise<{ stdout: string; stderr: string; exitCode: number }> {
			const externalSignal = execOpts?.signal;
			if (externalSignal?.aborted) throw abortErrorFor(externalSignal);

			// Cloudflare Sandbox does not currently accept AbortSignal across the
			// getSandbox(...).exec(...) RPC boundary. Keep cancellation local while
			// forwarding cloneable execution options to the sandbox.
			const result = await sandbox.exec(command, {
				cwd: execOpts?.cwd,
				env: execOpts?.env,
				// The Cloudflare sandbox `timeout` option is in milliseconds.
				timeout: execOpts?.timeoutMs,
			});

			if (externalSignal?.aborted) throw abortErrorFor(externalSignal);

			return {
				stdout: result.stdout ?? '',
				stderr: result.stderr ?? '',
				exitCode: result.exitCode ?? (result.success ? 0 : 1),
			};
		},
	};

	return createSandboxSessionEnv(api, cwd);
}
