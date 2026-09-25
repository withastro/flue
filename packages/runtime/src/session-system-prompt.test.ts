/**
 * The configured system prompt must reach the provider on every agent turn —
 * including after canonical context rebuilds. pi 0.87 carries the prompt in
 * the transcript's leading system message (derived read-only by the Agent),
 * and canonical conversation entries never contain it, so every rebuild must
 * re-materialize it (regression: `rebuildCanonicalContext` once discarded it,
 * and the first real request went out with `systemPrompt: ""`).
 */
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { expect, it } from 'vitest';
import { init, instrument, useModel, usePersistentState, useSandbox } from './index.ts';
import { local, sqlite, start } from './node/index.ts';
import type { FlueEvent, FlueObservation } from './types.ts';

type TurnRequestEvent = Extract<FlueEvent, { type: 'turn_request' }>;

const SENTINEL = 'You are the sentinel agent. Follow the sentinel protocol exactly.';

function agentTurnRequests(observations: FlueObservation[]): TurnRequestEvent[] {
	// `FlueObservation` is a union × detail cross product, so the `type`
	// discriminator does not narrow it; the cast picks the turn_request member.
	return observations.filter(
		(event) => event.type === 'turn_request' && event.purpose === 'agent',
	) as TurnRequestEvent[];
}

function agentTurnPrompts(observations: FlueObservation[]): string[] {
	return agentTurnRequests(observations).map((event) => event.request.input.systemPrompt ?? '');
}

function agentTurnToolNames(observations: FlueObservation[]): string[][] {
	return agentTurnRequests(observations).map((event) =>
		(event.request.input.tools ?? []).map((tool) => tool.name),
	);
}

function recordingObservations(): {
	observations: FlueObservation[];
	dispose: () => void;
} {
	const observations: FlueObservation[] = [];
	const dispose = instrument({
		dispose() {},
		observe(event) {
			observations.push(event);
		},
		interceptor(_operation, _context, next) {
			return next();
		},
	});
	return { observations, dispose };
}

it('delivers the configured prompt on the first dispatch', async () => {
	function SentinelAgent() {
		useModel('faux/model');
		return SENTINEL;
	}
	const faux = fauxProvider({ models: [{ id: 'model' }] });
	faux.setResponses([fauxAssistantMessage([fauxText('ok')], { stopReason: 'stop' })]);
	const { observations, dispose } = recordingObservations();
	const runtime = await start({
		agents: [SentinelAgent],
		db: sqlite(),
		providers: [faux.provider],
		env: {},
	});
	const agent = init(SentinelAgent, { id: 'sentinel-first' });
	try {
		await agent.read(await agent.dispatch('Hello.'));
		const prompts = agentTurnPrompts(observations);
		expect(prompts.length).toBeGreaterThan(0);
		// The framework recomposes the agent's instructions with generated
		// sections, so assert the instructions are embedded and the prompt is
		// never empty (the regression shipped `systemPrompt: ""`).
		for (const prompt of prompts) {
			expect(prompt).not.toBe('');
			expect(prompt).toContain(SENTINEL);
		}
	} finally {
		await agent.abort();
		await runtime.stop();
		await dispose();
	}
});

it('keeps the exact prompt across a transient-error retry', async () => {
	function SentinelAgent() {
		useModel('faux/model');
		return SENTINEL;
	}
	const faux = fauxProvider({ models: [{ id: 'model' }] });
	faux.setResponses([
		fauxAssistantMessage([], {
			stopReason: 'error',
			errorMessage: 'upstream server error: overloaded, retry',
		}),
		fauxAssistantMessage([fauxText('recovered')], { stopReason: 'stop' }),
	]);
	const { observations, dispose } = recordingObservations();
	const runtime = await start({
		agents: [SentinelAgent],
		db: sqlite(),
		providers: [faux.provider],
		env: {},
	});
	const agent = init(SentinelAgent, { id: 'sentinel-retry' });
	try {
		await expect(agent.read(await agent.dispatch('Hello.'))).resolves.toMatchObject({
			text: 'recovered',
		});
		const prompts = agentTurnPrompts(observations);
		expect(prompts.length).toBe(2);
		for (const prompt of prompts) {
			expect(prompt).not.toBe('');
			expect(prompt).toContain(SENTINEL);
		}
	} finally {
		await agent.abort();
		await runtime.stop();
		await dispose();
	}
});

