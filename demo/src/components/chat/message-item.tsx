import type { FlueConversationMessage } from '@flue/react';
import { AlertCircle, Bot, Check, Copy, Square } from 'lucide-react';
import { useState } from 'react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Bubble, BubbleContent } from '@/components/ui/bubble';
import { Button } from '@/components/ui/button';
import { Message, MessageAvatar, MessageContent, MessageFooter } from '@/components/ui/message';
import { Marker, MarkerContent, MarkerIcon } from '@/components/ui/marker';
import { isVisiblePart } from '@/lib/parts';
import { usePreferences } from '@/state/preferences';
import { MessagePart } from './message-parts';

/**
 * A run of consecutive same-role messages rendered as one visual block. A single
 * assistant reply often spans several messages (a tool-calling turn, then an
 * answer turn); grouping gives it one avatar and one footer instead of repeating
 * them per turn.
 */
export interface MessageGroup {
	id: string;
	role: 'user' | 'assistant';
	messages: FlueConversationMessage[];
	event?: { type: 'response-aborted'; text: string };
}

/** Concatenated answer text (reasoning excluded) for the copy button. */
function answerText(messages: FlueConversationMessage[]): string {
	return messages
		.flatMap((message) => message.parts)
		.map((part) => (part.type === 'text' ? part.text : ''))
		.join('');
}

/**
 * Relative "time ago" for the reply footer, read from agent-authored message
 * metadata (`useMessageMetadata` attaching a `timestamp` ISO string is the
 * convention this demo's agents follow). Absent metadata → no label.
 */
function relativeTime(messages: FlueConversationMessage[]): string | undefined {
	const timestamp = messages
		.map((message) => message.metadata?.timestamp)
		.find((value): value is string => typeof value === 'string');
	if (!timestamp) return undefined;
	const at = Date.parse(timestamp);
	if (Number.isNaN(at)) return undefined;
	const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
	if (seconds < 60) return 'just now';
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.round(hours / 24)}d ago`;
}

function UserGroup({
	messages,
	failedById,
}: {
	messages: FlueConversationMessage[];
	failedById: Map<string, Error>;
}) {
	return (
		<Message align="end">
			<MessageContent>
				{messages.map((message) => {
					const text = message.parts
						.filter((part) => part.type === 'text')
						.map((part) => part.text)
						.join('');
					const attachments = message.parts.filter((part) => part.type !== 'text');
					const failure = failedById.get(message.id);
					return (
						<div key={message.id} className="flex flex-col items-end gap-1.5">
							{text ? (
								<Bubble align="end" className={failure ? 'border border-destructive' : undefined}>
									<BubbleContent>
										<p className="whitespace-pre-wrap break-words">{text}</p>
									</BubbleContent>
								</Bubble>
							) : null}
							{attachments.map((part, index) => (
								<MessagePart key={index} part={part} />
							))}
							{failure ? (
								<span className="flex items-center gap-1 text-xs text-destructive">
									<AlertCircle className="size-3.5" />
									Failed to send. {failure.message}
								</span>
							) : null}
						</div>
					);
				})}
			</MessageContent>
		</Message>
	);
}

function AssistantGroup({
	messages,
	event,
	settled,
}: {
	messages: FlueConversationMessage[];
	event?: MessageGroup['event'];
	settled: boolean;
}) {
	const { showThinking } = usePreferences();
	const [copied, setCopied] = useState(false);
	// Metadata is agent-authored (`useMessageMetadata`); `model` as a string is
	// the convention this demo's agents follow. Absent when the agent doesn't
	// attach it.
	const model = messages
		.map((message) => message.metadata?.model)
		.findLast((value): value is string => typeof value === 'string');
	const timeAgo = relativeTime(messages);

	const copy = async () => {
		try {
			await navigator.clipboard.writeText(answerText(messages));
			setCopied(true);
			setTimeout(() => setCopied(false), 1200);
		} catch {
			// Clipboard may be blocked; ignore.
		}
	};

	return (
		<Message align="start" className="group">
			<MessageAvatar>
				<Avatar>
					<AvatarFallback>
						<Bot className="size-4" />
					</AvatarFallback>
				</Avatar>
			</MessageAvatar>
			<MessageContent>
				<div className="min-w-0">
					{messages.flatMap((message) =>
						message.parts
							.map((part, index) => ({ part, key: `${message.id}:${index}` }))
							.filter(({ part }) => isVisiblePart(part, showThinking))
							.map(({ part, key }) => <MessagePart key={key} part={part} />),
					)}
					{event ? (
						<Marker variant="border" className="my-1.5">
							<MarkerIcon>
								<Square className="size-3.5 fill-current" />
							</MarkerIcon>
							<MarkerContent>{event.text}</MarkerContent>
						</Marker>
					) : null}
				</div>
				{/* The footer (and its hover affordance) appears only once the reply has
            settled, so streaming replies stay quiet until they're done. */}
				{settled && !event ? (
					<MessageFooter className="opacity-0 transition-opacity group-hover:opacity-100">
						<Button
							variant="ghost"
							size="sm"
							className="h-7 gap-1.5 px-2 text-xs text-muted-foreground"
							onClick={copy}
						>
							{copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
							{copied ? 'Copied' : 'Copy'}
						</Button>
						{model ? <span className="text-xs text-muted-foreground">{model}</span> : null}
						{timeAgo ? <span className="text-xs text-muted-foreground">{timeAgo}</span> : null}
					</MessageFooter>
				) : null}
			</MessageContent>
		</Message>
	);
}

export function MessageItem({
	group,
	settled,
	failedById,
}: {
	group: MessageGroup;
	settled: boolean;
	failedById: Map<string, Error>;
}) {
	return group.role === 'user' ? (
		<UserGroup messages={group.messages} failedById={failedById} />
	) : (
		<AssistantGroup messages={group.messages} event={group.event} settled={settled} />
	);
}
