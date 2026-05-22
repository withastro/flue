import type { ChannelDefinition } from './types.ts';

export function defineChannel<const TName extends string>(type: TName): ChannelDefinition<TName> {
	return { type };
}
