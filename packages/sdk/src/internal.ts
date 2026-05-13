import { throwMigrationError } from './_migration.ts';
import type { ModelConfig } from './types.ts';

throwMigrationError();

export interface FlueContextConfig {
	id: string;
	runId: string;
	payload: unknown;
	env: Record<string, unknown>;
}

export interface FlueContextInternal {
	id: string;
	runId: string;
}

export interface FlueRuntime {}
export type AgentHandler = (...args: unknown[]) => unknown;
export type CreateContextFn = (...args: unknown[]) => unknown;
export interface HandleAgentOptions {}
export type RunHandlerFn = (...args: unknown[]) => unknown;
export type StartWebhookFn = (...args: unknown[]) => unknown;
export interface HandleRunRouteOptions {}
export interface RunRecord {
	runId: string;
	status?: RunStatus;
}
export type RunStatus = 'active' | 'completed' | 'errored';
export interface RunStore {}
export type RunSubscriberListener = (...args: unknown[]) => unknown;
export interface RunSubscriberRegistry {}

export const createFlueContext = throwMigrationError;
export const createDurableRunStore = throwMigrationError;
export const InMemoryRunStore = class InMemoryRunStore {
	constructor() {
		throwMigrationError();
	}
};
export const configureFlueRuntime = throwMigrationError;
export const createDefaultFlueApp = throwMigrationError;
export const handleAgentRequest = throwMigrationError;
export const handleRunRouteRequest = throwMigrationError;
export const createRunSubscriberRegistry = throwMigrationError;
export const bashFactoryToSessionEnv = throwMigrationError;
export const hasRegisteredProvider = throwMigrationError;
export const InMemorySessionStore = class InMemorySessionStore {
	constructor() {
		throwMigrationError();
	}
};
export const resolveModel = (_model: ModelConfig | undefined): never => throwMigrationError();
