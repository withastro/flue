import { bash, defineAgent, defineWorkflow, type WorkflowRouteHandler } from '@flue/runtime';
import { Bash, InMemoryFs } from 'just-bash';

export const route: WorkflowRouteHandler = async (_c, next) => next();

const agent = defineAgent(() => {
	const fs = new InMemoryFs();
	return {
		sandbox: bash(() => new Bash({ fs })),
		model: 'anthropic/claude-sonnet-4-6',
	};
});

export default defineWorkflow({
	agent,
	async run({ harness }) {
		const session = await harness.session();
		const results: Record<string, boolean> = {};
		await session.shell('echo "Seeded workspace instructions" > AGENTS.md');
		results['read workspace file'] = (await session.shell('cat AGENTS.md')).stdout.trim().length > 0;
		await session.prompt(
			'Create a file called "hello.txt" in the current directory. Its contents should be exactly: Hello from the agent',
		);
		results['llm write file'] =
			(await session.shell('cat hello.txt')).stdout.trim() === 'Hello from the agent';
		await session.prompt(
			'Read the file AGENTS.md, then overwrite it with exactly this content: MODIFIED BY AGENT',
		);
		results['llm overwrite workspace file'] =
			(await session.shell('cat AGENTS.md')).stdout.trim() === 'MODIFIED BY AGENT';
		await session.shell('echo "shell content" > shell-created.txt');
		results['shell write file'] =
			(await session.shell('cat shell-created.txt')).stdout.trim() === 'shell content';
		return { results, allPassed: Object.values(results).every(Boolean) };
	},
});
