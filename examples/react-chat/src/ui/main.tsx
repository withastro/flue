import {
	FlueProvider,
	type UIMessagePart,
	useFlueAgent,
	useFlueClient,
	useFlueWorkflow,
} from '@flue/react';
import { createFlueClient } from '@flue/sdk';
import { type FormEvent, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const client = createFlueClient({ baseUrl: '/api' });

function App() {
	const [input, setInput] = useState('');
	const [instanceId] = useState(() => crypto.randomUUID());
	const [runId, setRunId] = useState<string>();
	const [actionError, setActionError] = useState<string>();
	const agent = useFlueAgent({ name: 'assistant', id: instanceId });
	const workflow = useFlueWorkflow({ runId });
	const flue = useFlueClient();

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

	async function triggerWorkflow() {
		setActionError(undefined);
		try {
			const result = await flue.workflows.invoke('demo', {
				payload: { requestedAt: new Date().toISOString() },
			});
			setRunId(result.runId);
		} catch (error) {
			setActionError(error instanceof Error ? error.message : String(error));
		}
	}

	return (
		<main>
			<header>
				<p className="eyebrow">Flue React hooks</p>
				<h1>Chat and workflow test bed</h1>
			</header>
			<section>
				<div className="section-heading">
					<h2>Agent chat</h2>
					<span className={`status ${agent.status}`}>{agent.status}</span>
				</div>
				<div className="messages" aria-live="polite">
					{agent.messages.length === 0 && <p className="empty">Send a message to begin.</p>}
					{agent.messages.map((message) => (
						<article className={`message ${message.role}`} key={message.id}>
							<strong>{message.role}</strong>
							{message.parts.map((part) => (
								<MessagePart key={partKey(part)} part={part} />
							))}
						</article>
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
					<h2>Workflow</h2>
					<span className={`status ${workflow.status}`}>{workflow.status}</span>
				</div>
				<button onClick={triggerWorkflow} type="button">
					Trigger demo workflow
				</button>
				<div className="logs" aria-live="polite">
					{workflow.logs.length === 0 && <p className="empty">Workflow logs appear here.</p>}
					{workflow.logs.map((log) => (
						<div className="log" key={`${log.timestamp}-${log.eventIndex}`}>
							<time>{new Date(log.timestamp).toLocaleTimeString()}</time>
							<span>{log.message}</span>
						</div>
					))}
				</div>
			</section>
			{(actionError || agent.error) && (
				<p className="error">{actionError ?? agent.error?.message}</p>
			)}
		</main>
	);
}

function MessagePart({ part }: { part: UIMessagePart }) {
	if (part.type === 'text') return <p>{part.text}</p>;
	if (part.type === 'reasoning')
		return (
			<details>
				<summary>Reasoning</summary>
				{part.text}
			</details>
		);
	if (part.type === 'file') return <a href={part.url}>Attachment</a>;
	return (
		<pre>
			{part.toolName}: {part.state}
		</pre>
	);
}

function partKey(part: UIMessagePart): string {
	if (part.type === 'dynamic-tool') return `tool:${part.toolCallId}`;
	if (part.type === 'file') return `file:${part.mediaType}:${part.url}`;
	return `${part.type}:${part.text}`;
}

const root = document.getElementById('root');
if (!root) throw new Error('Missing React root element');

createRoot(root).render(
	<FlueProvider client={client}>
		<App />
	</FlueProvider>,
);
