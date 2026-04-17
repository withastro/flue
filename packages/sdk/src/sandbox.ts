/**
 * Sandbox adapters: wraps BashLike or SandboxApi into SessionEnv.
 * Remote sandboxes don't use just-bash — commands go directly to the sandbox shell.
 */
import type { BashLike, CommandSupport, FileStat, SessionEnv, ShellResult } from './types.ts';
import { normalizePath } from './session.ts';

export type { SandboxFactory, SessionEnv, CommandDef, FileStat } from './types.ts';

export function bashToSessionEnv(bash: BashLike): SessionEnv {
	const fs = bash.fs;
	const cwd = bash.getCwd();
	const resolve = (p: string) => (p.startsWith('/') ? p : fs.resolvePath(cwd, p));

	let commandSupport: CommandSupport | undefined;
	if (typeof bash.registerCommand === 'function') {
		const registerCommand = bash.registerCommand.bind(bash);
		commandSupport = {
			register(cmd) {
				registerCommand({ name: cmd.name, execute: cmd.execute });
			},
			unregister(name) {
				registerCommand({
					name,
					execute: async () => ({
						stdout: '',
						stderr: name + ': command not available (not registered for this call)',
						exitCode: 127,
					}),
				});
			},
		};
	}

	return {
		exec: (cmd, opts) => bash.exec(cmd, opts),
		readFile: (p) => fs.readFile(resolve(p)),
		readFileBuffer: (p) => fs.readFileBuffer(resolve(p)),
		writeFile: async (p, content) => {
			const resolved = resolve(p);
			const dir = resolved.replace(/\/[^/]*$/, '');
			if (dir && dir !== resolved) {
				try {
					await fs.mkdir(dir, { recursive: true });
				} catch {
					/* parent already exists */
				}
			}
			await fs.writeFile(resolved, content);
		},
		stat: (p) => fs.stat(resolve(p)),
		readdir: (p) => fs.readdir(resolve(p)),
		exists: (p) => fs.exists(resolve(p)),
		mkdir: (p, o) => fs.mkdir(resolve(p), o),
		rm: (p, o) => fs.rm(resolve(p), o),
		cwd,
		resolvePath: resolve,
		commandSupport,
		cleanup: async () => {},
	};
}

/** Interface that remote sandbox providers must implement. */
export interface SandboxApi {
	readFile(path: string): Promise<string>;
	readFileBuffer(path: string): Promise<Uint8Array>;
	writeFile(path: string, content: string | Uint8Array): Promise<void>;
	stat(path: string): Promise<FileStat>;
	readdir(path: string): Promise<string[]>;
	exists(path: string): Promise<boolean>;
	mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
	rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
	exec(
		command: string,
		options?: { cwd?: string; env?: Record<string, string> },
	): Promise<ShellResult>;
}

/** Wrap a SandboxApi into SessionEnv. No just-bash, no intermediate filesystem layer. */
export function createSandboxSessionEnv(
	api: SandboxApi,
	cwd: string,
	cleanup?: () => Promise<void>,
): SessionEnv {
	const resolvePath = (p: string): string => {
		if (p.startsWith('/')) return normalizePath(p);
		if (cwd === '/') return normalizePath('/' + p);
		return normalizePath(cwd + '/' + p);
	};

	return {
		async exec(
			command: string,
			options?: { cwd?: string; env?: Record<string, string> },
		): Promise<ShellResult> {
			return api.exec(command, {
				cwd: options?.cwd ?? cwd,
				env: options?.env,
			});
		},

		async readFile(path: string): Promise<string> {
			return api.readFile(resolvePath(path));
		},

		async readFileBuffer(path: string): Promise<Uint8Array> {
			return api.readFileBuffer(resolvePath(path));
		},

		async writeFile(path: string, content: string | Uint8Array): Promise<void> {
			return api.writeFile(resolvePath(path), content);
		},

		async stat(path: string): Promise<FileStat> {
			return api.stat(resolvePath(path));
		},

		async readdir(path: string): Promise<string[]> {
			return api.readdir(resolvePath(path));
		},

		async exists(path: string): Promise<boolean> {
			return api.exists(resolvePath(path));
		},

		async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
			return api.mkdir(resolvePath(path), options);
		},

		async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
			return api.rm(resolvePath(path), options);
		},

		cwd,

		resolvePath,

		commandSupport: undefined,

		async cleanup(): Promise<void> {
			if (cleanup) await cleanup();
		},
	};
}
