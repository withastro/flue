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

/**
 * Normalize a tool-result content array to the UI `output` value: a lone text
 * block unwraps to its string; anything else passes through as the array.
 * Shared by the snapshot and incremental conversation projections so the two
 * cannot drift.
 */
export function toolResultOutput(content: Array<{ type: string; text?: string }>): unknown {
	if (content.length === 1 && content[0]?.type === 'text') return content[0].text;
	return content;
}

/** Join the text blocks of a tool-result content array (used for error text). */
export function toolResultText(content: Array<{ type: string; text?: string }>): string {
	return content
		.filter((block) => block.type === 'text')
		.map((block) => block.text ?? '')
		.join('\n');
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
