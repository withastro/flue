import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { UserMessage } from '@earendil-works/pi-ai';
import type { PromptImage, SignalMessage } from './types.ts';

export function createUserContextMessage(
	text: string,
	timestamp: string,
	images: PromptImage[] = [],
): AgentMessage {
	return {
		role: 'user',
		content: [{ type: 'text', text }, ...images],
		timestamp: new Date(timestamp).getTime(),
	} as UserMessage as AgentMessage;
}

export function renderSignalMessage(message: SignalMessage): string {
	const tagName = message.tagName ?? 'signal';
	const attributes = [['type', message.type], ...Object.entries(message.attributes ?? {})]
		.map(
			([name, value]) => ` ${escapeXmlAttribute(name ?? '')}="${escapeXmlAttribute(value ?? '')}"`,
		)
		.join('');
	return `<${tagName}${attributes}>\n${escapeXmlText(message.content)}\n</${tagName}>`;
}

function escapeXmlText(value: string): string {
	return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function escapeXmlAttribute(value: string): string {
	return escapeXmlText(value).replaceAll('"', '&quot;');
}
