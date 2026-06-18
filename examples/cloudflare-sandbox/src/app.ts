import { flue } from '@flue/runtime/routing';
import { Hono } from 'hono';

const app = new Hono();

app.get('/api/ping', (c) => c.json({ pong: true, at: new Date().toISOString() }));
app.route('/', flue());

export default app;
