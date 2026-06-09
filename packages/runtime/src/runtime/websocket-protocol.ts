import { InvalidRequestError, toPublicError } from '../errors.ts';
import type {
	AgentWebSocketClientMessage,
	WebSocketErrorMessage,
	WorkflowRunWebSocketErrorMessage,
	WorkflowWebSocketClientMessage,
} from '../types.ts';

export function parseAgentWebSocketMessage(raw: string): AgentWebSocketClientMessage {
	const value = parseObject(raw);
	if (value.version !== 1 || (value.type !== 'prompt' && value.type !== 'ping')) {
		throw new InvalidRequestError({
			reason: 'Agent WebSocket messages must use protocol version 1 and type "prompt" or "ping".',
		});
	}
	if (value.type === 'ping') {
		if (value.requestId !== undefined && !isNonBlankString(value.requestId)) {
			throw new InvalidRequestError({
				reason: 'Agent WebSocket ping requestId must be a string when provided.',
			});
		}
		return { version: 1, type: 'ping', requestId: value.requestId as string | undefined };
	}
	if (!isNonBlankString(value.requestId) || typeof value.message !== 'string') {
		throw new InvalidRequestError({
			reason: 'Agent WebSocket prompt messages require string requestId and message values.',
		});
	}
	return {
		version: 1,
		type: 'prompt',
		requestId: value.requestId,
		message: value.message,
	};
}

export function parseWorkflowWebSocketMessage(raw: string): WorkflowWebSocketClientMessage {
	const value = parseObject(raw);
	if (value.version !== 1 || value.type !== 'invoke' || !isNonBlankString(value.requestId)) {
		throw new InvalidRequestError({
			reason:
				'Workflow WebSocket messages require protocol version 1, type "invoke", and a string requestId.',
		});
	}
	return {
		version: 1,
		type: 'invoke',
		requestId: value.requestId,
		payload: value.payload === undefined ? {} : value.payload,
	};
}

export function createWebSocketErrorMessage(
	error: unknown,
	requestId?: string,
	runId?: string,
): WebSocketErrorMessage | WorkflowRunWebSocketErrorMessage {
	return runId === undefined
		? { version: 1, type: 'error', requestId, error: toPublicError(error) }
		: { version: 1, type: 'error', requestId, runId, error: toPublicError(error) };
}

function isNonBlankString(value: unknown): value is string {
	return typeof value === 'string' && value.trim() !== '';
}

function parseObject(raw: string): Record<string, unknown> {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new InvalidRequestError({ reason: 'WebSocket messages must be valid JSON objects.' });
	}
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new InvalidRequestError({ reason: 'WebSocket messages must be valid JSON objects.' });
	}
	return value as Record<string, unknown>;
}
