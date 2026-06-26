import type { AgentConversationSnapshot, AgentConversationUpdate } from '@flue/sdk';
import { describe, expect, it } from 'vitest';
import { emptyAgentState, reduceAgentEvent } from '../src/agent-reducer.ts';
import eventsSource from './fixtures/agent-events.jsonl?raw';

interface Fixture {
	snapshot: AgentConversationSnapshot;
	updates: AgentConversationUpdate[];
}

function fixture(): Fixture {
	return JSON.parse(eventsSource) as Fixture;
}

describe('reduceAgentEvent() runtime fixture', () => {
	it('converges from canonical snapshot plus live updates', () => {
		const value = fixture();
		let state = reduceAgentEvent(emptyAgentState, {
			type: 'local_history',
			snapshot: value.snapshot,
		});
		for (const update of value.updates) state = reduceAgentEvent(state, update);

		expect(state.messages.map((message) => message.id)).toEqual([
			'entry-user',
			'entry-assistant',
		]);
		expect(state.messages[1]?.parts).toEqual([
			{ type: 'text', text: 'Hello world', state: 'done' },
		]);
	});

	it('keeps canonical update replay idempotent', () => {
		const value = fixture();
		let state = reduceAgentEvent(emptyAgentState, {
			type: 'local_history',
			snapshot: value.snapshot,
		});
		for (const update of value.updates) state = reduceAgentEvent(state, update);
		const once = state;
		for (const update of value.updates) state = reduceAgentEvent(state, update);
		expect(state.messages).toEqual(once.messages);
	});
});
