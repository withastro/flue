import assert from 'node:assert/strict';
import { exec as execCallback } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { SandboxDiedError, SandboxOperationUnsupportedError } from '@flue/runtime';

const blueprint = await readFile(
	new URL('../../../blueprints/sandbox--azure.md', import.meta.url),
	'utf8',
);
const source = blueprint.match(/```ts\n(\/\/ flue-blueprint:[\s\S]*?)\n```/)[1];
const javascript = stripTypeScriptTypes(source).replaceAll(
	"'@flue/runtime'",
	JSON.stringify(import.meta.resolve('@flue/runtime')),
);
const { azure } = await import(
	`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`
);
const exec = promisify(execCallback);
const missing = () => Object.assign(new Error('Not found'), { statusCode: 404 });

async function fixture(t, overrides = {}) {
	const cwd = await realpath(await mkdtemp(join(tmpdir(), 'flue-azure-')));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const client = {
		sandboxes: {
			get: async () => ({ state: 'Running' }),
			exec: async (_id, { command, workingDirectory }) => {
				try {
					return { ...(await exec(command, { cwd: workingDirectory })), exitCode: 0 };
				} catch (error) {
					return { stdout: error.stdout, stderr: error.stderr, exitCode: error.code };
				}
			},
			...overrides.sandboxes,
		},
		files: { ...overrides.files },
	};
	return {
		cwd,
		client,
		sandbox: await azure(client, 'sandbox-id', { cwd }).createSandbox({ id: 'agent-id' }),
	};
}

test('exec preserves shell syntax, quoted environment values, cwd and nonzero exits', async (t) => {
	const { sandbox, cwd } = await fixture(t);
	const result = await sandbox.exec('printf "%s" "$VALUE"; printf problem >&2; exit 7', {
		env: { VALUE: "quote' $(touch should-not-exist)" },
	});
	assert.deepEqual(result, {
		stdout: "quote' $(touch should-not-exist)",
		stderr: 'problem',
		exitCode: 7,
	});
	assert.equal((await sandbox.exec('pwd')).stdout.trim(), cwd);
	await assert.rejects(readFile(join(cwd, 'should-not-exist')), { code: 'ENOENT' });
});

test('binary reads preserve invalid UTF-8 and quote filenames', async (t) => {
	const { sandbox, cwd } = await fixture(t);
	const bytes = new Uint8Array([0, 255, 128, 65, 10]);
	await writeFile(join(cwd, "quote' file"), bytes);
	assert.deepEqual(await sandbox.readFileBuffer("quote' file"), bytes);
	await writeFile(join(cwd, 'text'), 'héllo');
	assert.equal(await sandbox.readFile('text'), 'héllo');
	await assert.rejects(sandbox.readFile('missing'));
});

test('native file calls preserve bytes, metadata, names and recursive deletion', async (t) => {
	const calls = [];
	const bytes = new Uint8Array([255, 0]);
	const { sandbox, cwd } = await fixture(t, {
		files: {
			write: async (...args) => calls.push(args),
			stat: async () => ({ isDirectory: false, size: 2, modifiedAt: '2026-09-01T00:00:00Z' }),
			list: async () => ({ entries: [{ name: 'one' }, { name: 'two' }] }),
			delete: async (...args) => calls.push(args),
		},
	});
	await sandbox.writeFile('nested/file', bytes);
	assert.deepEqual(calls[0], ['sandbox-id', join(cwd, 'nested/file'), bytes]);
	assert.deepEqual(await sandbox.stat('file'), {
		isFile: true,
		isDirectory: false,
		size: 2,
		mtime: new Date('2026-09-01T00:00:00Z'),
	});
	assert.deepEqual(await sandbox.readdir('.'), ['one', 'two']);
	await sandbox.rm('folder', { recursive: true });
	assert.deepEqual(calls[1], ['sandbox-id', join(cwd, 'folder'), { recursive: true }]);
	await assert.rejects(sandbox.rm('folder', { force: true }), SandboxOperationUnsupportedError);
	assert.equal(calls.length, 2);
});

