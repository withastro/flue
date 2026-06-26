export type RedisArgument = string | number | Uint8Array;
export type RedisCommand = (command: string, args?: RedisArgument[]) => Promise<unknown>;
export type RedisEval = (
	script: string,
	keys: string[],
	args?: RedisArgument[],
) => Promise<unknown>;
export type RedisPipeline = (
	commands: Array<{ command: string; args?: RedisArgument[] }>,
) => Promise<unknown[]>;

export interface RedisRunner {
	command: RedisCommand;
	eval: RedisEval;
	pipeline?: RedisPipeline;
	close(): void | Promise<void>;
}

export interface RedisOptions {
	keyPrefix?: string;
	inspectServer?: boolean;
}
