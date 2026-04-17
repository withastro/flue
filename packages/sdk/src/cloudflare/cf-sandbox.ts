/** Wraps a @cloudflare/sandbox instance (from getSandbox()) into SessionEnv. */
import { createSandboxSessionEnv } from '../sandbox.ts';
import type { SandboxApi } from '../sandbox.ts';
import type { SessionEnv } from '../types.ts';

export async function cfSandboxToSessionEnv(
	sandbox: any,
	cwd: string = '/workspace',
): Promise<SessionEnv> {
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
				for (let i = 0; i < content.length; i++) {
					binary += String.fromCharCode(content[i]!);
				}
				const b64 = btoa(binary);
				await sandbox.writeFile(path, b64, { encoding: 'base64' });
			}
		},

		async stat(path: string) {
			const result = await sandbox.exec(
				`stat -c '{"size":%s,"isDir":%F}' '${path.replace(/'/g, "'\\''")}'`,
			);
			if (!result.success) {
				throw new Error(`stat failed for ${path}: ${result.stderr}`);
			}
			try {
				const raw = result.stdout.trim();
				const sizeMatch = raw.match(/"size":(\d+)/);
				const isDir = raw.includes('directory');
				return {
					isFile: !isDir,
					isDirectory: isDir,
					isSymbolicLink: false,
					size: sizeMatch ? parseInt(sizeMatch[1]!, 10) : 0,
					mtime: new Date(),
				};
			} catch {
				throw new Error(`Failed to parse stat output for ${path}: ${result.stdout}`);
			}
		},

		async readdir(path: string): Promise<string[]> {
			const result = await sandbox.exec(`ls -1 '${path.replace(/'/g, "'\\''")}'`);
			if (!result.success) {
				throw new Error(`readdir failed for ${path}: ${result.stderr}`);
			}
			return result.stdout
				.trim()
				.split('\n')
				.filter((s: string) => s.length > 0);
		},

		async exists(path: string): Promise<boolean> {
			const result = await sandbox.exists(path);
			return result.exists;
		},

		async mkdir(path: string, opts?: { recursive?: boolean }): Promise<void> {
			await sandbox.mkdir(path, opts);
		},

		async rm(path: string, opts?: { recursive?: boolean; force?: boolean }): Promise<void> {
			if (opts?.recursive || opts?.force) {
				const flags = [opts.recursive ? '-r' : '', opts.force ? '-f' : ''].filter(Boolean).join('');
				await sandbox.exec(`rm ${flags} '${path.replace(/'/g, "'\\''")}'`);
			} else {
				await sandbox.deleteFile(path);
			}
		},

		async exec(
			command: string,
			execOpts?: { cwd?: string; env?: Record<string, string> },
		): Promise<{ stdout: string; stderr: string; exitCode: number }> {
			const result = await sandbox.exec(command, {
				cwd: execOpts?.cwd,
				env: execOpts?.env,
			});
			return {
				stdout: result.stdout ?? '',
				stderr: result.stderr ?? '',
				exitCode: result.exitCode ?? (result.success ? 0 : 1),
			};
		},
	};

	return createSandboxSessionEnv(api, cwd);
}
