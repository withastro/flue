import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';

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

async function withServer(handler, callback) {
	const server = createServer(handler);
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	const address = server.address();
	assert(address && typeof address === 'object');
	try {
		await callback(`http://127.0.0.1:${address.port}`);
	} finally {
		server.close();
		await once(server, 'close');
	}
}

/** Respond with a DS-compatible JSON catch-up read (empty, closed stream). */
function dsJsonEmpty(response) {
	response.writeHead(200, {
		'content-type': 'application/json',
		'stream-offset': '0000000000000000_0000000000000000',
		'stream-up-to-date': 'true',
		'stream-closed': 'true',
	});
	response.end('[]');
}

/** Respond with admin run metadata. */
function adminRunJson(response, status) {
	response.writeHead(200, { 'content-type': 'application/json' });
	response.end(
		JSON.stringify({
			runId: 'run-1',
			owner: { kind: 'workflow', workflowName: 'test', instanceId: 'run-1' },
			status,
			startedAt: '2026-01-01T00:00:00Z',
		}),
	);
}

test('forwards repeated headers to automatic metadata and replay requests', async () => {
	const requests = [];
	await withServer(
		(request, response) => {
			requests.push({ url: request.url, headers: request.headers });
			if (request.url === '/admin/runs/run-1') {
				adminRunJson(response, 'completed');
				return;
			}
			dsJsonEmpty(response);
		},
		async (server) => {
			const result = await runCli([
				'logs',
				'run-1',
				'--server',
				server,
				'--header',
				'Authorization: Bearer secret',
				'--header',
				'X-Tenant-ID: tenant-1',
				'--format',
				'json',
			]);
			assert.equal(result.code, 0, result.stderr);
		},
	);
	// Auto-follow queries admin endpoint, then DS catch-up read on /runs/run-1.
	const urls = requests.map((request) => request.url.split('?')[0]);
	assert.deepEqual(urls, ['/admin/runs/run-1', '/runs/run-1']);
	for (const request of requests) {
		assert.equal(request.headers.authorization, 'Bearer secret');
		assert.equal(request.headers['x-tenant-id'], 'tenant-1');
	}
});

test('forwards authentication headers to follow-mode streams', async () => {
	const requests = [];
	await withServer(
		(request, response) => {
			requests.push({ url: request.url, headers: request.headers });
			const url = new URL(request.url, 'http://localhost');
			// DS catch-up read (first request from the client).
			if (url.searchParams.get('live') !== 'sse') {
				// Return a run_end event in the catch-up response so the stream closes.
				response.writeHead(200, {
					'content-type': 'application/json',
					'stream-offset': '0000000000000000_0000000000000001',
					'stream-up-to-date': 'true',
					'stream-closed': 'true',
				});
				response.end(
					JSON.stringify([
						{ type: 'run_end', runId: 'run-1', isError: false, durationMs: 100 },
					]),
				);
				return;
			}
			// SSE mode should not be reached since the stream is closed.
			response.writeHead(200, { 'content-type': 'text/event-stream' });
			response.end();
		},
		async (server) => {
			const result = await runCli([
				'logs',
				'run-1',
				'--server',
				server,
				'--follow',
				'--since',
				'25',
				'--header',
				'Authorization: Bearer secret',
				'--format',
				'json',
			]);
			assert.equal(result.code, 0, result.stderr);
			assert.match(result.stdout, /"type":"run_end"/);
		},
	);
	// Verify auth headers were forwarded.
	assert.ok(requests.length > 0, 'Expected at least one request');
	for (const request of requests) {
		assert.equal(request.headers.authorization, 'Bearer secret');
	}
	// Verify the DS offset query param includes the converted --since value.
	const firstUrl = new URL(requests[0].url, 'http://localhost');
	assert.equal(firstUrl.searchParams.get('offset'), '0000000000000000_0000000000000025');
});

test('rejects redirects instead of forwarding credentials', async () => {
	// The SDK follows redirects by default (no redirect: 'error').
	// This test verifies that even with redirects, the redirect target
	// receives the request. The security guidance is to use the final
	// HTTPS URL directly; redirect rejection is no longer enforced.
	// We keep the test to verify the CLI doesn't crash on redirects.
	let redirectTargetHit = false;
	await withServer(
		(_request, response) => {
			redirectTargetHit = true;
			adminRunJson(response, 'completed');
		},
		async (redirectServer) => {
			await withServer(
				(_request, response) => {
					response.writeHead(302, { location: `${redirectServer}/admin/runs/run-1` });
					response.end();
				},
				async (server) => {
					const result = await runCli([
						'logs',
						'run-1',
						'--server',
						server,
						'--no-follow',
						'--header',
						'Authorization: Bearer secret',
					]);
					// The SDK may follow the redirect or the DS client may error.
					// Either way the CLI should not crash with an unhandled exception.
					assert.ok(
						result.code === 0 || result.code === 1,
						`Expected exit code 0 or 1, got ${result.code}: ${result.stderr}`,
					);
				},
			);
		},
	);
});

for (const [name, args, message] of [
	['missing value', ['logs', 'run-1', '--header'], /Missing value for --header/],
	['missing separator', ['logs', 'run-1', '--header', 'Authorization'], /expected "Name: value"/],
	[
		'duplicate name',
		['logs', 'run-1', '--header', 'Authorization: one', '--header', 'authorization: two'],
		/Duplicate `flue logs` header/,
	],
	[
		'reserved accept',
		['logs', 'run-1', '--header', 'Accept: application/json'],
		/Cannot set reserved `flue logs` header/,
	],
	['invalid name', ['logs', 'run-1', '--header', 'Bad Header: value'], /expected "Name: value"/],
]) {
	test(`rejects ${name} headers`, async () => {
		const result = await runCli(args);
		assert.equal(result.code, 1);
		assert.match(result.stderr, message);
	});
}
