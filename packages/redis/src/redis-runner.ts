// The adapter never passes binary arguments: attachment bytes are
// base64-encoded at the store boundary, so a runner that coerces every
// argument through `String()` (the blueprint runners do) is lossless.
export type RedisArgument = string | number;
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
