import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
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

test('builds and serves an external custom target with workflow and run forwarding', async () => {
	const root = createFixtureRoot();
	const port = await getAvailablePort();
	writeHelloTargetPackage(root);
	writeHelperPackage(root);
	writeProject(root);

	const syntax = spawnSync(process.execPath, ['--check', path.join(root, 'hello-target', 'index.mjs')], {
		encoding: 'utf8',
	});
	assert.equal(syntax.status, 0, syntax.stderr);

	const build = await runCli(root, ['build']);
	assert.equal(build.code, 0, build.stderr);
	assert.equal(fs.existsSync(path.join(root, 'dist', 'server.mjs')), true);
	assert.match(fs.readFileSync(path.join(root, 'dist', 'server.mjs'), 'utf8'), /hello-target-helper/);

	const dev = startDev(root, port);
	try {
		await waitForServer(port, dev.logs);
		const admitted = await fetch(`http://127.0.0.1:${port}/workflows/echo`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-gate': 'open' },
			body: JSON.stringify({ name: 'Ada' }),
		});
		assert.equal(admitted.status, 202);
		const admittedBody = await admitted.json();
		assert.equal(typeof admittedBody.runId, 'string');

		const blockedMeta = await fetch(`http://127.0.0.1:${port}/runs/${admittedBody.runId}?meta`);
		assert.equal(blockedMeta.status, 401);

		const meta = await fetch(`http://127.0.0.1:${port}/runs/${admittedBody.runId}?meta`, {
			headers: { 'x-gate': 'open' },
		});
		assert.equal(meta.status, 200);
		const record = await meta.json();
		assert.equal(record.workflowName, 'echo');

		const stream = await fetch(`http://127.0.0.1:${port}/runs/${admittedBody.runId}`, {
			headers: { 'x-gate': 'open' },
		});
		assert.equal(stream.status, 200);
		assert.match(await stream.text(), /run_start|run_end/);
	} finally {
		await dev.stop();
	}
});

function createFixtureRoot() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flue-hello-target-'));
	fixtureRoots.push(root);
	const flueScope = path.join(root, 'node_modules', '@flue');
	fs.mkdirSync(flueScope, { recursive: true });
	fs.symlinkSync(
		path.join(repositoryRoot, 'packages', 'runtime'),
		path.join(flueScope, 'runtime'),
		'dir',
	);
	fs.symlinkSync(path.join(repositoryRoot, 'packages', 'cli'), path.join(flueScope, 'cli'), 'dir');
	return root;
}

function writeProject(root) {
	fs.writeFileSync(
		path.join(root, 'package.json'),
		JSON.stringify({
			type: 'module',
			dependencies: {
				'@flue/hello-target': 'link:./hello-target',
				'@flue/runtime': 'link:../../packages/runtime',
				'hello-target-helper': 'link:./hello-target-helper',
			},
		}),
	);
	fs.writeFileSync(
		path.join(root, 'flue.config.mjs'),
		`import { defineConfig } from '@flue/cli/config';\nimport helloTarget from '@flue/hello-target';\nexport default defineConfig({ target: helloTarget });\n`,
	);
	fs.mkdirSync(path.join(root, 'workflows'), { recursive: true });
	fs.writeFileSync(
		path.join(root, 'workflows', 'echo.mjs'),
		`import { helperValue } from 'hello-target-helper';\nexport const route = async (c, next) => {\n  if (c.req.header('x-gate') !== 'open') return new Response('closed', { status: 401 });\n  await next();\n};\nexport async function run({ payload, log }) {\n  log.info('echo workflow', { helperValue });\n  return { ok: true, helperValue, name: payload.name };\n}\n`,
	);
}

function writeHelperPackage(root) {
	const helperRoot = path.join(root, 'hello-target-helper');
	fs.mkdirSync(helperRoot, { recursive: true });
	fs.writeFileSync(
		path.join(helperRoot, 'package.json'),
		JSON.stringify({
			name: 'hello-target-helper',
			version: '0.0.0',
			type: 'module',
			exports: { '.': './index.mjs' },
		}),
	);
	fs.writeFileSync(path.join(helperRoot, 'index.mjs'), `export const helperValue = 'linked-helper';\n`);
	fs.symlinkSync(helperRoot, path.join(root, 'node_modules', 'hello-target-helper'), 'dir');
}

