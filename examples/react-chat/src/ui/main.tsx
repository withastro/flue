import { type FlueConversationMessage, type FlueConversationPart, useFlueAgent } from '@flue/react';
import { type FormEvent, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

function App() {
	const [input, setInput] = useState('');
	const [conversationId] = useState(() => crypto.randomUUID());
	const [demoId] = useState(() => crypto.randomUUID());
	const [actionError, setActionError] = useState<string>();
	// A conversation is addressed by URL: the mount path app.ts chose for the
	// agent (`app.route('/api/agents/assistant', ...)`) plus a caller-chosen
	// conversation id. Relative URLs resolve against the browser origin.
	const agent = useFlueAgent({ url: `/api/agents/assistant/${conversationId}` });
	const demo = useFlueAgent({ url: `/api/agents/demo/${demoId}` });

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const message = input.trim();
		if (!message) return;
		setInput('');
		setActionError(undefined);
		try {
			await agent.sendMessage(message);
		} catch (error) {
			setInput(message);
			setActionError(error instanceof Error ? error.message : String(error));
		}
	}

	// The old "trigger demo workflow" button. Workflows are gone: the demo is
	// an agent whose deterministic job is a model-callable action, so a run is
	// just a message into the demo conversation — its tool call, action logs,
	// and final reply stream back like any other agent turn.
	async function triggerDemo() {
		setActionError(undefined);
		try {
			await demo.sendMessage(`Run the demo action. requestedAt: ${new Date().toISOString()}`);
		} catch (error) {
			setActionError(error instanceof Error ? error.message : String(error));
		}
	}

	return (
		<main>
			<header>
				<p className="eyebrow">Flue React hooks</p>
				<h1>Chat and background-action test bed</h1>
			</header>
			<section>
				<div className="section-heading">
					<h2>Agent chat</h2>
					<span className={`status ${agent.status}`}>{agent.status}</span>
				</div>
				<div className="messages" aria-live="polite">
					{agent.messages.length === 0 && <p className="empty">Send a message to begin.</p>}
					{agent.messages.map((message) => (
						<Message key={message.id} message={message} />
					))}
				</div>
				<form onSubmit={submit}>
					<input
						aria-label="Message"
						autoComplete="off"
						onChange={(event) => setInput(event.target.value)}
						placeholder="Say hello"
						value={input}
					/>
					<button disabled={!input.trim()} type="submit">
						Send
					</button>
				</form>
			</section>
			<section>
				<div className="section-heading">
					<h2>Demo agent (background action)</h2>
					<span className={`status ${demo.status}`}>{demo.status}</span>
				</div>
				<button onClick={triggerDemo} type="button">
					Run demo action
				</button>
				<div className="messages" aria-live="polite">
					{demo.messages.length === 0 && (
						<p className="empty">The demo conversation appears here.</p>
					)}
					{demo.messages.map((message) => (
						<Message key={message.id} message={message} />
					))}
				</div>
			</section>
			{(actionError || agent.error || demo.error) && (
				<p className="error">{actionError ?? (agent.error ?? demo.error)?.message}</p>
			)}
		</main>
	);
}

function Message({ message }: { message: FlueConversationMessage }) {
	return (
		<article className={`message ${message.role}`}>
			<strong>{message.role}</strong>
			{message.parts.map((part, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: parts are append-only within a message, so position is a stable identity (content-based keys collide when steps repeat text)
				<MessagePart key={`${index}:${partKey(part)}`} part={part} />
			))}
		</article>
	);
}

function MessagePart({ part }: { part: FlueConversationPart }) {
	if (part.type === 'text') return <p>{part.text}</p>;
	if (part.type === 'reasoning')
		return (
			<details>
				<summary>Reasoning</summary>
				{part.text}
			</details>
		);
	if (part.type === 'file') {
		if (!part.url) return <span>Attachment ({part.mediaType})</span>;
		return part.mediaType.startsWith('image/') ? (
			<img src={part.url} alt={part.filename ?? 'attachment'} style={{ maxWidth: 240 }} />
		) : (
			<a href={part.url}>{part.filename ?? 'Attachment'}</a>
		);
	}
	if (part.type === 'dynamic-tool') {
		return (
			<pre>
				{part.toolName}: {part.state}
			</pre>
		);
	}
	return <pre className="data-part">{JSON.stringify(part.data)}</pre>;
}

function partKey(part: FlueConversationPart): string {
	if (part.type === 'dynamic-tool') return `tool:${part.toolCallId}`;
	if (part.type === 'file') return `file:${part.id ?? part.url ?? part.mediaType}`;
	if (part.type === 'text' || part.type === 'reasoning') return `${part.type}:${part.text}`;
	return part.type;
}

const root = document.getElementById('root');
if (!root) throw new Error('Missing React root element');

createRoot(root).render(<App />);
