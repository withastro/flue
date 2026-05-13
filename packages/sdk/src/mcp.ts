export interface McpServerConnection {
	close(): Promise<void> | void;
}

export interface McpServerOptions {
	url?: string;
	command?: string;
	args?: string[];
	env?: Record<string, string>;
}

export type McpTransport = unknown;
