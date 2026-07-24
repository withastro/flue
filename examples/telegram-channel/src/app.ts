import { createAgentRouter } from '@flue/runtime/routing';
import { Hono } from 'hono';
import { Assistant } from './agents/assistant.ts';
import { channel } from './channels/telegram.ts';

const app = new Hono();

app.route('/agents/assistant', createAgentRouter(Assistant));
app.route('/channels/telegram', channel.route());

export default app;
