/**
 * The app's route map.
 *
 * The entire Sentry integration lives in `./sentry.ts`, imported once here
 * for its module-scope side effects. Every agent in `src/agents/` is a plain
 * Flue agent — none of them import Sentry or know that observability is
 * happening.
 */

import './sentry.ts';

import { createAgentRouter } from '@flue/runtime/routing';
import { Hono } from 'hono';
import { Assistant } from './agents/assistant.ts';
import { Boom } from './agents/boom.ts';
import { Explicit } from './agents/explicit.ts';
import { Hello } from './agents/hello.ts';

const app = new Hono();
app.route('/agents/assistant', createAgentRouter(Assistant));
app.route('/agents/hello', createAgentRouter(Hello));
app.route('/agents/boom', createAgentRouter(Boom));
app.route('/agents/explicit', createAgentRouter(Explicit));

export default app;
