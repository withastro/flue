/** Example `app.ts`: compose a custom Hono app and runtime providers. */
import { configureProvider, flue, registerProvider } from '@flue/runtime/app';
import { Hono } from 'hono';

// Brand-new prefixes for local OpenAI-compatible servers.
registerProvider('ollama', {
	api: 'openai-completions',
	baseUrl: 'http://localhost:11434/v1',
});

registerProvider('lmstudio', {
	api: 'openai-completions',
	baseUrl: 'http://localhost:1234/v1',
});

// Patch a built-in provider without replacing its catalog metadata.
if (process.env.ANTHROPIC_GATEWAY_URL) {
	configureProvider('anthropic', {
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
	console.log(`[app] ${c.req.method} ${c.req.path} → ${c.res.status} (${ms}ms)`);
});

// Custom route outside Flue's agent API.
app.get('/api/ping', (c) => c.json({ pong: true, at: new Date().toISOString() }));

// Mount Flue's built-in agent route.
app.route('/', flue());

export default app;
