/**
 * The route map: every agent is mounted explicitly under /api. The UI's
 * conversation URLs (`/api/agents/<name>/<id>`) are simply this app's chosen
 * layout — the client addresses whatever URL the app mounts. Static UI assets
 * built by vite.config.ui.ts are served from dist/client (paths relative to
 * the process cwd — run the server from this directory).
 */
import { createAgentRouter } from '@flue/runtime/routing';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { Assistant } from './agents/assistant.ts';
import { Demo } from './agents/demo.ts';
import { Helper } from './agents/helper.ts';

// The offline agents register their scripted (faux) providers themselves at
// module init; helper uses a real Anthropic model via the default provider set.

const app = new Hono();

app.route('/api/agents/assistant', createAgentRouter(Assistant));
app.route('/api/agents/demo', createAgentRouter(Demo));
app.route('/api/agents/helper', createAgentRouter(Helper));

app.use('*', serveStatic({ root: './dist/client' }));
app.get('*', serveStatic({ path: './dist/client/index.html' }));

export default app;
