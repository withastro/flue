import type { AgentConversationSnapshot, AgentConversationUpdate } from '@flue/sdk';
import { describe, expect, it } from 'vitest';
import { emptyAgentState, reduceAgentEvent } from '../src/agent-reducer.ts';
import { materialize } from './fixtures/observation.ts';
import eventsSource from './fixtures/agent-events.jsonl?raw';

interface Fixture {
	snapshot: AgentConversationSnapshot;
	updates: AgentConversationUpdate[];
}

function fixture(): Fixture {
	return JSON.parse(eventsSource) as Fixture;
}

describe('reduceAgentEvent() runtime fixture', () => {
	it('projects a converged runtime conversation into UI messages', () => {
		const value = fixture();
		const state = reduceAgentEvent(emptyAgentState, {
			type: 'local_observation',
			conversation: materialize(value.snapshot, value.updates),
			phase: 'live',
			error: undefined,
		});

		expect(state.messages.map((message) => message.id)).toEqual(['entry-user', 'entry-assistant']);
		expect(state.messages[1]?.parts).toEqual([{ type: 'text', text: 'Hello world', state: 'done' }]);
	});
});
