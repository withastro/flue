import { flue, observe } from '@flue/runtime/app';
import { createGitHubChannelRouter } from '@flue/runtime/github';
import { Hono } from 'hono';

observe((event) => {
	if (event.type === 'run_start') {
		console.log(`[github-webhook-example] run_start ${event.runId ?? ''}`);
	}
	if (event.type === 'text_delta') {
		console.log(`[github-webhook-example] text_delta ${event.text}`);
	}
	if (event.type === 'run_end') {
		console.log(`[github-webhook-example] run_end ${event.runId ?? ''}`);
	}
	if (event.type === 'error') {
		console.log(`[github-webhook-example] error ${event.message}`);
	}
});

const app = new Hono();
app.route('/', flue());
app.route('/webhooks/github', createGitHubChannelRouter());

export default app;
