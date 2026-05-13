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
	exec(command: string, options?: { timeout?: number; signal?: AbortSignal }): Promise<ShellResult>;
	readFile(path: string): Promise<Uint8Array>;
	writeFile(path: string, data: Uint8Array): Promise<void>;
	readdir(path: string): Promise<string[]>;
	mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
	rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
	stat(path: string): Promise<FileStat>;
	exists(path: string): Promise<boolean>;
}

export const createSandboxSessionEnv = throwMigrationError as unknown as (
	api: SandboxApi,
	cwd: string,
) => SessionEnv;
