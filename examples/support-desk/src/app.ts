import { createAgentRouter } from '@flue/runtime/routing';
import { Hono } from 'hono';
import { Support } from './agents/support.ts';

const app = new Hono();
app.route('/agents/support', createAgentRouter(Support));

export default app;
