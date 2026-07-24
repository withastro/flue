import { createAgentRouter } from '@flue/runtime/routing';
import { Hono } from 'hono';
import { ServiceStatus } from './agents/service-status.ts';

const app = new Hono();
app.route('/agents/service-status', createAgentRouter(ServiceStatus));

export default app;
