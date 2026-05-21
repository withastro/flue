import type { WorkflowChannel } from './types.ts';

export function http(): WorkflowChannel<'http'> {
	return { type: 'http' };
}

export function websocket(): WorkflowChannel<'websocket'> {
	return { type: 'websocket' };
}
