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
		const results: Record<string, boolean> = {};
		await session.fs.writeFile('/tmp/session.txt', 'session.fs content');
		results['session.fs writeFile/readFile round-trip'] =
			(await session.fs.readFile('/tmp/session.txt')) === 'session.fs content';
		await harness.fs.writeFile('/tmp/agent.txt', 'agent.fs content');
		results['harness.fs writeFile/readFile round-trip'] =
			(await harness.fs.readFile('/tmp/agent.txt')) === 'agent.fs content';
		await session.fs.writeFile('/tmp/visible.txt', 'staged by SDK');
		results['session.fs visible to session.shell'] =
			(await session.shell('cat /tmp/visible.txt')).stdout.trim() === 'staged by SDK';
		await harness.fs.writeFile('/tmp/agent-visible.txt', 'staged by harness.fs');
		results['harness.fs visible to harness.shell'] =
			(await harness.shell('cat /tmp/agent-visible.txt')).stdout.trim() === 'staged by harness.fs';
		await session.fs.mkdir('/tmp/scratch', { recursive: true });
		await session.fs.writeFile('/tmp/scratch/a.txt', 'a');
		await session.fs.writeFile('/tmp/scratch/b.txt', 'b');
		const entries = (await session.fs.readdir('/tmp/scratch')).sort();
		results.readdir = entries.length === 2 && entries[0] === 'a.txt' && entries[1] === 'b.txt';
		const existsBefore = await session.fs.exists('/tmp/scratch/a.txt');
		await session.fs.rm('/tmp/scratch', { recursive: true, force: true });
		results['exists + rm'] = existsBefore && !(await session.fs.exists('/tmp/scratch/a.txt'));
		await session.fs.writeFile('/tmp/stat-target.txt', 'hello');
		const stat = await session.fs.stat('/tmp/stat-target.txt');
		results['stat returns FileStat'] = stat.isFile && stat.size === 5;
		const buffer = await session.fs.readFileBuffer('/tmp/stat-target.txt');
		results['readFileBuffer returns bytes'] = new TextDecoder().decode(buffer) === 'hello';
		return { results, allPassed: Object.values(results).every(Boolean) };
	},
});
