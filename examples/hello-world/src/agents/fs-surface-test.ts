'use agent';
import { bash, useModel, useSandbox, useTool } from '@flue/runtime';
import { Bash, InMemoryFs } from 'just-bash';

export function FsSurfaceTest() {
	useModel('anthropic/claude-haiku-4-5');
	useSandbox(bash(() => new Bash({ fs: new InMemoryFs() })));
	useTool({
		name: 'fs-surface-test',
		description: 'Exercise the harness.sandbox filesystem surface.',
		harness: true,
		async run({ harness }) {
			const results: Record<string, boolean> = {};
			await harness.sandbox.writeFile('/tmp/agent.txt', 'agent.fs content');
			results['writeFile/readFile round-trip'] =
				(await harness.sandbox.readFile('/tmp/agent.txt')) === 'agent.fs content';
			await harness.sandbox.writeFile('/tmp/agent-visible.txt', 'staged by harness.fs');
			results['visible to harness.sandbox.exec'] =
				(await harness.sandbox.exec('cat /tmp/agent-visible.txt')).stdout.trim() ===
				'staged by harness.fs';
			await harness.sandbox.mkdir('/tmp/scratch', { recursive: true });
			await harness.sandbox.writeFile('/tmp/scratch/a.txt', 'a');
			await harness.sandbox.writeFile('/tmp/scratch/b.txt', 'b');
			const entries = (await harness.sandbox.readdir('/tmp/scratch')).sort();
			results.readdir = entries.length === 2 && entries[0] === 'a.txt' && entries[1] === 'b.txt';
			const existsBefore = await harness.sandbox.exists('/tmp/scratch/a.txt');
			await harness.sandbox.rm('/tmp/scratch', { recursive: true, force: true });
			results['exists + rm'] =
				existsBefore && !(await harness.sandbox.exists('/tmp/scratch/a.txt'));
			await harness.sandbox.writeFile('/tmp/stat-target.txt', 'hello');
			const stat = await harness.sandbox.stat('/tmp/stat-target.txt');
			results['stat returns FileStat'] = stat.isFile && stat.size === 5;
			const buffer = await harness.sandbox.readFileBuffer('/tmp/stat-target.txt');
			results['readFileBuffer returns bytes'] = new TextDecoder().decode(buffer) === 'hello';
			return { results, allPassed: Object.values(results).every(Boolean) };
		},
	});
	return 'When asked to run a demo, call the `fs-surface-test` tool and report its result.';
}
