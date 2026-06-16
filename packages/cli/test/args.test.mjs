import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, it } from 'node:test';

const cli = new URL('../dist/flue.js', import.meta.url);

async function runCli(args) {
	const child = spawn(process.execPath, [cli.pathname, ...args], {
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

describe('flue (argument parsing)', () => {
	it('treats the positional as the workflow when flags precede it in `flue run`', async () => {
		// `--target cloudflare` makes `flue run` exit at parse time with a
		// message that names the workflow, proving the flags-first positional
		// was assigned correctly instead of being mistaken for the workflow.
		const result = await runCli(['run', '--target', 'cloudflare', 'hello']);
		assert.equal(result.code, 1);
		assert.ok(result.stderr.includes('/workflows/hello'), result.stderr);
		assert.ok(!result.stderr.includes('Unknown'), result.stderr);
	});

	it('reports the missing workflow when `flue run` receives flags but no positional', async () => {
		const result = await runCli(['run', '--target', 'node']);
		assert.equal(result.code, 1);
		assert.ok(result.stderr.includes('Missing workflow name'), result.stderr);
	});

	it('treats `--target=node` the same as `--target node`', async () => {
		const result = await runCli(['run', '--target=node']);
		assert.equal(result.code, 1);
		assert.ok(result.stderr.includes('Missing workflow name'), result.stderr);
		assert.ok(!result.stderr.includes('Unknown flag'), result.stderr);
	});

	it('reports a missing string value when the next argument is another flag', async () => {
		const result = await runCli(['run', 'hello', '--target', '--root', './app']);
		assert.equal(result.code, 1);
		assert.ok(result.stderr.includes('Missing value for --target'), result.stderr);
	});

	it('reports a missing string value when the next argument is an inline flag', async () => {
		const result = await runCli(['run', 'hello', '--target', '--root=./app']);
		assert.equal(result.code, 1);
		assert.ok(result.stderr.includes('Missing value for --target'), result.stderr);
	});

	it('reports a missing logs string value when the next argument is a boolean flag', async () => {
		const result = await runCli(['logs', 'run-1', '--server', '--no-follow']);
		assert.equal(result.code, 1);
		assert.ok(result.stderr.includes('Missing value for --server'), result.stderr);
	});

	it('accepts a flag-like string value when provided inline', async () => {
		const result = await runCli(['run', 'hello', '--target=--root']);
		assert.equal(result.code, 1);
		assert.ok(result.stderr.includes('Invalid target: "--root"'), result.stderr);
		assert.ok(!result.stderr.includes('Missing value for --target'), result.stderr);
	});

	it('rejects --payload when passed to `flue build`', async () => {
		const result = await runCli(['build', '--payload', '{"x":1}']);
		assert.equal(result.code, 1);
		assert.ok(result.stderr.includes('`flue build` does not accept --payload'), result.stderr);
	});

	it('rejects --port when passed to `flue build`', async () => {
		const result = await runCli(['build', '--port', '8080']);
		assert.equal(result.code, 1);
		assert.ok(result.stderr.includes('`flue build` does not accept --port'), result.stderr);
	});

	it('rejects --payload when passed to `flue dev`', async () => {
		const result = await runCli(['dev', '--payload', '{}']);
		assert.equal(result.code, 1);
		assert.ok(result.stderr.includes('`flue dev` does not accept --payload'), result.stderr);
	});

	it('rejects --payload when `flue connect` is given the default payload value', async () => {
		// Rejection is by flag name, not by comparing against the default
		// value, so even `--payload '{}'` errors instead of slipping through.
		const result = await runCli(['connect', 'assistant', 'thread-1', '--payload', '{}']);
		assert.equal(result.code, 1);
		assert.ok(result.stderr.includes('`flue connect` does not accept --payload'), result.stderr);
	});

	it('rejects an unknown flag when passed to `flue run`', async () => {
		const result = await runCli(['run', 'hello', '--bogus']);
		assert.equal(result.code, 1);
		assert.ok(result.stderr.includes('Unknown flag for `flue run`: --bogus'), result.stderr);
	});
});
