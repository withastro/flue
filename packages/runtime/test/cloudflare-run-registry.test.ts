import { describe, expect, it } from 'vite-plus/test';
import { createCloudflareRunRegistry } from '../src/cloudflare/run-registry.ts';

function createNamespace(fetch: (request: Request) => Response | Promise<Response>) {
	const id = { toString: () => 'registry-id' };
	const instanceNames: string[] = [];
	const requestedIds: object[] = [];
	const requests: Request[] = [];
	return {
		id,
		instanceNames,
		namespace: {
			idFromName(name: string) {
				instanceNames.push(name);
				return id;
			},
			get(requestedId: object) {
				requestedIds.push(requestedId);
				return {
					async fetch(input: Request | string) {
						const request = typeof input === 'string' ? new Request(input) : input;
						requests.push(request);
						return fetch(request);
					},
				};
			},
		},
		requestedIds,
		requests,
	};
}

describe('createCloudflareRunRegistry()', () => {
	it('returns undefined when createCloudflareRunRegistry() receives no namespace', () => {
		expect(createCloudflareRunRegistry(undefined)).toBeUndefined();
	});

	it('sends workflow ownership when recordRunStart() is called', async () => {
		const fake = createNamespace(() => new Response(null, { status: 204 }));
		const registry = createCloudflareRunRegistry(fake.namespace);

		await registry?.recordRunStart({
			runId: 'workflow:daily-report:01',
			owner: {
				kind: 'workflow',
				workflowName: 'daily-report',
				instanceId: 'workflow:daily-report:01',
			},
			startedAt: '2026-06-01T10:00:00.000Z',
		});

		expect(fake.instanceNames).toEqual(['default']);
		expect(fake.requestedIds).toEqual([fake.id]);
		expect(fake.requests).toHaveLength(1);
		expect(fake.requests[0]?.url).toBe(
			'https://flue-registry.local/pointers/workflow%3Adaily-report%3A01/start',
		);
		expect(fake.requests[0]?.method).toBe('POST');
		expect(fake.requests[0]?.headers.get('content-type')).toBe('application/json');
		expect(fake.requests[0]?.headers.get('x-partykit-room')).toBeNull();
		expect(await fake.requests[0]?.json()).toEqual({
			owner: {
				kind: 'workflow',
				workflowName: 'daily-report',
				instanceId: 'workflow:daily-report:01',
			},
			startedAt: '2026-06-01T10:00:00.000Z',
		});
	});

	it('sends terminal status when recordRunEnd() is called', async () => {
		const fake = createNamespace(() => new Response(null, { status: 204 }));
		const registry = createCloudflareRunRegistry(fake.namespace);

		await registry?.recordRunEnd({
			runId: 'workflow:daily-report:01',
			endedAt: '2026-06-01T10:05:00.000Z',
			durationMs: 300_000,
			isError: true,
		});

		expect(fake.instanceNames).toEqual(['default']);
		expect(fake.requestedIds).toEqual([fake.id]);
		expect(fake.requests).toHaveLength(1);
		expect(fake.requests[0]?.url).toBe(
			'https://flue-registry.local/pointers/workflow%3Adaily-report%3A01/end',
		);
		expect(fake.requests[0]?.method).toBe('POST');
		expect(fake.requests[0]?.headers.get('content-type')).toBe('application/json');
		expect(await fake.requests[0]?.json()).toEqual({
			endedAt: '2026-06-01T10:05:00.000Z',
			durationMs: 300_000,
			isError: true,
		});
	});

	it('returns null when registry lookup receives a not-found response', async () => {
		const fake = createNamespace(() => new Response('missing', { status: 404 }));
		const registry = createCloudflareRunRegistry(fake.namespace);

		expect(await registry?.lookupRun('workflow:daily-report:missing')).toBeNull();
		expect(fake.instanceNames).toEqual(['default']);
		expect(fake.requestedIds).toEqual([fake.id]);
		expect(fake.requests).toHaveLength(1);
		expect(fake.requests[0]?.url).toBe(
			'https://flue-registry.local/pointers/workflow%3Adaily-report%3Amissing',
		);
		expect(fake.requests[0]?.method).toBe('GET');
	});

	it('forwards list filters when registry listing is requested', async () => {
		const fake = createNamespace(
			() =>
				new Response(
					JSON.stringify({
						runs: [
							{
								runId: 'workflow:daily report:01',
								owner: {
									kind: 'workflow',
									workflowName: 'daily report',
									instanceId: 'workflow:daily report:01',
								},
								status: 'errored',
								startedAt: '2026-06-01T10:00:00.000Z',
							},
						],
						nextCursor: 'next page/?',
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				),
		);
		const registry = createCloudflareRunRegistry(fake.namespace);

		expect(
			await registry?.listRuns({
				status: 'errored',
				workflowName: 'daily report/summary',
				limit: 25,
				cursor: 'next page/?',
			}),
		).toEqual({
			runs: [
				{
					runId: 'workflow:daily report:01',
					owner: {
						kind: 'workflow',
						workflowName: 'daily report',
						instanceId: 'workflow:daily report:01',
					},
					status: 'errored',
					startedAt: '2026-06-01T10:00:00.000Z',
				},
			],
			nextCursor: 'next page/?',
		});
		expect(fake.instanceNames).toEqual(['default']);
		expect(fake.requestedIds).toEqual([fake.id]);
		expect(fake.requests).toHaveLength(1);
		expect(fake.requests[0]?.url).toBe(
			'https://flue-registry.local/pointers?status=errored&workflow=daily+report%2Fsummary&limit=25&cursor=next+page%2F%3F',
		);
		expect(fake.requests[0]?.method).toBe('GET');
	});

	it('throws a diagnostic error when the registry responds unsuccessfully', async () => {
		const fake = createNamespace(() => new Response('storage unavailable', { status: 503 }));
		const registry = createCloudflareRunRegistry(fake.namespace);

		await expect(
			registry?.recordRunStart({
				runId: 'workflow:daily-report:01',
				owner: {
					kind: 'workflow',
					workflowName: 'daily-report',
					instanceId: 'workflow:daily-report:01',
				},
				startedAt: '2026-06-01T10:00:00.000Z',
			}),
		).rejects.toThrow(
			'[flue] FlueRegistry POST /pointers/workflow%3Adaily-report%3A01/start failed: 503 storage unavailable',
		);
		expect(fake.instanceNames).toEqual(['default']);
		expect(fake.requestedIds).toEqual([fake.id]);
		expect(fake.requests).toHaveLength(1);
		expect(fake.requests[0]?.url).toBe(
			'https://flue-registry.local/pointers/workflow%3Adaily-report%3A01/start',
		);
		expect(fake.requests[0]?.method).toBe('POST');
	});

	it('URL-encodes run ids when registry lookup and mutation requests are sent', async () => {
		const fake = createNamespace((request) => {
			if (request.method === 'GET') {
				return new Response(
					JSON.stringify({
						runId: 'workflow:daily report/id?#fragment',
						owner: {
							kind: 'workflow',
							workflowName: 'daily report',
							instanceId: 'workflow:daily report/id?#fragment',
						},
						status: 'active',
						startedAt: '2026-06-01T10:00:00.000Z',
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			return new Response(null, { status: 204 });
		});
		const registry = createCloudflareRunRegistry(fake.namespace);

		expect(await registry?.lookupRun('workflow:daily report/id?#fragment')).toEqual({
			runId: 'workflow:daily report/id?#fragment',
			owner: {
				kind: 'workflow',
				workflowName: 'daily report',
				instanceId: 'workflow:daily report/id?#fragment',
			},
			status: 'active',
			startedAt: '2026-06-01T10:00:00.000Z',
		});
		await registry?.recordRunStart({
			runId: 'workflow:daily report/id?#fragment',
			owner: {
				kind: 'workflow',
				workflowName: 'daily report',
				instanceId: 'workflow:daily report/id?#fragment',
			},
			startedAt: '2026-06-01T10:00:00.000Z',
		});
		await registry?.recordRunEnd({
			runId: 'workflow:daily report/id?#fragment',
			endedAt: '2026-06-01T10:05:00.000Z',
			durationMs: 300_000,
			isError: false,
		});

		expect(fake.instanceNames).toEqual(['default', 'default', 'default']);
		expect(fake.requestedIds).toEqual([fake.id, fake.id, fake.id]);
		expect(fake.requests.map((request) => request.url)).toEqual([
			'https://flue-registry.local/pointers/workflow%3Adaily%20report%2Fid%3F%23fragment',
			'https://flue-registry.local/pointers/workflow%3Adaily%20report%2Fid%3F%23fragment/start',
			'https://flue-registry.local/pointers/workflow%3Adaily%20report%2Fid%3F%23fragment/end',
		]);
		expect(fake.requests.map((request) => request.method)).toEqual(['GET', 'POST', 'POST']);
	});
});
