import { throwMigrationError } from '../_migration.ts';

throwMigrationError();

export interface VirtualSandboxOptions {
	id?: string;
}

export interface CloudflareContext {
	env?: unknown;
	ctx?: unknown;
}

export interface CloudflareGatewayOptions {
	id: string;
	skipCache?: boolean;
	cacheTtl?: number;
	cacheKey?: string;
}

export const getVirtualSandbox = throwMigrationError;
export const cfSandboxToSessionEnv = throwMigrationError;
export const store = null;
export const runWithCloudflareContext = throwMigrationError;
export const getCloudflareContext = throwMigrationError;
export const getCloudflareAIBindingApiProvider = throwMigrationError;
