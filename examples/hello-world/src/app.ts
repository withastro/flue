/**
 * Example `app.ts`: the application's route map. Every agent the app serves
 * over HTTP is mounted here explicitly — `app.ts` IS the routing table.
 * Runtime providers are registered here too.
 */
import { createProvider } from '@earendil-works/pi-ai';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { setProvider } from '@flue/runtime';
import { createAgentRouter } from '@flue/runtime/routing';
import { Hono } from 'hono';
import { CompactionTest } from './agents/compaction-test.ts';
import { FsSurfaceTest } from './agents/fs-surface-test.ts';
import { FsTest } from './agents/fs-test.ts';
import { Hello } from './agents/hello.ts';
import { LocalEnvSmoke } from './agents/local-env-smoke.ts';
import { SessionTest } from './agents/session-test.ts';
import { WithAbort } from './agents/with-abort.ts';
import { WithImage } from './agents/with-image.ts';
import { WithRegisteredProvider } from './agents/with-registered-provider.ts';
import { WithRequest } from './agents/with-request.ts';
import { WithSandbox } from './agents/with-sandbox.ts';
import { WithSkill } from './agents/with-skill.ts';
import { WithSubagent } from './agents/with-subagent.ts';
import { WithThinking } from './agents/with-thinking.ts';
import { WithTools } from './agents/with-tools.ts';

// Route a catalog provider through a gateway: register your own provider
// under the built-in's ID, reusing its catalog models (cost, context window,
// wire protocol ride along) with the gateway endpoint and credential.
// (The from-scratch custom-provider demo lives in
// `./agents/with-registered-provider.ts`, so it also works under
// `flue run`, which never loads app.ts.)
if (process.env.ANTHROPIC_GATEWAY_URL) {
	const gatewayUrl = process.env.ANTHROPIC_GATEWAY_URL;
	setProvider(
		createProvider({
			id: 'anthropic',
			auth: {
				apiKey: {
					name: 'Anthropic gateway key',
					resolve: async () => ({ auth: { apiKey: process.env.ANTHROPIC_API_KEY } }),
				},
			},
			models: anthropicProvider()
				.getModels()
				.map((model) => ({ ...model, baseUrl: gatewayUrl })),
			api: anthropicMessagesApi(),
		}),
	);
}

const app = new Hono();

// Plain Hono middleware.
app.use('*', async (c, next) => {
	const started = Date.now();
	await next();
	const ms = Date.now() - started;
	console.log(`[${c.res.status}] ${c.req.method} ${c.req.path} ${ms}ms`);
});

// Custom route outside Flue's agent API.
app.get('/api/ping', (c) => c.json({ pong: true, at: new Date().toISOString() }));

// Per-agent middleware composes here, as plain Hono, before the mount it
// applies to. This one logs every request bound for `with-request` and
// requires an `authorization` header.
app.use('/agents/with-request/*', async (c, next) => {
	const request = c.req.raw;
	console.log('[with-request] method:', request.method);
	console.log('[with-request] url:', request.url);
	console.log('[with-request] user-agent:', request.headers.get('user-agent'));
	console.log('[with-request] raw body:', await request.clone().text());
	const ip =
		request.headers.get('cf-connecting-ip') ??
		request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
	console.log('[with-request] ip:', ip);
	if (!request.headers.get('authorization')) return c.json({ error: 'unauthorized' }, 401);
	await next();
});

// Mount every agent explicitly. `createAgentRouter(Fn)` builds a pure router:
// the mount path is user-chosen (these preserve the conventional
// /agents/<file-basename> addresses), and per-agent middleware composes
// above, before the mount it applies to.
app.route('/agents/compaction-test', createAgentRouter(CompactionTest));
app.route('/agents/fs-surface-test', createAgentRouter(FsSurfaceTest));
app.route('/agents/fs-test', createAgentRouter(FsTest));
app.route('/agents/hello', createAgentRouter(Hello));
app.route('/agents/local-env-smoke', createAgentRouter(LocalEnvSmoke));
app.route('/agents/session-test', createAgentRouter(SessionTest));
app.route('/agents/with-abort', createAgentRouter(WithAbort));
app.route('/agents/with-image', createAgentRouter(WithImage));
app.route('/agents/with-registered-provider', createAgentRouter(WithRegisteredProvider));
app.route('/agents/with-request', createAgentRouter(WithRequest));
app.route('/agents/with-sandbox', createAgentRouter(WithSandbox));
app.route('/agents/with-skill', createAgentRouter(WithSkill));
app.route('/agents/with-subagent', createAgentRouter(WithSubagent));
app.route('/agents/with-thinking', createAgentRouter(WithThinking));
app.route('/agents/with-tools', createAgentRouter(WithTools));

export default app;