test('exists distinguishes missing paths, authentication failure and missing sandbox', async (t) => {
	const { sandbox, client } = await fixture(t, {
		files: {
			stat: async () => {
				throw missing();
			},
		},
	});
	assert.equal(await sandbox.exists('missing'), false);
	client.files.stat = async () => {
		throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
	};
	await assert.rejects(sandbox.exists('secret'), /Forbidden/);
	client.files.stat = async () => {
		throw missing();
	};
	client.sandboxes.get = async () => {
		throw missing();
	};
	await assert.rejects(sandbox.exists('missing'), SandboxDiedError);
});

test('recursive mkdir works and reports command errors', async (t) => {
	const { sandbox } = await fixture(t);
	await sandbox.mkdir("parent/quote' child", { recursive: true });
	assert.equal((await sandbox.exec('test -d "parent/quote\' child"')).exitCode, 0);
	await sandbox.exec('touch file');
	await assert.rejects(sandbox.mkdir('file/child', { recursive: true }));
});

test('deadlines use remote timeout and zero does not execute', async (t) => {
	const calls = [];
	const { sandbox } = await fixture(t, {
		sandboxes: {
			exec: async (...args) => {
				calls.push(args);
				return { stdout: '', stderr: '', exitCode: 124 };
			},
		},
	});
	assert.equal((await sandbox.exec('sleep 10', { timeoutMs: 1250 })).exitCode, 124);
	assert.match(calls[0][1].command, /^timeout --kill-after=1s 1\.25s /);
	assert.equal((await sandbox.exec('touch unwanted', { timeoutMs: 0 })).exitCode, 124);
	assert.equal(calls.length, 1);
});

test('pre-abort skips execution and mid-flight abort leaves settlement to Flue', async (t) => {
	let calls = 0;
	let settle;
	const { sandbox } = await fixture(t, {
		sandboxes: {
			exec: () => {
				calls++;
				return new Promise((resolve) => {
					settle = resolve;
				});
			},
		},
	});
	await assert.rejects(sandbox.exec('sleep 10', { signal: AbortSignal.abort() }), {
		name: 'AbortError',
	});
	assert.equal(calls, 0);
	const controller = new AbortController();
	const pending = sandbox.exec('sleep 10', { signal: controller.signal });
	controller.abort();
	await assert.rejects(pending, { name: 'AbortError' });
	settle({ stdout: '', stderr: '', exitCode: 0 });
});

test('unavailable sandbox states are infrastructure failures, not missing paths', async (t) => {
	const { sandbox, client } = await fixture(t, {
		files: {
			stat: async () => {
				throw missing();
			},
		},
	});
	for (const state of ['Stopped', 'Suspended', 'Idle', 'Deleting', 'Disabled', 'Failed']) {
		client.sandboxes.get = async () => ({ state });
		await assert.rejects(sandbox.exists('file'), SandboxDiedError, state);
	}
});

test('unknown or transitional state cannot confirm a missing path', async (t) => {
	const { sandbox, client } = await fixture(t, {
		files: {
			stat: async () => {
				throw missing();
			},
		},
	});
	for (const state of [undefined, 'Creating', 'Stopping', 'Resuming', 'FutureState']) {
		client.sandboxes.get = async () => ({ state });
		await assert.rejects(sandbox.exists('file'), /not confirmed running/);
	}
	client.sandboxes.get = async () => {
		throw new Error('Status unavailable');
	};
	await assert.rejects(sandbox.exists('file'), /Status unavailable/);
});

test('GNU timeout terminates commands, escalating when TERM is ignored', async (t) => {
	try {
		const version = await exec('timeout --version');
		if (!version.stdout.includes('GNU coreutils')) return t.skip('GNU timeout is not installed');
	} catch {
		return t.skip('GNU timeout is not installed');
	}
	const { sandbox } = await fixture(t);
	assert.equal((await sandbox.exec('sleep 10', { timeoutMs: 50 })).exitCode, 124);
	const start = Date.now();
	assert.equal((await sandbox.exec("trap '' TERM; sleep 10", { timeoutMs: 100 })).exitCode, 137);
	assert.ok(
		Date.now() - start < 5000,
		'TERM-ignoring command must be killed after the grace period',
	);
});
