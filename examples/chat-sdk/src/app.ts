import { registerProvider } from '@flue/runtime';
import { flue } from '@flue/runtime/routing';
import { Hono } from 'hono';

registerProvider('chat-sdk-example', {
	api: 'chat-sdk-example',
	baseUrl: '',
});

type Env = {
	CHAT_INGRESS: DurableObjectNamespace;
};

const app = new Hono<{ Bindings: Env }>();

app.post('/webhooks/github', async (c) => {
	return getChatIngress(c.env.CHAT_INGRESS).fetch(c.req.raw);
});

app.post('/api/github/repos/:owner/:repo/issues/:issueNumber/comments', async (c) => {
	return getChatIngress(c.env.CHAT_INGRESS).fetch(c.req.raw);
});

app.get('/test/outbound-comments', (c) => getChatIngress(c.env.CHAT_INGRESS).fetch(c.req.raw));
app.route('/', flue());

export default app;

function getChatIngress(namespace: DurableObjectNamespace): DurableObjectStub {
	return namespace.get(namespace.idFromName('default'));
}
