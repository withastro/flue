import { describe, expect, it } from 'vitest';
import { generateBuiltModuleNormalizationSource } from '../src/lib/generated-entry-normalization.ts';

type NormalizeBuiltModules = (
	agentModules: Record<string, Record<string, unknown>>,
	workflowModules: Record<string, Record<string, unknown>>,
	channelModules?: Record<string, Record<string, unknown>>,
) => {
	agents: Array<Record<string, unknown>>;
	workflows: Array<Record<string, unknown>>;
	channelHandlers: Record<string, Record<string, (value: unknown) => unknown>>;
};

// The normalization function ships as generated source inside built server
// entries; evaluate it the same way a generated entry does.
const normalizeBuiltModules = new Function(
	'assertWorkflowDefinition',
	`${generateBuiltModuleNormalizationSource()}; return normalizeBuiltModules;`,
)((value: unknown, name: string) => {
	const workflow = value as {
		__flueWorkflowDefinition?: unknown;
		agent?: unknown;
		action?: unknown;
	};
	if (
		!workflow ||
		workflow.__flueWorkflowDefinition !== true ||
		!workflow.agent ||
		!workflow.action
	) {
		throw new Error(`[flue] Workflow "${name}" must default-export defineWorkflow(...).`);
	}
}) as NormalizeBuiltModules;

function agentModule(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return { default: { __flueAgentDefinition: true, initialize: () => ({}) }, ...overrides };
}

function workflowModule(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		default: {
			__flueWorkflowDefinition: true,
			agent: { __flueAgentDefinition: true, initialize: () => ({}) },
			action: { __flueAction: true },
		},
		...overrides,
	};
}

describe('normalizeBuiltModules()', () => {
	it('collects the module-level description export into the agent manifest entry when present', () => {
		const { agents } = normalizeBuiltModules(
			{ support: agentModule({ description: 'Resolves customer support tickets.' }) },
			{},
		);

		expect(agents).toEqual([
			expect.objectContaining({
				name: 'support',
				description: 'Resolves customer support tickets.',
			}),
		]);
	});

	it('omits description from the agent manifest entry when the module does not export one', () => {
		const { agents } = normalizeBuiltModules({ support: agentModule() }, {});

		expect(agents).toEqual([expect.objectContaining({ name: 'support' })]);
	});

	it('throws when an agent description export is not a string', () => {
		expect(() => normalizeBuiltModules({ support: agentModule({ description: 42 }) }, {})).toThrow(
			'[flue] Agent "support" description export must be a non-empty string.',
		);
	});

	it('throws when an agent description export is an empty string', () => {
		expect(() =>
			normalizeBuiltModules({ support: agentModule({ description: '   ' }) }, {}),
		).toThrow('[flue] Agent "support" description export must be a non-empty string.');
	});

	it('normalizes a Workflow module with no middleware exports', () => {
		const module = workflowModule();

		const normalized = normalizeBuiltModules({}, { report: module });

		expect(normalized.workflows).toEqual([{ name: 'report', definition: module.default }]);
	});

	it('normalizes a Workflow module with only a route export', () => {
		const route = () => undefined;
		const module = workflowModule({ route });

		const normalized = normalizeBuiltModules({}, { report: module });

		expect(normalized.workflows).toEqual([{ name: 'report', definition: module.default, route }]);
	});

	it('normalizes a Workflow module with only a runs export', () => {
		const runs = () => undefined;
		const module = workflowModule({ runs });

		const normalized = normalizeBuiltModules({}, { report: module });

		expect(normalized.workflows).toEqual([{ name: 'report', definition: module.default, runs }]);
	});

	it('normalizes a Workflow module with route and runs exports independently', () => {
		const route = () => undefined;
		const runs = () => undefined;
		const module = workflowModule({ route, runs });

		const normalized = normalizeBuiltModules({}, { report: module });

		expect(normalized.workflows).toEqual([
			{ name: 'report', definition: module.default, route, runs },
		]);
	});

	it('rejects a Workflow module with an invalid runs export', () => {
		expect(() => normalizeBuiltModules({}, { report: workflowModule({ runs: true }) })).toThrow(
			'[flue] Workflow "report" runs export must be a callable Hono middleware value.',
		);
	});

	it('rejects duplicate Workflow Definition identities across discovered modules', () => {
		const shared = workflowModule();

		expect(() =>
			normalizeBuiltModules({}, { first: shared, second: { default: shared.default } }),
		).toThrow(
			'[flue] Workflows "first" and "second" default-export the same workflow definition value.',
		);
	});

	it('resolves exact Workflow Definition identities to discovered names', () => {
		const module = workflowModule();
		const normalized = normalizeBuiltModules({}, { report: module });

		expect(normalized.workflows.find((record) => record.definition === module.default)?.name).toBe(
			'report',
		);
		const clone = { ...(module.default as object) };
		expect(normalized.workflows.find((record) => record.definition === clone)).toBeUndefined();
	});

	it('rejects legacy workflow run exports', () => {
		expect(() => normalizeBuiltModules({}, { report: { run: () => undefined } })).toThrow(
			'[flue] Workflow "report" must default-export defineWorkflow(...).',
		);
	});

	it('normalizes discovered channel routes into a method and path lookup', () => {
		const handler = () => new Response('ok');

		const { channelHandlers } = normalizeBuiltModules(
			{ support: agentModule() },
			{},
			{
				slack: {
					channel: {
						routes: [
							{ method: 'POST', path: '/events', handler },
							{ method: 'POST', path: '/interactions/retries', handler },
						],
					},
				},
			},
		);

		expect(channelHandlers).toEqual({
			slack: {
				'POST /events': handler,
				'POST /interactions/retries': handler,
			},
		});
	});

	it('rejects an invalid discovered channel export', () => {
		expect(() =>
			normalizeBuiltModules({ support: agentModule() }, {}, { slack: { channel: null } }),
		).toThrow(
			'[flue] Channel "slack" must export a created channel as the named "channel" binding.',
		);
	});

	it('rejects duplicate channel method and path declarations', () => {
		const handler = () => new Response('ok');

		expect(() =>
			normalizeBuiltModules(
				{ support: agentModule() },
				{},
				{
					slack: {
						channel: {
							routes: [
								{ method: 'POST', path: '/events', handler },
								{ method: 'POST', path: '/events', handler },
							],
						},
					},
				},
			),
		).toThrow('[flue] Channel "slack" declares duplicate route "POST /events".');
	});

	it('rejects a channel route path that escapes its namespace', () => {
		expect(() =>
			normalizeBuiltModules(
				{ support: agentModule() },
				{},
				{
					slack: {
						channel: {
							routes: [{ method: 'POST', path: '/../events', handler: () => new Response('ok') }],
						},
					},
				},
			),
		).toThrow('[flue] Channel "slack" route path must remain beneath its channel namespace.');
	});

	it('rejects malformed channel route methods and suffixes', () => {
		const normalize = (route: Record<string, unknown>) =>
			normalizeBuiltModules(
				{ support: agentModule() },
				{},
				{ slack: { channel: { routes: [route] } } },
			);

		expect(() =>
			normalize({ method: 'post', path: '/events', handler: () => new Response('ok') }),
		).toThrow('route method must contain only uppercase ASCII letters');
		expect(() =>
			normalize({ method: 'POST', path: '/', handler: () => new Response('ok') }),
		).toThrow('route path must be a non-empty absolute suffix without a query or fragment');
		expect(() =>
			normalize({
				method: 'POST',
				path: '/events?source=provider',
				handler: () => new Response('ok'),
			}),
		).toThrow('route path must be a non-empty absolute suffix without a query or fragment');
	});
});
