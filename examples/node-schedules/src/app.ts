import { dispatch } from '@flue/runtime';
import { flue } from '@flue/runtime/routing';
import { Cron } from 'croner';
import { Hono } from 'hono';
import scheduledAgent from './agents/scheduled.ts';

const app = new Hono();
app.route('/', flue());

new Cron(
	process.env.AGENT_SCHEDULE ?? '0 9 * * *',
	{
		protect: true,
		timezone: process.env.SCHEDULE_TIMEZONE ?? 'UTC',
		catch: (error) => console.error('Scheduled agent admission failed', error),
	},
	async () => {
		await dispatch(scheduledAgent, {
			id: 'daily-summary',
			input: {
				type: 'schedule',
				prompt: 'Review recent activity and prepare the daily summary.',
				scheduledAt: new Date().toISOString(),
			},
		});
	},
);

new Cron(
	process.env.WORKFLOW_SCHEDULE ?? '0 10 * * *',
	{
		protect: true,
		timezone: process.env.SCHEDULE_TIMEZONE ?? 'UTC',
		catch: (error) => console.error('Scheduled workflow admission failed', error),
	},
	async () => {
		const response = await app.request('/workflows/scheduled', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				prompt: 'Review recent activity and return the daily summary.',
				scheduledAt: new Date().toISOString(),
			}),
		});
		if (!response.ok) throw new Error(`Scheduled workflow was not admitted: ${response.status}`);
	},
);

export default app;
