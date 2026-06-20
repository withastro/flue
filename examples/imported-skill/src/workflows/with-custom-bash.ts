import { bash, defineAgent, defineWorkflow, type WorkflowRouteHandler } from '@flue/runtime';
import { Bash, InMemoryFs } from 'just-bash';

export const route: WorkflowRouteHandler = async (_c, next) => next();
const agent = defineAgent(() => {
	const fs = new InMemoryFs();
	return { sandbox: bash(() => new Bash({ fs })), model: false };
});

export default defineWorkflow({
	agent,
	async run({ harness }) {
		const session = await harness.session();
		await session.shell('echo "custom bash succeeded" > proof.txt');
		return { text: (await session.shell('cat proof.txt')).stdout.trim() };
	},
});
