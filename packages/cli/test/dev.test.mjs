import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { createServer } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = new URL('../dist/flue.js', import.meta.url);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const fixtureRoots = [];

process.on('exit', () => {
	for (const root of fixtureRoots) fs.rmSync(root, { recursive: true, force: true });
});

test('restarts after discovered config changes and recovers after invalid config', async () => {
	const root = createFixtureRoot();
	const port = await getAvailablePort();
	writeWorkflow(root);
	fs.writeFileSync(path.join(root, '.config-helper.mjs'), `export default 'dist-one';\n`);
	fs.writeFileSync(
		path.join(root, 'flue.config.mjs'),
		`import output from './.config-helper.mjs';\nexport default { target: 'node', output };\n`,
	);

	const dev = startDev(root, ['--port', String(port)]);
	try {
		await waitForServer(port, dev.logs);
		assert.equal(fs.existsSync(path.join(root, 'dist-one', 'server.mjs')), true);

		fs.writeFileSync(path.join(root, '.config-helper.mjs'), `export default 'dist-two';\n`);
		fs.appendFileSync(path.join(root, 'flue.config.mjs'), '\n');
		await waitForPath(path.join(root, 'dist-two', 'server.mjs'));
		await waitForServer(port);

		fs.writeFileSync(path.join(root, 'flue.config.ts'), `export default { target: ;\n`);
		await dev.waitForLog('Dev server restart failed. Waiting for a configuration change...');
		await waitForServerDown(port);

		fs.writeFileSync(
			path.join(root, 'flue.config.ts'),
			`export default { target: 'node', output: 'dist-ts' };\n`,
		);
		await waitForPath(path.join(root, 'dist-ts', 'server.mjs'));
		await waitForServer(port);

		fs.rmSync(path.join(root, 'flue.config.ts'));
		await dev.waitForLog('config    flue.config.mjs');
		await waitForServer(port);
	} finally {
		await dev.stop();
	}
});

test('watches an explicit config outside the project root', async () => {
	const root = createFixtureRoot();
	const configRoot = createFixtureRoot();
	const configPath = path.join(configRoot, 'external.config.mjs');
	const port = await getAvailablePort();
	writeWorkflow(root);
	fs.writeFileSync(
		configPath,
		`export default { target: 'node', root: ${JSON.stringify(root)}, output: ${JSON.stringify(path.join(root, 'dist-one'))} };\n`,
	);

	const dev = startDev(root, ['--config', configPath, '--port', String(port)]);
	try {
		await waitForServer(port, dev.logs);
		fs.writeFileSync(
			configPath,
			`export default { target: 'node', root: ${JSON.stringify(root)}, output: ${JSON.stringify(path.join(root, 'dist-two'))} };\n`,
		);
		await waitForPath(path.join(root, 'dist-two', 'server.mjs'));
		await waitForServer(port);
	} finally {
		await dev.stop();
	}
});

function createFixtureRoot() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flue-cli-dev-'));
	fixtureRoots.push(root);
	const scope = path.join(root, 'node_modules', '@flue');
	fs.mkdirSync(scope, { recursive: true });
	fs.symlinkSync(
		path.join(repositoryRoot, 'packages', 'runtime'),
		path.join(scope, 'runtime'),
		'dir',
	);
	return root;
}

function writeWorkflow(root) {
	fs.mkdirSync(path.join(root, 'workflows'));
	fs.writeFileSync(
		path.join(root, 'workflows', 'smoke.mjs'),
		`export const route = async (_c, next) => next();\nexport async function run() { return { ok: true, internalDevSession: process.env.FLUE_INTERNAL_DEV_SESSION }; }\n`,
	);
}

function startDev(cwd, args) {
	const child = spawn(process.execPath, [cli.pathname, 'dev', ...args], {
		cwd,
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	let output = '';
	for (const stream of [child.stdout, child.stderr]) {
		stream.setEncoding('utf8');
		stream.on('data', (chunk) => {
			output += chunk;
		});
	}
	return {
		logs() {
			return output;
		},
		waitForLog(text) {
			return waitFor(
				() => output.includes(text),
				`Timed out waiting for log: ${text}\n\n${output}`,
			);
		},
		async stop() {
			if (child.exitCode !== null || child.signalCode !== null) return;
			child.kill('SIGTERM');
			await Promise.race([
				once(child, 'exit'),
				new Promise((_, reject) =>
					setTimeout(() => reject(new Error(`Timed out stopping flue dev\n\n${output}`)), 5_000),
				),
			]);
		},
	};
}

async function getAvailablePort() {
	const server = createServer();
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	const address = server.address();
	assert(address && typeof address === 'object');
	server.close();
	await once(server, 'close');
	return address.port;
}

function waitForPath(file) {
	return waitFor(() => fs.existsSync(file), `Timed out waiting for path: ${file}`);
}

async function waitForServer(port, logs = () => '') {
	let body;
	await waitFor(
		async () => {
			try {
				const response = await fetch(`http://127.0.0.1:${port}/workflows/smoke?wait=result`, {
					method: 'POST',
				});
				body = await response.json();
				return response.ok;
			} catch {
				return false;
			}
		},
		() => `Timed out waiting for server on port ${port}\n\n${logs()}`,
	);
	assert.equal(body.result.internalDevSession, undefined);
}

function waitForServerDown(port) {
	return waitFor(async () => {
		try {
			await fetch(`http://127.0.0.1:${port}/workflows/smoke?wait=result`, { method: 'POST' });
			return false;
		} catch {
			return true;
		}
	}, `Timed out waiting for server shutdown on port ${port}`);
}

async function waitFor(predicate, message, timeout = 20_000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(typeof message === 'function' ? message() : message);
}