it('rerenders the prompt from state and delivers the new one on the next turn', async () => {
	function RerenderAgent() {
		useModel('faux/model');
		const [turns, setTurns] = usePersistentState('turns', 0);
		useSandbox({
			...local(),
			tools: () => [
				{
					name: 'bump',
					label: 'Bump',
					description: 'Increment the turn counter.',
					parameters: { type: 'object', properties: {} },
					async execute() {
						setTurns(1);
						return { details: {}, content: [{ type: 'text' as const, text: 'bumped' }] };
					},
				},
			],
		});
		return turns === 0 ? 'FIRST PROMPT' : 'SECOND PROMPT';
	}
	const faux = fauxProvider({ models: [{ id: 'model' }] });
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall('bump', {}, { id: 'call_bump' })], {
			stopReason: 'toolUse',
		}),
		fauxAssistantMessage([fauxText('done')], { stopReason: 'stop' }),
	]);
	const { observations, dispose } = recordingObservations();
	const runtime = await start({
		agents: [RerenderAgent],
		db: sqlite(),
		providers: [faux.provider],
		env: {},
	});
	const agent = init(RerenderAgent, { id: 'sentinel-rerender' });
	try {
		await agent.read(await agent.dispatch('Use the bump tool.'));
		const prompts = agentTurnPrompts(observations);
		expect(prompts).toHaveLength(2);
		expect(prompts[0]).toContain('FIRST PROMPT');
		expect(prompts[1]).toContain('SECOND PROMPT');
	} finally {
		await agent.abort();
		await runtime.stop();
		await dispose();
	}
});

it('rebuilds the prompt + tools after a canonical rebuild (tool-batch repair recovery)', async () => {
	function RecoverAgent() {
		useModel('faux/model');
		const [phase] = usePersistentState('phase', 'initial');
		useSandbox({
			...local(),
			tools: () => [
				{
					name: 'blocking',
					label: 'Blocking',
					description: 'Blocks until the session aborts.',
					parameters: { type: 'object', properties: {} },
					executionMode: 'sequential',
					async execute(_id, _args, signal) {
						return await new Promise<never>((_resolve, reject) => {
							if (!signal) return reject(new Error('No abort signal'));
							if (signal.aborted) reject(signal.reason);
							else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
						});
					},
				},
			],
		});
		phase;
		return SENTINEL;
	}
	const faux = fauxProvider({ models: [{ id: 'model' }] });
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall('blocking', {}, { id: 'call_blocking' })], {
			stopReason: 'toolUse',
		}),
		fauxAssistantMessage([fauxText('recovered')], { stopReason: 'stop' }),
	]);
	const { observations, dispose } = recordingObservations();
	const runtime = await start({
		agents: [RecoverAgent],
		db: sqlite(),
		providers: [faux.provider],
		env: {},
	});
	const agent = init(RecoverAgent, { id: 'sentinel-recovery' });
	try {
		const receipt = await agent.dispatch('Run the blocking tool.');
		await new Promise((resolve) => setTimeout(resolve, 50));
		await agent.abort();
		await expect(agent.read(receipt)).rejects.toMatchObject({ name: 'AgentRunError' });
		await agent.read(await agent.dispatch('Continue.'));
		const prompts = agentTurnPrompts(observations);
		expect(prompts.at(-1)).not.toBe('');
		expect(prompts.at(-1)).toContain(SENTINEL);
		const tools = agentTurnToolNames(observations);
		expect(tools.at(-1)).toContain('blocking');
	} finally {
		await agent.abort();
		await runtime.stop();
		await dispose();
	}
});
it('keeps the configured prompt after an overflow compaction', async () => {
	function CompactAgent() {
		useModel('faux/model', { compaction: false });
		return SENTINEL;
	}
	const longMessage = 'x'.repeat(70_000);
	const faux = fauxProvider({
		models: [{ id: 'model', contextWindow: 32_768, maxTokens: 4_096 }],
	});
	faux.setResponses([
		fauxAssistantMessage([fauxText('First response.')], { stopReason: 'stop' }),
		fauxAssistantMessage([fauxText('Completed response.')], { stopReason: 'stop' }),
		fauxAssistantMessage([fauxText('Conversation summary.')], { stopReason: 'stop' }),
	]);
	const { observations, dispose } = recordingObservations();
	const runtime = await start({
		agents: [CompactAgent],
		db: sqlite(),
		providers: [faux.provider],
		env: {},
	});
	const agent = init(CompactAgent, { id: 'sentinel-compaction' });
	try {
		await agent.read(await agent.dispatch(longMessage));
		await expect(agent.read(await agent.dispatch(longMessage))).resolves.toMatchObject({
			text: 'Completed response.',
		});
		expect(observations.some((event) => event.type === 'compaction' && !event.isError)).toBe(true);
		const prompts = agentTurnPrompts(observations);
		expect(prompts.length).toBeGreaterThan(0);
		// The turn after the compaction fold must still carry the instructions.
		for (const prompt of prompts) {
			expect(prompt).not.toBe('');
			expect(prompt).toContain(SENTINEL);
		}
	} finally {
		await agent.abort();
		await runtime.stop();
		await dispose();
	}
});
