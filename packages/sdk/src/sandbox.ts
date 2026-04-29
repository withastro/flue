/**
 * Sandbox adapters: wraps BashFactory or SandboxApi into SessionEnv.
 * Remote sandboxes don't use just-bash — commands go directly to the sandbox shell.
 */
import type { BashFactory, BashLike, Command, FileStat, SessionEnv, ShellResult } from './types.ts';
import { normalizePath } from './session.ts';

export type { SandboxFactory, SessionEnv, CommandDef, FileStat } from './types.ts';

export function createCwdSessionEnv(parentEnv: SessionEnv, cwd: string): SessionEnv {
	const scopedCwd = normalizePath(cwd);
	const resolvePath = (p: string): string => {
		if (p.startsWith('/')) return normalizePath(p);
		if (scopedCwd === '/') return normalizePath('/' + p);
		return normalizePath(scopedCwd + '/' + p);
	};

	return {
		exec: (cmd, opts) => parentEnv.exec(cmd, { cwd: opts?.cwd ?? scopedCwd, env: opts?.env }),
		scope: async (options) => createCwdSessionEnv(await scopeEnv(parentEnv, options?.commands ?? []), scopedCwd),
		readFile: (p) => parentEnv.readFile(resolvePath(p)),
		readFileBuffer: (p) => parentEnv.readFileBuffer(resolvePath(p)),
		writeFile: (p, c) => parentEnv.writeFile(resolvePath(p), c),
		stat: (p) => parentEnv.stat(resolvePath(p)),
		readdir: (p) => parentEnv.readdir(resolvePath(p)),
		exists: (p) => parentEnv.exists(resolvePath(p)),
		mkdir: (p, o) => parentEnv.mkdir(resolvePath(p), o),
		rm: (p, o) => parentEnv.rm(resolvePath(p), o),
		cwd: scopedCwd,
		resolvePath,
		cleanup: () => parentEnv.cleanup(),
	};
}

async function scopeEnv(env: SessionEnv, commands: Command[]): Promise<SessionEnv> {
	if (env.scope) return env.scope({ commands });
	if (commands.length > 0) {
		throw new Error(
			'[flue] Cannot use commands: this environment does not support scoped command execution. ' +
				'Commands are only available in BashFactory sandbox mode. ' +
				'Remote sandboxes handle command execution at the platform level.',
		);
	}
	return env;
}

export async function bashFactoryToSessionEnv(factory: BashFactory): Promise<SessionEnv> {
	const seen = new WeakSet<object>();

	async function createBash(): Promise<BashLike> {
		const bash = await factory();
		assertBashLike(bash);
		if (seen.has(bash)) {
			throw new Error(
				'[flue] BashFactory must return a fresh Bash-like instance for each operation. ' +
					'Share the filesystem object in the factory closure to persist files across calls.',
			);
		}
		seen.add(bash);
		return bash;
	}

	async function createScopedEnv(commands: Command[]): Promise<SessionEnv> {
		const scoped = await createBash();
		registerCommands(scoped, commands);
		return createBashSessionEnv(scoped, createScopedEnv);
	}

	const base = await createBash();
	return createBashSessionEnv(base, createScopedEnv);
}

function createBashSessionEnv(
	bash: BashLike,
	createScope: (commands: Command[]) => Promise<SessionEnv>,
): SessionEnv {
	const fs = bash.fs;
	const cwd = bash.getCwd();
	const resolve = (p: string) => (p.startsWith('/') ? p : fs.resolvePath(cwd, p));

	return {
		exec: (cmd, opts) => bash.exec(cmd, opts),
		scope: (options) => createScope(options?.commands ?? []),
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
		cleanup: async () => {},
	};
}

function registerCommands(bash: BashLike, commands: Command[]): void {
	if (commands.length === 0) return;
	if (typeof bash.registerCommand !== 'function') {
		throw new Error(
			'[flue] Cannot use commands: this Bash-like sandbox does not support command registration.',
		);
	}
	for (const cmd of commands) {
		bash.registerCommand({ name: cmd.name, execute: cmd.execute });
	}
}

function assertBashLike(value: unknown): asserts value is BashLike {
	if (
		typeof value !== 'object' ||
		value === null ||
		!('exec' in value) ||
		!('getCwd' in value) ||
		!('fs' in value) ||
		typeof (value as any).exec !== 'function' ||
		typeof (value as any).getCwd !== 'function' ||
		typeof (value as any).fs !== 'object'
	) {
		throw new Error('[flue] BashFactory must return a Bash-like object.');
	}
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

		async cleanup(): Promise<void> {
			if (cleanup) await cleanup();
		},
	};
}
