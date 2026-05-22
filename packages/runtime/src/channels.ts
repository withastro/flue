import type { ChannelDefinition, WorkflowChannel } from './types.ts';

export function http(): WorkflowChannel<'http'> {
	return { type: 'http' };
}

export function websocket(): WorkflowChannel<'websocket'> {
	return { type: 'websocket' };
}

export function defineChannel<const TName extends string>(type: TName): ChannelDefinition<TName> {
	return { type };
}
