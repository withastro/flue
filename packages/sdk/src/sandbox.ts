import { throwMigrationError } from './_migration.ts';
import type { FileStat, FlueFs, SessionEnv, ShellResult, SandboxFactory } from './types.ts';

throwMigrationError();

export type { SandboxFactory, SessionEnv, FileStat } from './types.ts';

export const createFlueFs = throwMigrationError as unknown as (env: SessionEnv) => FlueFs;
export const createCwdSessionEnv = throwMigrationError as unknown as (
	parentEnv: SessionEnv,
	cwd: string,
) => SessionEnv;
export const bashFactoryToSessionEnv = throwMigrationError as unknown as (
	factory: () => unknown,
) => Promise<SessionEnv>;

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
		options?: { cwd?: string; env?: Record<string, string>; timeout?: number; signal?: AbortSignal },
	): Promise<ShellResult>;
}

export const createSandboxSessionEnv = throwMigrationError as unknown as (
	api: SandboxApi,
	cwd: string,
) => SessionEnv;
