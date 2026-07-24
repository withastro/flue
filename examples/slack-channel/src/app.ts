import { createAgentRouter } from '@flue/runtime/routing';
import { Hono } from 'hono';
import { Assistant } from './agents/assistant.ts';
import { channel } from './channels/slack.ts';

const app = new Hono();

app.route('/agents/assistant', createAgentRouter(Assistant));
app.route('/channels/slack', channel.route());

export default app;
