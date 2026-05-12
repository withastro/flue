import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { createFlueContext, InMemorySessionStore } from '../src/internal.ts';
import { createLocalSessionEnv } from '../src/node/local-env.ts';
import type { AgentConfig, FlueContext } from '../src/types.ts';

const secretKey = 'FLUE_LOCAL_PROCESS_ENV_SECRET';
const visibleKey = 'FLUE_LOCAL_PROCESS_ENV_VISIBLE';
const perCallKey = 'FLUE_LOCAL_PROCESS_ENV_PER_CALL';
const nodePath = shellQuote(process.execPath);

process.env[secretKey] = 'should-not-leak';

const agentConfig: AgentConfig = {
	systemPrompt: '',
	skills: {},
	roles: {},
	model: undefined,
	resolveModel: () => undefined,
};

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function envProbeCommand(keys: string[]): string {
	const script = `process.stdout.write(JSON.stringify(${JSON.stringify(
		keys,
	)}.reduce((acc, key) => { acc[key] = process.env[key] ?? null; return acc; }, {})))`;
	return `${nodePath} -e ${shellQuote(script)}`;
}

async function readChildEnv(
	env: ReturnType<typeof createLocalSessionEnv>,
	keys: string[],
	options?: { env?: Record<string, string> },
): Promise<Record<string, string | null>> {
	const result = await env.exec(envProbeCommand(keys), options);
	assert.equal(result.exitCode, 0, result.stderr);
	return JSON.parse(result.stdout);
}

function createTestContext(id: string, root: string): FlueContext {
	return createFlueContext({
		id,
		runId: `${id}-run`,
		payload: {},
		env: process.env,
		agentConfig,
		createDefaultEnv: async () => createLocalSessionEnv({ cwd: root }),
		createLocalEnv: async (options) => createLocalSessionEnv({ cwd: root, ...options }),
		defaultStore: new InMemorySessionStore(),
	});
}

const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'flue-local-env-')));

const inherited = createLocalSessionEnv({ cwd: root });
const inheritedEnv = await readChildEnv(inherited, [secretKey]);
assert.equal(inheritedEnv[secretKey], 'should-not-leak');

const limited = createLocalSessionEnv({ cwd: root, processEnv: 'limited' });
const limitedEnv = await readChildEnv(limited, [secretKey, 'PATH', 'HOME']);
assert.equal(limitedEnv[secretKey], null);
assert.equal(limitedEnv.PATH, process.env.PATH ?? null);
assert.equal(limitedEnv.HOME, process.env.HOME ?? null);

const explicit = createLocalSessionEnv({
	cwd: root,
	processEnv: {
		[visibleKey]: 'yes',
	},
});
const explicitEnv = await readChildEnv(explicit, [visibleKey, secretKey, 'PATH']);
assert.equal(explicitEnv[visibleKey], 'yes');
assert.equal(explicitEnv[secretKey], null);
assert.equal(explicitEnv.PATH, null);

const overlaidEnv = await readChildEnv(explicit, [visibleKey, perCallKey, secretKey], {
	env: { [perCallKey]: 'call' },
});
assert.equal(overlaidEnv[visibleKey], 'yes');
assert.equal(overlaidEnv[perCallKey], 'call');
assert.equal(overlaidEnv[secretKey], null);

const ctx = createTestContext('local-process-env', root);
const harness = await ctx.init({
	model: false,
	sandbox: 'local',
	processEnv: { [visibleKey]: 'ctx' },
});
const harnessEnv = JSON.parse((await harness.shell(envProbeCommand([visibleKey, secretKey]))).stdout);
assert.equal(harnessEnv[visibleKey], 'ctx');
assert.equal(harnessEnv[secretKey], null);

await assert.rejects(
	() =>
		createTestContext('non-local-process-env', root).init({
			model: false,
			processEnv: 'limited',
		}),
	/processEnv.*sandbox: "local"/,
);