function writeHelloTargetPackage(root) {
	const targetRoot = path.join(root, 'hello-target');
	fs.mkdirSync(targetRoot, { recursive: true });
	fs.writeFileSync(
		path.join(targetRoot, 'package.json'),
		JSON.stringify({
			name: '@flue/hello-target',
			version: '0.0.0',
			type: 'module',
			exports: { '.': './index.mjs' },
			dependencies: {
				'@flue/cli': 'link:../../packages/cli',
				'@flue/runtime': 'link:../../packages/runtime',
				'hello-target-helper': 'link:../hello-target-helper',
			},
		}),
	);
	fs.writeFileSync(path.join(targetRoot, 'index.mjs'), helloTargetSource());
	const scope = path.join(root, 'node_modules', '@flue');
	fs.mkdirSync(scope, { recursive: true });
	fs.symlinkSync(targetRoot, path.join(scope, 'hello-target'), 'dir');
}

function helloTargetSource() {
	return String.raw`
import { defineTarget } from '@flue/cli';

let forwarder;
let runIndex;

export function installHelloTargetRuntime(runtime) {
  forwarder = runtime.forward;
  runIndex = runtime.runIndex;
}

const target = defineTarget({
  name: 'hello-target',
  build: {
    name: 'hello-target',
    bundle: 'vite',
    generateEntryPoint(ctx) {
      const workflowImports = ctx.workflows
        .map((workflow, index) => 'import * as workflow' + index + ' from ' + JSON.stringify(workflow.filePath.replace(/\\\\/g, '/')) + ';')
        .join('\n');
      const workflowEntries = ctx.workflows
        .map((workflow, index) => '  ' + JSON.stringify(workflow.name) + ': workflow' + index + ',')
        .join('\n');
      return [
        '// Auto-generated by flue (target: hello-target)',
        "import { createServer } from 'node:http';",
        "import { helperValue } from 'hello-target-helper';",
        "import helloTarget, { installHelloTargetRuntime } from '@flue/hello-target';",
        "import { sqlite } from '@flue/runtime/node';",
        "import {",
        "  Bash,",
        "  InMemoryFs,",
        "  bashFactoryToSessionEnv,",
        "  configureFlueRuntime,",
        "  createDefaultFlueApp,",
        "  createFlueContext,",
        "  handleRunRouteRequest,",
        "  handleStreamHead,",
        "  handleStreamRead,",
        "  handleWorkflowRequest,",
        "  resolveModel,",
        "} from '@flue/runtime/adapter-kit';",
        workflowImports,
        '',
        'const workflowModules = {',
        workflowEntries,
        '};',
        'const manifest = {',
        '  agents: [],',
        "  workflows: Object.keys(workflowModules).map((name) => ({ name, transports: { http: true } })),",
        '};',
        'const workflowHandlers = Object.fromEntries(',
        '  Object.entries(workflowModules).map(([name, mod]) => [name, mod.run])',
        ');',
        'const workflowRouteMiddleware = Object.fromEntries(',
        '  Object.entries(workflowModules)',
        "    .filter(([, mod]) => typeof mod.route === 'function')",
        '    .map(([name, mod]) => [name, mod.route])',
        ');',
        '',
        'const adapter = sqlite();',
        'if (adapter.migrate) await adapter.migrate();',
        'const { executionStore, runStore, eventStreamStore } = await adapter.connect();',
        'const packagedSkills = {};',
        '',
        'async function createDefaultEnv() {',
        '  const fs = new InMemoryFs();',
        '  return bashFactoryToSessionEnv(() => new Bash({ fs }));',
        '}',
        '',
        'function createContextForRequest(id, runId, payload, req, initialEventIndex, dispatchId) {',
        '  return createFlueContext({',
        '    id,',
        '    runId,',
        '    dispatchId,',
        '    payload,',
        '    initialEventIndex,',
        '    env: process.env,',
        '    req,',
        '    agentConfig: { packagedSkills, resolveModel },',
        '    createDefaultEnv,',
        '    defaultStore: executionStore.sessions,',
        '    submissionStore: executionStore.submissions,',
        '  });',
        '}',
        '',
        'installHelloTargetRuntime({',
        '  runIndex: runStore,',
        '  async forward(request, target) {',
        "    if (target.kind === 'workflow') {",
        '      const handler = workflowHandlers[target.workflowName];',
        '      if (!handler) return null;',
        '      return handleWorkflowRequest({',
        '        request,',
        '        workflowName: target.workflowName,',
        '        handler,',
        '        createContext: createContextForRequest,',
        '        runStore,',
        '        eventStreamStore,',
        '        runId: target.instanceId,',
        '      });',
        '    }',
        "    if (target.kind === 'run') {",
        '      const url = new URL(request.url);',
        "      if (request.method === 'GET' && url.searchParams.has('meta')) {",
        '        return handleRunRouteRequest({ runStore, workflowName: target.workflowName, runId: target.runId });',
        '      }',
        "      const path = 'runs/' + target.runId;",
        "      if (request.method === 'HEAD') return handleStreamHead(eventStreamStore, path);",
        "      if (request.method === 'GET') return handleStreamRead({ store: eventStreamStore, path, request });",
        '    }',
        '    return null;',
        '  },',
        '});',
        '',
        'configureFlueRuntime({',
        '  target: helloTarget,',
        "  devMode: process.env.FLUE_MODE === 'local',",
        '  runtimeVersion: ' + JSON.stringify(ctx.runtimeVersion) + ',',
        '  manifest,',
        '  workflowRouteMiddleware,',
        '});',
        '',
        'const app = createDefaultFlueApp();',
        'const server = createServer(async (req, res) => {',
        "  const origin = 'http://' + (req.headers.host ?? '127.0.0.1');",
        '  const headers = new Headers();',
        '  for (const [key, value] of Object.entries(req.headers)) {',
        '    if (Array.isArray(value)) {',
        '      for (const item of value) headers.append(key, item);',
        '    } else if (value !== undefined) {',
        '      headers.set(key, value);',
        '    }',
        '  }',
        "  const request = new Request(new URL(req.url ?? '/', origin), {",
        '    method: req.method,',
        '    headers,',
        "    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : req,",
        "    duplex: 'half',",
        '  });',
        '  const response = await app.fetch(request);',
        '  res.writeHead(response.status, Object.fromEntries(response.headers));',
        '  if (response.body) {',
        '    for await (const chunk of response.body) res.write(chunk);',
        '  }',
        '  res.end();',
        '});',
        "server.listen(Number(process.env.PORT ?? 3583), '127.0.0.1', () => {",
        "  console.log('[hello-target] listening with ' + helperValue);",
        '});',
        "process.on('SIGTERM', () => server.close(() => process.exit(0)));",
      ].join('\n');
    },
  },
  routing: {
    async forward(request, target) {
      if (!forwarder) throw new Error('[hello-target] runtime forwarder was not installed.');
      return forwarder(request, target);
    },
    get runIndex() {
      return runIndex;
    },
  },
});

export default target;
`;
}

async function runCli(cwd, args) {
	const child = spawn(process.execPath, [cli.pathname, ...args], {
		cwd,
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	let stdout = '';
	let stderr = '';
	child.stdout.setEncoding('utf8');
	child.stderr.setEncoding('utf8');
	child.stdout.on('data', (chunk) => {
		stdout += chunk;
	});
	child.stderr.on('data', (chunk) => {
		stderr += chunk;
	});
	const [code, signal] = await once(child, 'exit');
	return { code, signal, stdout, stderr };
}

function startDev(cwd, port) {
	const child = spawn(process.execPath, [cli.pathname, 'dev', '--port', String(port)], {
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

async function waitForServer(port, logs = () => '') {
	await waitFor(
		async () => {
			try {
				const response = await fetch(`http://127.0.0.1:${port}/openapi.json`);
				return response.ok;
			} catch {
				return false;
			}
		},
		() => `Timed out waiting for server on port ${port}\n\n${logs()}`,
	);
}

async function waitFor(predicate, message, timeout = 20_000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(typeof message === 'function' ? message() : message);
}
