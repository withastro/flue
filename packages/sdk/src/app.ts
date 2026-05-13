import { throwMigrationError } from './_migration.ts';

throwMigrationError();

export const flue = throwMigrationError;
export const registerProvider = throwMigrationError;
export const registerApiProvider = throwMigrationError;
export const configureProvider = throwMigrationError;
export const observe = throwMigrationError;

export interface Fetchable {
	fetch(request: Request, env?: unknown, ctx?: unknown): Response | Promise<Response>;
}

export interface ProviderRegistration {
	api?: unknown;
	baseUrl?: string;
	apiKey?: string;
	headers?: Record<string, string>;
}

export interface ProviderConfiguration {
	baseUrl?: string;
	apiKey?: string;
	headers?: Record<string, string>;
	storeResponses?: boolean;
}

export interface HttpProviderRegistration extends ProviderRegistration {}
export interface CloudflareAIBindingRegistration extends ProviderRegistration {
	binding?: CloudflareAIBinding;
}

export interface CloudflareAIBinding {
	run(model: string, inputs: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
}

export type FlueEventSubscriber = (event: unknown, ctx: unknown) => void | Promise<void>;
