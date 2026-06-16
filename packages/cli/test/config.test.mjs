import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
// The config resolver is internal to the CLI (the public `@flue/cli/config`
// subpath exposes only the `flue.config.ts` authoring API), so test it at the
// source boundary the CLI consumes.
import { resolveConfig } from '../src/lib/config.ts';

const cli = new URL('../dist/flue.js', import.meta.url);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const fixtureRoots = [];

process.on('exit', () => {
	for (const root of fixtureRoots) fs.rmSync(root, { recursive: true, force: true });
});

describe('resolveConfig()', () => {
	describe('source-layout selection', () => {
		it('resolves sourceRoot to the project root when neither .flue/ nor src/ exists', async () => {
			const root = createFixtureRoot();
			const { flueConfig } = await resolveConfig({ cwd: root, inline: { target: 'node' } });
			assert.equal(flueConfig.root, root);
			assert.equal(flueConfig.sourceRoot, root);
		});

		it('resolves sourceRoot to src/ when src/ exists and .flue/ does not', async () => {
			const root = createFixtureRoot();
			fs.mkdirSync(path.join(root, 'src'));
			fs.mkdirSync(path.join(root, 'workflows'));
			const { flueConfig } = await resolveConfig({ cwd: root, inline: { target: 'node' } });
			assert.equal(flueConfig.sourceRoot, path.join(root, 'src'));
		});

		it('resolves sourceRoot to .flue/ when .flue/ exists alongside src/ and bare dirs', async () => {
			const root = createFixtureRoot();
			fs.mkdirSync(path.join(root, '.flue'));
			fs.mkdirSync(path.join(root, 'src'));
			fs.mkdirSync(path.join(root, 'agents'));
			fs.mkdirSync(path.join(root, 'workflows'));
			const { flueConfig } = await resolveConfig({ cwd: root, inline: { target: 'node' } });
			assert.equal(flueConfig.sourceRoot, path.join(root, '.flue'));
		});
	});

	describe('validation', () => {
		it('rejects when no target is supplied inline or in a config file', async () => {
			const root = createFixtureRoot();
			await assert.rejects(resolveConfig({ cwd: root }), /Missing required `target`/);
		});

		it('rejects a config file with an unknown field', async () => {
			const root = createFixtureRoot();
			fs.writeFileSync(
				path.join(root, 'flue.config.mjs'),
				`export default { target: 'node', bogus: true };\n`,
			);
			await assert.rejects(resolveConfig({ cwd: root }), /Invalid config/);
		});

		it('rejects a config file with an invalid target value', async () => {
			const root = createFixtureRoot();
			fs.writeFileSync(path.join(root, 'flue.config.mjs'), `export default { target: 'deno' };\n`);
			await assert.rejects(resolveConfig({ cwd: root }), /Invalid config/);
		});

		it('rejects an empty output path', async () => {
			const root = createFixtureRoot();
			await assert.rejects(
				resolveConfig({ cwd: root, inline: { target: 'node', output: '' } }),
				/Path must not be empty/,
			);
		});

		it('rejects when output resolves to the project root', async () => {
			const root = createFixtureRoot();
			await assert.rejects(
				resolveConfig({ cwd: root, inline: { target: 'node', output: root } }),
				/`output` resolves to the project root/,
			);
		});

		it('rejects a config file whose default export is not an object', async () => {
			const root = createFixtureRoot();
			fs.writeFileSync(path.join(root, 'flue.config.mjs'), `export default 'node';\n`);
			await assert.rejects(
				resolveConfig({ cwd: root }),
				/must export a config object as the default export/,
			);
		});
	});
});

describe('flue build', () => {
	it('rejects a project that contains channels but no agents or workflows', async () => {
		const root = createFixtureRoot();
		fs.writeFileSync(path.join(root, 'flue.config.mjs'), `export default { target: 'node' };\n`);
		fs.mkdirSync(path.join(root, 'channels'));
		fs.writeFileSync(
			path.join(root, 'channels', 'custom.mjs'),
			`export const channel = { routes: [{ method: 'POST', path: '/webhook', handler: () => new Response() }] };\n`,
		);

		const child = spawn(process.execPath, [cli.pathname, 'build'], {
			cwd: root,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let output = '';
		for (const stream of [child.stdout, child.stderr]) {
			stream.setEncoding('utf8');
			stream.on('data', (chunk) => {
				output += chunk;
			});
		}
		const [exitCode] = await once(child, 'exit');

		assert.equal(exitCode, 1);
		assert.match(output, /No agent or workflow files found/);
		assert.equal(fs.existsSync(path.join(root, 'dist', 'server.mjs')), false);
	});

	it('discovers agents and workflows from .flue/ and ignores the bare layout when .flue/ exists', async () => {
		const root = createFixtureRoot();
		linkRuntime(root);
		fs.writeFileSync(path.join(root, 'flue.config.mjs'), `export default { target: 'node' };\n`);

		fs.mkdirSync(path.join(root, '.flue', 'agents'), { recursive: true });
		fs.mkdirSync(path.join(root, '.flue', 'workflows'), { recursive: true });
		fs.writeFileSync(
			path.join(root, '.flue', 'agents', 'helper.mjs'),
			`import { createAgent, defineAgentProfile } from '@flue/runtime';\n` +
				`const profile = defineAgentProfile({ instructions: 'helper' });\n` +
				`export default createAgent(() => ({ profile }));\n`,
		);
		fs.writeFileSync(
			path.join(root, '.flue', 'workflows', 'inner.mjs'),
			`export async function run() { return { ok: true }; }\n`,
		);

		// Bare layout that must be ignored because .flue/ exists.
		fs.mkdirSync(path.join(root, 'agents'));
		fs.mkdirSync(path.join(root, 'workflows'));
		fs.writeFileSync(
			path.join(root, 'agents', 'stray.mjs'),
			`import { createAgent, defineAgentProfile } from '@flue/runtime';\n` +
				`const profile = defineAgentProfile({ instructions: 'stray' });\n` +
				`export default createAgent(() => ({ profile }));\n`,
		);
		fs.writeFileSync(
			path.join(root, 'workflows', 'outer.mjs'),
			`export async function run() { return { ok: true }; }\n`,
		);

		const child = spawn(process.execPath, [cli.pathname, 'build'], {
			cwd: root,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let output = '';
		for (const stream of [child.stdout, child.stderr]) {
			stream.setEncoding('utf8');
			stream.on('data', (chunk) => {
				output += chunk;
			});
		}
		const [exitCode] = await once(child, 'exit');

		assert.equal(exitCode, 0, `flue build failed:\n\n${output}`);
		assert.match(output, /source\s+\.flue/);
		assert.match(output, /agents\s+helper/s);
		assert.match(output, /workflows\s+inner/s);
		assert.doesNotMatch(output, /stray/);
		assert.doesNotMatch(output, /outer/);
		assert.equal(fs.existsSync(path.join(root, 'dist', 'server.mjs')), true);
	});
});

function createFixtureRoot() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flue-cli-config-'));
	fixtureRoots.push(root);
	return root;
}

function linkRuntime(root) {
	const scope = path.join(root, 'node_modules', '@flue');
	fs.mkdirSync(scope, { recursive: true });
	fs.symlinkSync(
		path.join(repositoryRoot, 'packages', 'runtime'),
		path.join(scope, 'runtime'),
		'dir',
	);
}
