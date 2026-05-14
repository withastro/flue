import type { FlueContext } from '@flue/runtime';
import { Bash, InMemoryFs } from 'just-bash';

export const triggers = { webhook: true };

/**
 * Smoke test for the public `agent.fs` / `session.fs` surface.
 * Exercises only SDK-level fs primitives (no LLM calls), so it runs
 * without provider credentials. Used to verify the new FlueFs wiring.
 */
export default async function ({ init }: FlueContext) {
	const fs = new InMemoryFs();
	const sandbox = () => new Bash({ fs });
	// `model` is required by init(), but this test never makes an LLM call
	// — pick the cheapest model so accidental invocation isn't expensive.
	const harness = await init({ sandbox, model: 'anthropic/claude-haiku-4-5' });
	const session = await harness.session();

	const results: Record<string, boolean> = {};
	const check = (name: string, ok: boolean) => {
		results[name] = ok;
		console.log(`[fs-surface] ${name}: ${ok ? 'PASS' : 'FAIL'}`);
	};

	// session.fs round-trip
	await session.fs.writeFile('/tmp/session.txt', 'session.fs content');
	const sRead = await session.fs.readFile('/tmp/session.txt');
	check('session.fs writeFile/readFile round-trip', sRead === 'session.fs content');

	// agent.fs round-trip
	await agent.fs.writeFile('/tmp/agent.txt', 'agent.fs content');
	const aRead = await agent.fs.readFile('/tmp/agent.txt');
	check('agent.fs writeFile/readFile round-trip', aRead === 'agent.fs content');

	// session.fs writes are visible to session.shell
	await session.fs.writeFile('/tmp/visible.txt', 'staged by SDK');
	const viaShell = await session.shell('cat /tmp/visible.txt');
	check('session.fs visible to session.shell', viaShell.stdout.trim() === 'staged by SDK');

	// agent.fs writes are visible to agent.shell
	await agent.fs.writeFile('/tmp/agent-visible.txt', 'staged by agent.fs');
	const aViaShell = await agent.shell('cat /tmp/agent-visible.txt');
	check('agent.fs visible to agent.shell', aViaShell.stdout.trim() === 'staged by agent.fs');

	// mkdir / readdir / exists / rm
	await session.fs.mkdir('/tmp/scratch', { recursive: true });
	await session.fs.writeFile('/tmp/scratch/a.txt', 'a');
	await session.fs.writeFile('/tmp/scratch/b.txt', 'b');
	const entries = (await session.fs.readdir('/tmp/scratch')).sort();
	check('readdir', entries.length === 2 && entries[0] === 'a.txt' && entries[1] === 'b.txt');

	const existsBefore = await session.fs.exists('/tmp/scratch/a.txt');
	await session.fs.rm('/tmp/scratch', { recursive: true, force: true });
	const existsAfter = await session.fs.exists('/tmp/scratch/a.txt');
	check('exists + rm', existsBefore === true && existsAfter === false);

	// stat
	await session.fs.writeFile('/tmp/stat-target.txt', 'hello');
	const stat = await session.fs.stat('/tmp/stat-target.txt');
	check('stat returns FileStat', stat.isFile === true && stat.size === 5);

	// readFileBuffer
	const buf = await session.fs.readFileBuffer('/tmp/stat-target.txt');
	check(
		'readFileBuffer returns bytes',
		buf instanceof Uint8Array && new TextDecoder().decode(buf) === 'hello',
	);

	const allPassed = Object.values(results).every(Boolean);
	console.log(`[fs-surface] ${allPassed ? 'ALL PASSED' : 'SOME FAILED'}`);
	return { results, allPassed };
}
