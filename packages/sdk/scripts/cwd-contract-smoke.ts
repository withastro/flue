import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { createFlueContext, InMemorySessionStore } from '../src/internal.ts';
import { createLocalSessionEnv } from '../src/node/local-env.ts';
import {
	createSandboxSessionEnv,
	resolveSandboxCwd,
	type SandboxApi,
} from '../src/sandbox.ts';
import type {
	AgentConfig,
	FileStat,
	FlueContext,
	SandboxFactory,
	SessionEnv,
	ShellResult,
} from '../src/types.ts';

const agentConfig: AgentConfig = {
	systemPrompt: '',
	skills: {},
	roles: {},
	model: undefined,
	resolveModel: () => undefined,
};

function createTestContext(id: string, root: string): FlueContext {
	return createFlueContext({
		id,
		runId: `${id}-run`,
		payload: {},
		env: {},
		agentConfig,
		createDefaultEnv: async () => createLocalSessionEnv({ cwd: root }),
		createLocalEnv: async () => createLocalSessionEnv({ cwd: root }),
		defaultStore: new InMemorySessionStore(),
	});
}

class RecordingSandboxApi implements SandboxApi {
	async exec(
		command: string,
		options?: { cwd?: string; env?: Record<string, string>; timeout?: number },
	): Promise<ShellResult> {
		return {
			stdout: command === 'pwd' ? `${options?.cwd ?? ''}\n` : '',
			stderr: '',
			exitCode: 0,
		};
	}

	async readFile(path: string): Promise<string> {
		throw new Error(`unexpected readFile(${path})`);
	}

	async readFileBuffer(path: string): Promise<Uint8Array> {
		throw new Error(`unexpected readFileBuffer(${path})`);
	}

	async writeFile(_path: string, _content: string | Uint8Array): Promise<void> {}

	async stat(path: string): Promise<FileStat> {
		throw new Error(`unexpected stat(${path})`);
	}

	async readdir(_path: string): Promise<string[]> {
		return [];
	}

	async exists(_path: string): Promise<boolean> {
		return false;
	}

	async mkdir(_path: string, _options?: { recursive?: boolean }): Promise<void> {}

	async rm(_path: string, _options?: { recursive?: boolean; force?: boolean }): Promise<void> {}
}

async function smokeLocalCwdWrapper(): Promise<void> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'flue-cwd-local-')));
	const projectDir = path.join(root, 'project');
	const nestedDir = path.join(projectDir, 'nested');
	await fs.mkdir(nestedDir, { recursive: true });

	const ctx = createTestContext('local-cwd', root);
	const harness = await ctx.init({ model: false, sandbox: 'local', cwd: 'project' });

	await harness.fs.writeFile('marker.txt', 'ok');
	assert.equal(await fs.readFile(path.join(projectDir, 'marker.txt'), 'utf8'), 'ok');

	const pwd = await harness.shell('pwd');
	assert.equal(pwd.stdout.trim(), projectDir);

	const nestedPwd = await harness.shell('pwd', { cwd: 'nested' });
	assert.equal(nestedPwd.stdout.trim(), nestedDir);
}

async function smokeSandboxFactoryCwdContract(): Promise<void> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'flue-cwd-factory-')));
	let factoryOptions: { id: string; cwd?: string } | undefined;
	let createCount = 0;

	const factory: SandboxFactory = {
		async createSessionEnv(options): Promise<SessionEnv> {
			factoryOptions = options;
			createCount += 1;
			const api = new RecordingSandboxApi();
			return createSandboxSessionEnv(api, resolveSandboxCwd('/workspace', options.cwd));
		},
	};

	const ctx = createTestContext('factory-cwd', root);
	const harness = await ctx.init({ model: false, sandbox: factory, cwd: 'project' });

	assert.deepEqual(factoryOptions, { id: 'factory-cwd', cwd: 'project' });
	assert.equal(createCount, 1);

	const pwd = await harness.shell('pwd');
	assert.equal(pwd.stdout.trim(), '/workspace/project');
}

assert.equal(resolveSandboxCwd('/workspace', undefined), '/workspace');
assert.equal(resolveSandboxCwd('/workspace', 'project'), '/workspace/project');
assert.equal(resolveSandboxCwd('/workspace', '/tmp/project'), '/tmp/project');
assert.equal(resolveSandboxCwd('/workspace/app', '../other'), '/workspace/other');

await smokeLocalCwdWrapper();
await smokeSandboxFactoryCwdContract();
