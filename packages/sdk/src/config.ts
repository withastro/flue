import { throwMigrationError } from './_migration.ts';

throwMigrationError();

export interface UserFlueConfig {
	target?: 'node' | 'cloudflare';
	root?: string;
	output?: string;
}

export interface FlueConfig {
	target: 'node' | 'cloudflare';
	root: string;
	output: string;
}

export interface ResolveConfigPathOptions {
	cwd: string;
	configFile?: string | false;
}

export interface ResolveConfigOptions {
	cwd: string;
	searchFrom?: string;
	configFile?: string | false;
	inline?: UserFlueConfig;
}

export interface ResolvedConfigResult {
	configPath: string | undefined;
	userConfig: UserFlueConfig;
	flueConfig: FlueConfig;
}

export const defineConfig = ((config: UserFlueConfig) => config) as (
	config: UserFlueConfig,
) => UserFlueConfig;
export const resolveConfigPath = throwMigrationError as unknown as (
	opts: ResolveConfigPathOptions,
) => string | undefined;
export const resolveConfig = throwMigrationError as unknown as (
	opts: ResolveConfigOptions,
) => Promise<ResolvedConfigResult>;
