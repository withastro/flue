import { defineAgent } from '../../src/agent-definition.ts';
import { sqlite } from '../../src/node/agent-execution-store.ts';
import { InMemoryRunStore } from '../../src/node/run-store.ts';
import type {
	AgentRecord,
	CloudflareRuntime,
	NodeRuntime,
	WorkflowRecord,
} from '../../src/runtime/flue-app.ts';
import type { AgentDefinition } from '../../src/types.ts';
import type { WorkflowDefinition } from '../../src/workflow-definition.ts';
import { createTestEventStreamStore } from './test-event-stream-store.ts';

export function agentRecord(
	name: string,
	options: {
		definition?: AgentDefinition;
		description?: string;
		route?: AgentRecord['route'];
	} = {},
): AgentRecord {
	return {
		name,
		definition: options.definition ?? defineAgent(() => ({ model: false })),
		...(options.description === undefined ? {} : { description: options.description }),
		...(options.route === undefined ? {} : { route: options.route }),
	};
}

export function workflowRecord(
	name: string,
	definition: WorkflowDefinition,
	options: { route?: WorkflowRecord['route']; runs?: WorkflowRecord['runs'] } = {},
): WorkflowRecord {
	return {
		name,
		definition,
		...(options.route === undefined ? {} : { route: options.route }),
		...(options.runs === undefined ? {} : { runs: options.runs }),
	};
}

export function nodeRuntime(overrides: Partial<NodeRuntime> = {}): NodeRuntime {
	const adapter = sqlite();
	void adapter.migrate?.();
	const stores = adapter.connect();
	if (stores instanceof Promise) throw new Error('Test SQLite adapter must connect synchronously.');
	return {
		target: 'node',
		agents: [],
		workflows: [],
		dispatchQueue: {
			enqueue: async (input) => ({ dispatchId: input.dispatchId, acceptedAt: input.acceptedAt }),
		},
		admitWorkflow: async () => ({ runId: 'run_test' }),
		createAgentAdmission: () => {
			throw new Error('Unexpected agent admission.');
		},
		createWorkflowContext: () => {
			throw new Error('Unexpected workflow context creation.');
		},
		runStore: new InMemoryRunStore(),
		eventStreamStore: createTestEventStreamStore(),
		conversationStreamStore: stores.conversationStreamStore,
		...overrides,
	};
}

export function cloudflareRuntime(overrides: Partial<CloudflareRuntime> = {}): CloudflareRuntime {
	return {
		target: 'cloudflare',
		agents: [],
		workflows: [],
		dispatchQueue: {
			enqueue: async (input) => ({ dispatchId: input.dispatchId, acceptedAt: input.acceptedAt }),
		},
		admitWorkflow: async () => ({ runId: 'run_test' }),
		routeAgentRequest: async () => null,
		routeWorkflowRequest: async () => null,
		routeRunRequest: async () => null,
		createRunIndexForRequest: () => undefined,
		...overrides,
	};
}
