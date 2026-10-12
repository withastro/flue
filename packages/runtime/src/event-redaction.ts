import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { FlueEventInput, FlueObservationDetail } from './types.ts';

/**
 * Sentinel that replaces raw base64 image bytes in event payloads. Events keep
 * an image's presence and `mimeType` visible without carrying the payload
 * itself, so observers and persisted run history never retain image bytes.
 * Session history (model context) is unaffected and retains the real bytes.
 */
export const IMAGE_DATA_OMITTED = '[image data omitted from event]';

/**
 * Return `event` with raw image bytes replaced by `IMAGE_DATA_OMITTED` in
 * every message-bearing payload field.
 *
 * Copy-on-write: events without image content pass through unchanged, and
 * redaction never mutates the input. The message objects carried by these
 * events are the live objects in the agent harness state — mutating them in
 * place would corrupt the model context and persisted session history.
 */
export function redactEventImages(event: FlueEventInput): FlueEventInput {
	switch (event.type) {
		case 'message_start':
		case 'message_end': {
			const message = redactMessageImages(event.message);
			return message === event.message ? event : { ...event, message };
		}
		case 'turn_messages': {
			const message = redactMessageImages(event.message);
			const toolResults = redactEachMessageImages(event.toolResults);
			if (message === event.message && toolResults === event.toolResults) return event;
			return { ...event, message, toolResults };
		}
		case 'agent_end': {
			const messages = redactEachMessageImages(event.messages);
			return messages === event.messages ? event : { ...event, messages };
		}
		case 'tool_update':
		case 'tool': {
			const result = redactToolResultImages(event.result);
			return result === event.result ? event : { ...event, result };
		}
		default:
			return event;
	}
}

function redactMessageImages(message: AgentMessage): AgentMessage {
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return message;
	const redacted = redactContentImages(content);
	return redacted === content ? message : ({ ...message, content: redacted } as AgentMessage);
}

function redactEachMessageImages(messages: AgentMessage[]): AgentMessage[] {
	let changed = false;
	const redacted = messages.map((message) => {
		const result = redactMessageImages(message);
		if (result !== message) changed = true;
		return result;
	});
	return changed ? redacted : messages;
}

/**
 * Redact `content` blocks of an `AgentToolResult`-shaped tool result. The
 * tool-specific `details` payload is arbitrary and is passed through as-is;
 * adapter tools should not copy raw image bytes into `details`.
 */
function redactToolResultImages(result: unknown): unknown {
	if (result === null || typeof result !== 'object') return result;
	const content = (result as { content?: unknown }).content;
	if (!Array.isArray(content)) return result;
	const redacted = redactContentImages(content);
	return redacted === content ? result : { ...result, content: redacted };
}

export function redactObservationDetailImages(
	detail: FlueObservationDetail | undefined,
): FlueObservationDetail | undefined {
	if (!detail || !Object.hasOwn(detail, 'effectiveResult')) return detail;
	const effectiveResult = redactContentValueImages(detail.effectiveResult);
	return effectiveResult === detail.effectiveResult ? detail : { ...detail, effectiveResult };
}

function redactContentValueImages(value: unknown): unknown {
	if (!Array.isArray(value)) return value;
	return redactContentImages(value);
}

function redactContentImages<T>(content: T[]): T[] {
	let changed = false;
	const redacted = content.map((block) => {
		if (block === null || typeof block !== 'object') return block;
		const { type, data } = block as { type?: unknown; data?: unknown };
		if (type === 'image' && typeof data === 'string' && data !== IMAGE_DATA_OMITTED) {
			changed = true;
			return { ...block, data: IMAGE_DATA_OMITTED };
		}
		return block;
	});
	return changed ? redacted : content;
}
