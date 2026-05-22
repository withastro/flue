import { defineAgent, type Delivery, type ReceiveContext, type AgentInitContext } from '@flue/runtime';
import { channel as github } from '../channels/github';

export const channels = [github()];

const triage = defineAgent({
	model: 'anthropic/claude-haiku-4-5',
	instructions: `
You triage inbound GitHub webhook events.
Summarize the event, identify the repository and actor, and suggest the next useful action.
Do not attempt to post back to GitHub; outbound actions are not part of this example.
`,
});

export async function receive({ delivery, dispatch }: ReceiveContext) {
	console.log(`[github-triage] receive ${delivery.type} ${delivery.id}`);
	if (delivery.type !== 'issues' && delivery.type !== 'pull_request') return;
	const refs = githubRefs(delivery);
	if (!refs.repository) return;

	await dispatch({
		id: `repo:${refs.repository}`,
		session: refs.thread ? `${delivery.type}:${refs.thread}` : `delivery:${delivery.id}`,
		input: {
			type: `github.${delivery.type}`,
			deliveryId: delivery.id,
			action: refs.action,
			repository: refs.repository,
			thread: refs.thread,
			title: refs.title,
			url: refs.url,
			sender: refs.sender,
		},
	});
}

export async function init({ id, spawn }: AgentInitContext) {
	console.log(`[github-triage] init ${id}`);
	return spawn({
		inherit: triage,
	});
}

function githubRefs(delivery: Delivery) {
	const data = delivery.data as { payload?: Record<string, any>; action?: string };
	const payload = data.payload ?? {};
	const issue = payload.issue as Record<string, any> | undefined;
	const pullRequest = payload.pull_request as Record<string, any> | undefined;
	const item = issue ?? pullRequest;
	const repository = payload.repository as Record<string, any> | undefined;
	const sender = payload.sender as Record<string, any> | undefined;
	return {
		action: data.action,
		repository: typeof repository?.full_name === 'string' ? repository.full_name : undefined,
		thread: typeof item?.number === 'number' ? String(item.number) : undefined,
		title: typeof item?.title === 'string' ? item.title : undefined,
		url: typeof item?.html_url === 'string' ? item.html_url : undefined,
		sender: typeof sender?.login === 'string' ? sender.login : undefined,
	};
}
