import { Hono } from 'hono';
import { Assistant } from './agents/assistant.ts';
import { bot, registerChatHandlers } from './chat.ts';

// The scripted (faux) provider registers itself in ./agents/assistant.ts at
// module scope, so it also applies under `flue run`.
registerChatHandlers(Assistant);

const app = new Hono();
const outboundComments: Array<{ issueNumber: number; body: string }> = [];

app.post('/webhooks/github', (c) =>
	bot.webhooks.github(c.req.raw, {
		waitUntil: (task) => {
			try {
				c.executionCtx.waitUntil(task);
			} catch {
				void task;
			}
		},
	}),
);

app.post('/api/github/repos/:owner/:repo/issues/:issueNumber/comments', async (c) => {
	const issueNumber = Number(c.req.param('issueNumber'));
	const payload = await c.req.json<{ body?: string }>();
	const body = typeof payload.body === 'string' ? payload.body : '';
	outboundComments.push({ issueNumber, body });
	return c.json({
		id: outboundComments.length,
		body,
		user: { id: 1, login: 'flue-bot', type: 'Bot' },
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
	});
});

app.get('/test/outbound-comments', (c) => c.json(outboundComments));

// The assistant agent is intentionally NOT mounted: it is dispatch-only.
// The use-agent directive (via the build-time scan) is what registers an
// agent with the app, so `dispatch(Assistant, ...)` in chat.ts reaches it
// with no HTTP route at all. Mounting would be one extra line —
// `app.route('/agents/assistant', createAgentRouter(Assistant))` — but this
// webhook pipeline never exposes the agent over HTTP, so it stays private.

export default app;
