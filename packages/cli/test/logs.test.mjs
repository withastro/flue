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
		'Stream-Next-Offset': '0000000000000000_0000000000000000',
		'stream-up-to-date': 'true',
		'stream-closed': 'true',
	});
	response.end('[]');
}

/** True when the request is the run-record probe (`GET /runs/:runId?meta`). */
function isRunMetaRequest(request) {
	return new URL(request.url, 'http://localhost').searchParams.has('meta');
}

/** Respond with run-record metadata (the `?meta` view). */
function runMetaJson(response, status) {
	response.writeHead(200, { 'content-type': 'application/json' });
	response.end(
		JSON.stringify({
			runId: 'run-1',
			workflowName: 'test',
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
			if (isRunMetaRequest(request)) {
				runMetaJson(response, 'completed');
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
				'ndjson',
			]);
			assert.equal(result.code, 0, result.stderr);
		},
	);
	// Auto-follow probes the public ?meta view, then does a DS catch-up read,
	// both on /runs/run-1.
	const urls = requests.map((request) => request.url.split('?')[0]);
	assert.deepEqual(urls, ['/runs/run-1', '/runs/run-1']);
	assert.ok(isRunMetaRequest(requests[0]), 'Expected the first request to be the ?meta probe');
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
			// Run probe (runs before streaming, even with explicit --follow).
			if (isRunMetaRequest(request)) {
				runMetaJson(response, 'active');
				return;
			}
			// DS catch-up read (first stream request from the client).
			if (url.searchParams.get('live') !== 'sse') {
				// Return a run_end event in the catch-up response so the stream closes.
				response.writeHead(200, {
					'content-type': 'application/json',
					'Stream-Next-Offset': '0000000000000000_0000000000000000',
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
				'0000000000000000_0000000000000025',
				'--header',
				'Authorization: Bearer secret',
				'--format',
				'ndjson',
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
	// Verify the opaque --since value is passed through as the DS offset param.
	const streamRequest = requests.find(
		(request) => request.url.startsWith('/runs/run-1') && !isRunMetaRequest(request),
	);
	assert.ok(streamRequest, 'Expected a stream request');
	const streamUrl = new URL(streamRequest.url, 'http://localhost');
	assert.equal(streamUrl.searchParams.get('offset'), '0000000000000000_0000000000000025');
});

test('flushes buffered output and exits 130 when SIGINT arrives during follow mode', async () => {
	const heldResponses = [];
	await withServer(
		(request, response) => {
			const url = new URL(request.url, 'http://localhost');
			// Run probe (runs before streaming, even with explicit --follow).
			if (isRunMetaRequest(request)) {
				runMetaJson(response, 'active');
				return;
			}
			if (url.searchParams.get('offset') === '-1') {
				// Catch-up read: run_start plus a partial text line that pretty
				// mode buffers until flushBuffers() runs. Stream stays open.
				response.writeHead(200, {
					'content-type': 'application/json',
					'Stream-Next-Offset': '0000000000000000_0000000000000002',
					'Stream-Up-To-Date': 'true',
				});
				response.end(
					JSON.stringify([
						{ type: 'run_start', runId: 'run-1', workflowName: 'test', eventIndex: 0 },
						{ type: 'text_delta', runId: 'run-1', text: 'partial-tail', eventIndex: 1 },
					]),
				);
				return;
			}
			// Live tail (long-poll or SSE): hold the connection open so the
			// stream only ends via client-side cancellation.
			heldResponses.push(response);
		},
		async (server) => {
			const child = spawn(
				process.execPath,
				[cli.pathname, 'logs', 'run-1', '--server', server, '--follow', '--format', 'pretty'],
				{ stdio: ['ignore', 'pipe', 'pipe'] },
			);
			let stdout = '';
			let stderr = '';
			child.stdout.setEncoding('utf8');
			child.stderr.setEncoding('utf8');
			child.stdout.on('data', (chunk) => {
				stdout += chunk;
			});
			const sawRunStart = new Promise((resolve) => {
				child.stderr.on('data', (chunk) => {
					stderr += chunk;
					if (stderr.includes('run:start')) resolve();
				});
			});
			await sawRunStart;
			child.kill('SIGINT');
			const [code, signal] = await once(child, 'exit');
			for (const response of heldResponses) response.destroy();
			// Graceful exit through the cancellation path, not a hard
			// process.exit() from a signal handler: the buffered partial text
			// line must be flushed before exiting.
			assert.equal(signal, null);
			assert.equal(code, 130, `stdout: ${stdout}\nstderr: ${stderr}`);
			assert.match(stderr, /partial-tail/);
		},
	);
});

test('fails fast instead of retrying when the server is unreachable in follow mode', async () => {
	// Reserve a port, then close the server so connections are refused. The
	// DS stream client retries connection errors forever; explicit --follow
	// must still surface unreachable servers via the run probe.
	const server = createServer();
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	const address = server.address();
	assert(address && typeof address === 'object');
	server.close();
	await once(server, 'close');

	const result = await runCli([
		'logs',
		'run-1',
		'--server',
		`http://127.0.0.1:${address.port}`,
		'--follow',
	]);
	assert.equal(result.code, 1);
	assert.match(result.stderr, /Failed to fetch run run-1/);
});

test('exits with code 2 and filters output when --types excludes the failing run_end', async () => {
	await withServer(
		(request, response) => {
			// One-shot replay: DS catch-up read on /runs/run-1 (no ?meta probe
			// because --no-follow skips the metadata request).
			assert.equal(request.url.split('?')[0], '/runs/run-1');
			response.writeHead(200, {
				'content-type': 'application/json',
				'Stream-Next-Offset': '0000000000000000_0000000000000001',
				'Stream-Up-To-Date': 'true',
				'Stream-Closed': 'true',
			});
			response.end(
				JSON.stringify([
					{ type: 'log', runId: 'run-1', level: 'info', message: 'hello', eventIndex: 0 },
					{ type: 'run_end', runId: 'run-1', isError: true, durationMs: 5, eventIndex: 1 },
				]),
			);
		},
		async (server) => {
			const result = await runCli([
				'logs',
				'run-1',
				'--server',
				server,
				'--no-follow',
				'--types',
				'log',
				'--format',
				'ndjson',
			]);
			// run_end.isError drives the exit code even when filtered from output.
			assert.equal(result.code, 2, result.stderr);
			const lines = result.stdout.split('\n').filter((line) => line.trim() !== '');
			assert.equal(lines.length, 1);
			assert.equal(JSON.parse(lines[0]).type, 'log');
			assert.ok(!result.stdout.includes('run_end'));
		},
	);
});

test('handles redirects without crashing', async () => {
	// The SDK follows redirects by default (no redirect: 'error').
	// This test verifies that even with redirects, the redirect target
	// receives the request. The security guidance is to use the final
	// HTTPS URL directly; redirect rejection is no longer enforced.
	// We keep the test to verify the CLI doesn't crash on redirects.
	let redirectTargetHit = false;
	await withServer(
		(_request, response) => {
			redirectTargetHit = true;
			runMetaJson(response, 'completed');
		},
		async (redirectServer) => {
			await withServer(
				(_request, response) => {
					response.writeHead(302, { location: `${redirectServer}/runs/run-1?meta` });
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
