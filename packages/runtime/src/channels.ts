import type { ChannelDefinition, WorkflowChannel } from './types.ts';

export function http(): WorkflowChannel<'http'> {
	return { __flueChannel: true, name: 'http' };
}

export function websocket(): WorkflowChannel<'websocket'> {
	return { __flueChannel: true, name: 'websocket' };
}

export function defineChannel<const TName extends string>(type: TName): ChannelDefinition<TName> {
	return { __flueChannel: true, name: type };
}
