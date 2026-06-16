/** Example `app.ts`: compose a custom Hono app and runtime providers. */
import { registerProvider } from '@flue/runtime';
import { flue } from '@flue/runtime/routing';
import { Hono } from 'hono';

// Brand-new provider IDs for local OpenAI-compatible servers.
registerProvider('ollama', {
	api: 'openai-completions',
	baseUrl: 'http://localhost:11434/v1',
});

registerProvider('lmstudio', {
	api: 'openai-completions',
	baseUrl: 'http://localhost:1234/v1',
});

// Route a catalog provider through a gateway. Catalog metadata (cost,
// context window, wire protocol) is preserved; these options layer on top.
if (process.env.ANTHROPIC_GATEWAY_URL) {
	registerProvider('anthropic', {
		baseUrl: process.env.ANTHROPIC_GATEWAY_URL,
		apiKey: process.env.ANTHROPIC_API_KEY,
	});
}

const app = new Hono();

// Plain Hono middleware.
app.use('*', async (c, next) => {
	const started = Date.now();
	await next();
	const ms = Date.now() - started;
	console.log(`app: ${c.req.method} ${c.req.path} → ${c.res.status} (${ms}ms)`);
});

// Custom route outside Flue's agent API.
app.get('/api/ping', (c) => c.json({ pong: true, at: new Date().toISOString() }));

// Mount Flue's built-in agent route.
app.route('/', flue());

// To expose deployment-inspection endpoints, compose them from the
// `listRuns`/`getRun`/`listAgents` primitives exported by `@flue/runtime`,
// behind your own auth middleware:
// app.use('/admin/*', myAuthMiddleware);
// app.get('/admin/agents', async (c) => c.json(await listAgents()));
// app.get('/admin/runs', async (c) => c.json(await listRuns({ limit: 100 })));

export default app;
