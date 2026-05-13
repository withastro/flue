import assert from 'node:assert/strict';
import {
	type AgentHandler,
	type CreateContextFn,
	createFlueContext,
	createRunSubscriberRegistry,
	handleAgentRequest,
	handleRunRouteRequest,
	InMemoryRunStore,
	InMemorySessionStore,
	type RunStore,
} from '../src/internal.ts';
import type { FlueEvent, SessionEnv } from '../src/types.ts';

const agentName = 'hello';
const instanceId = 'instance-a';

async function main(): Promise<void> {
	const runStore = new InMemoryRunStore();
	const runSubscribers = createRunSubscriberRegistry();
	const createContext = createSmokeContext();

	const sync = await invokeSync({
		runStore,
		runSubscribers,
		createContext,
		payload: { message: 'hello' },
	});
	await assertRunRecord(runStore, sync.runId, { message: 'hello' });
	await assertEventReplay(runStore, sync.runId);
	await assertEventFilters(runStore, sync.runId);
	await assertTerminalStreamReplay(runStore, runSubscribers, sync.runId);
	await assertRunScope(runStore, sync.runId);

	const streamed = await invokeForegroundStream({
		runStore,
		runSubscribers,
		createContext,
		payload: { message: 'stream me' },
	});
	await assertRunRecord(runStore, streamed.runId, { message: 'stream me' });
	assert.equal(streamed.events[0]?.type, 'run_start');
	assert.equal(streamed.events.at(-1)?.type, 'run_end');
	assert(streamed.events.some((event) => event.type === 'log'));
}

function createSmokeContext(): CreateContextFn {
	const defaultStore = new InMemorySessionStore();
	const createUnusedEnv = async (): Promise<SessionEnv> => {
		throw new Error('http-api smoke should not initialize a harness');
	};

	return (id, runId, payload, request) =>
		createFlueContext({
			id,
			runId,
			payload,
			env: {},
			req: request,
			agentConfig: {
				systemPrompt: '',
				skills: {},
				roles: {},
				model: undefined,
				resolveModel: () => undefined,
			},
			createDefaultEnv: createUnusedEnv,
			createLocalEnv: createUnusedEnv,
			defaultStore,
		});
}

const smokeHandler: AgentHandler = (ctx) => {
	ctx.log.info('handler invoked', {
		instanceId: ctx.id,
		runId: ctx.runId,
		requestUrl: ctx.req?.url,
	});
	return { ok: true, payload: ctx.payload, instanceId: ctx.id };
};

async function invokeSync(opts: {
	runStore: RunStore;
	runSubscribers: ReturnType<typeof createRunSubscriberRegistry>;
	createContext: CreateContextFn;
	payload: unknown;
}): Promise<{ runId: string; body: Record<string, unknown> }> {
	const response = await handleAgentRequest({
		request: jsonRequest(`http://flue.test/agents/${agentName}/${instanceId}`, opts.payload),
		agentName,
		id: instanceId,
		handler: smokeHandler,
		createContext: opts.createContext,
		runStore: opts.runStore,
		runSubscribers: opts.runSubscribers,
	});

	assert.equal(response.status, 200);
	const runId = response.headers.get('x-flue-run-id');
	assert(runId, 'sync response should include X-Flue-Run-Id');

	const body = await response.json();
	assertRecord(body);
	assert.deepEqual(body._meta, { runId });
	assert.deepEqual(body.result, { ok: true, payload: opts.payload, instanceId });
	return { runId, body };
}

async function invokeForegroundStream(opts: {
	runStore: RunStore;
	runSubscribers: ReturnType<typeof createRunSubscriberRegistry>;
	createContext: CreateContextFn;
	payload: unknown;
}): Promise<{ runId: string; events: Array<Record<string, unknown>> }> {
	const response = await handleAgentRequest({
		request: jsonRequest(`http://flue.test/agents/${agentName}/${instanceId}`, opts.payload, {
			accept: 'text/event-stream',
		}),
		agentName,
		id: instanceId,
		handler: smokeHandler,
		createContext: opts.createContext,
		runStore: opts.runStore,
		runSubscribers: opts.runSubscribers,
	});

	assert.equal(response.status, 200);
	const runId = response.headers.get('x-flue-run-id');
	assert(runId, 'stream response should include X-Flue-Run-Id');

	const text = await response.text();
	const events = parseSseEvents(text);
	assert(events.length >= 3, `expected stream events, got:\n${text}`);
	assert(events.every((event) => event.runId === runId));
	return { runId, events };
}

async function assertRunRecord(
	store: RunStore,
	runId: string,
	expectedPayload: unknown,
): Promise<void> {
	const response = await runRoute({
		store,
		runId,
		action: 'get',
	});

	assert.equal(response.status, 200);
	const run = await response.json();
	assertRecord(run);
	assert.equal(run.runId, runId);
	assert.equal(run.agentName, agentName);
	assert.equal(run.instanceId, instanceId);
	assert.equal(run.status, 'completed');
	assert.equal(run.isError, false);
	assert.equal(typeof run.startedAt, 'string');
	assert.equal(typeof run.endedAt, 'string');
	assert.equal(typeof run.durationMs, 'number');
	assert.deepEqual(run.result, { ok: true, payload: expectedPayload, instanceId });
}

async function assertEventReplay(store: RunStore, runId: string): Promise<FlueEvent[]> {
	const events = await waitForEvents(store, runId, (current) =>
		containsTypes(current, ['run_start', 'log', 'run_end']),
	);
	assert.equal(events[0]?.type, 'run_start');
	assert.equal(events.at(-1)?.type, 'run_end');
	assert.deepEqual(
		events.map((event) => event.eventIndex),
		events.map((_, index) => index),
	);
	assert(events.every((event) => event.runId === runId));

	const response = await runRoute({
		store,
		runId,
		action: 'events',
	});
	const body = await response.json();
	assertRecord(body);
	assert(Array.isArray(body.events));
	assert.deepEqual(
		body.events.map((event: FlueEvent) => event.type),
		events.map((event) => event.type),
	);
	return events;
}

async function assertEventFilters(store: RunStore, runId: string): Promise<void> {
	const afterResponse = await runRoute({
		store,
		runId,
		action: 'events',
		search: '?after=0',
	});
	const afterBody = await jsonEvents(afterResponse);
	assert(afterBody.length > 0);
	assert(afterBody.every((event) => typeof event.eventIndex === 'number' && event.eventIndex > 0));
	assert(!afterBody.some((event) => event.type === 'run_start'));

	const typesResponse = await runRoute({
		store,
		runId,
		action: 'events',
		search: '?types=log,run_end',
	});
	const typedEvents = await jsonEvents(typesResponse);
	assert(typedEvents.length >= 2);
	assert(typedEvents.every((event) => event.type === 'log' || event.type === 'run_end'));

	const limitResponse = await runRoute({
		store,
		runId,
		action: 'events',
		search: '?limit=1',
	});
	const limitedEvents = await jsonEvents(limitResponse);
	assert.equal(limitedEvents.length, 1);
	assert.equal(limitedEvents[0]?.type, 'run_start');
}

async function assertTerminalStreamReplay(
	store: RunStore,
	subscribers: ReturnType<typeof createRunSubscriberRegistry>,
	runId: string,
): Promise<void> {
	const full = await runRoute({
		store,
		subscribers,
		runId,
		action: 'stream',
		headers: { accept: 'text/event-stream' },
	});
	assert.equal(full.headers.get('content-type'), 'text/event-stream');
	const fullEvents = parseSseEvents(await full.text());
	assert.equal(fullEvents[0]?.type, 'run_start');
	assert.equal(fullEvents.at(-1)?.type, 'run_end');

	const resumed = await runRoute({
		store,
		subscribers,
		runId,
		action: 'stream',
		headers: { accept: 'text/event-stream', 'last-event-id': '0' },
	});
	const resumedEvents = parseSseEvents(await resumed.text());
	assert(resumedEvents.length > 0);
	assert(!resumedEvents.some((event) => event.type === 'run_start'));
	assert(resumedEvents.every((event) => typeof event.eventIndex === 'number' && event.eventIndex > 0));
	assert(resumedEvents.some((event) => event.type === 'run_end'));
}

async function assertRunScope(store: RunStore, runId: string): Promise<void> {
	await assert.rejects(
		() =>
			runRoute({
				store,
				runId,
				action: 'get',
				id: 'other-instance',
			}),
		(error) =>
			error instanceof Error &&
			(error as { type?: unknown }).type === 'run_not_found' &&
			error.message.includes(runId),
	);
}

async function runRoute(opts: {
	store: RunStore;
	subscribers?: ReturnType<typeof createRunSubscriberRegistry>;
	runId: string;
	action: 'get' | 'events' | 'stream';
	id?: string;
	search?: string;
	headers?: Record<string, string>;
}): Promise<Response> {
	const id = opts.id ?? instanceId;
	const path =
		opts.action === 'get'
			? `/agents/${agentName}/${id}/runs/${opts.runId}`
			: `/agents/${agentName}/${id}/runs/${opts.runId}/${opts.action}`;
	return handleRunRouteRequest({
		request: new Request(`http://flue.test${path}${opts.search ?? ''}`, {
			headers: opts.headers,
		}),
		runStore: opts.store,
		runSubscribers: opts.subscribers,
		agentName,
		id,
		runId: opts.runId,
		action: opts.action,
	});
}

async function jsonEvents(response: Response): Promise<FlueEvent[]> {
	const body = await response.json();
	assertRecord(body);
	assert(Array.isArray(body.events));
	return body.events as FlueEvent[];
}

async function waitForEvents(
	store: RunStore,
	runId: string,
	predicate: (events: FlueEvent[]) => boolean,
): Promise<FlueEvent[]> {
	let lastEvents: FlueEvent[] = [];
	for (let i = 0; i < 20; i++) {
		lastEvents = await store.getEvents(runId);
		if (predicate(lastEvents)) return lastEvents;
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	throw new Error(`Timed out waiting for run events. Last events: ${JSON.stringify(lastEvents)}`);
}

function containsTypes(events: FlueEvent[], types: string[]): boolean {
	const seen = new Set<string>(events.map((event) => event.type));
	return types.every((type) => seen.has(type));
}

function parseSseEvents(text: string): Array<Record<string, unknown>> {
	return text
		.split('\n\n')
		.map((frame) => frame.trim())
		.filter(Boolean)
		.filter((frame) => !frame.startsWith(':'))
		.map((frame) => {
			const eventLine = frame.split('\n').find((line) => line.startsWith('event: '));
			const dataLine = frame.split('\n').find((line) => line.startsWith('data: '));
			assert(eventLine, `SSE frame missing event line: ${frame}`);
			assert(dataLine, `SSE frame missing data line: ${frame}`);
			const data = JSON.parse(dataLine.slice('data: '.length));
			assertRecord(data);
			assert.equal(data.type, eventLine.slice('event: '.length));
			return data;
		});
}

function jsonRequest(
	url: string,
	body: unknown,
	headers: Record<string, string> = {},
): Request {
	return new Request(url, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			...headers,
		},
		body: JSON.stringify(body),
	});
}

function assertRecord(value: unknown): asserts value is Record<string, unknown> {
	assert(value !== null && typeof value === 'object' && !Array.isArray(value));
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
