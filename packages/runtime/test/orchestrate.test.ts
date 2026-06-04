import { describe, it, expect, vi } from 'vitest';
import { parallel, pipeline, phase, log, registerWorkflow } from '../src/orchestrate.ts';
import type { FlueSession, PromptResponse } from '../src/types.ts';

function createMockSession(responses: Record<string, string> = {}): FlueSession {
	const taskFn = vi.fn(async (prompt: string): Promise<PromptResponse> => {
		const key = Object.keys(responses).find((k) => prompt.includes(k));
		const text = key ? responses[key] : `response-for-${prompt.slice(0, 20)}`;
		await new Promise((r) => setTimeout(r, 10));
		return { text } as PromptResponse;
	});
	return { task: taskFn } as unknown as FlueSession;
}

function createFailingSession(failOn: string[]): FlueSession {
	const taskFn = vi.fn(async (prompt: string): Promise<PromptResponse> => {
		await new Promise((r) => setTimeout(r, 5));
		if (failOn.some((f) => prompt.includes(f))) {
			throw new Error(`Task failed: ${prompt}`);
		}
		return { text: `ok-for-${prompt.slice(0, 10)}` } as PromptResponse;
	});
	return { task: taskFn } as unknown as FlueSession;
}

describe('parallel()', () => {
	it('runs multiple tasks and returns all results', async () => {
		const session = createMockSession({
			'Analyze auth flow': 'auth-analysis',
			'Analyze rate limiting': 'rate-analysis',
			'Analyze cache strategy': 'cache-analysis',
		});

		const results = await parallel(session, [
			{ prompt: 'Analyze auth flow' },
			{ prompt: 'Analyze rate limiting' },
			{ prompt: 'Analyze cache strategy' },
		]);

		expect(results).toHaveLength(3);
		expect(results[0]?.text).toBe('auth-analysis');
		expect(results[1]?.text).toBe('rate-analysis');
		expect(results[2]?.text).toBe('cache-analysis');
	});

	it('returns empty array for empty input', async () => {
		const results = await parallel({} as FlueSession, []);
		expect(results).toEqual([]);
	});

	it('respects concurrency limit', async () => {
		let concurrent = 0;
		let maxConcurrent = 0;

		const session = {
			task: vi.fn(async (): Promise<PromptResponse> => {
				concurrent++;
				maxConcurrent = Math.max(maxConcurrent, concurrent);
				await new Promise((r) => setTimeout(r, 50));
				concurrent--;
				return { text: 'done' } as PromptResponse;
			}),
		} as unknown as FlueSession;

		await parallel(
			session,
			Array.from({ length: 10 }, (_, i) => ({ prompt: `task-${i}` })),
			{ concurrency: 3 },
		);

		expect(maxConcurrent).toBeLessThanOrEqual(3);
	});

	it('lenient mode: failed tasks return null, others complete', async () => {
		const session = createFailingSession(['dangerous']);
		const results = await parallel(session, [
			{ prompt: 'safe task 1' },
			{ prompt: 'dangerous task' },
			{ prompt: 'safe task 2' },
		]);

		expect(results).toHaveLength(3);
		expect(results[0]?.text).toContain('ok-for');
		expect(results[1]).toBeNull();
		expect(results[2]?.text).toContain('ok-for');
	});

	it('strict mode: first failure aborts remaining tasks', async () => {
		const session = createFailingSession(['fail']);
		await expect(
			parallel(session, [
				{ prompt: 'ok task' },
				{ prompt: 'fail task' },
				{ prompt: 'should not run' },
			], { failMode: 'strict' }),
		).rejects.toThrow('Task failed');
	});

	it('passes agent and cwd options to session.task()', async () => {
		const session = createMockSession();
		await parallel(session, [
			{ prompt: 'do work', agent: 'researcher', cwd: '/workspace' },
		]);

		expect(session.task).toHaveBeenCalledWith('do work', expect.objectContaining({
			agent: 'researcher',
			cwd: '/workspace',
		}));
	});
});

describe('pipeline()', () => {
	it('processes items through sequential stages', async () => {
		const session = createMockSession({
			Analyze: 'analyzed-result',
			Verify: 'verified-result',
			Format: 'formatted-result',
		});

		const items: PromptResponse[] = [{ text: 'raw-data-1' } as PromptResponse];

		const results = await pipeline(session, items, [
			(input) => ({ prompt: `Analyze: ${input.text}` }),
			(input) => ({ prompt: `Verify: ${input.text}` }),
			(input) => ({ prompt: `Format: ${input.text}` }),
		]);

		expect(results).toHaveLength(1);
		expect(results[0]?.text).toBe('formatted-result');
		expect(session.task).toHaveBeenCalledTimes(3);
	});

	it('processes multiple items concurrently', async () => {
		const session = createMockSession();
		const items: PromptResponse[] = [
			{ text: 'item-1' } as PromptResponse,
			{ text: 'item-2' } as PromptResponse,
			{ text: 'item-3' } as PromptResponse,
		];

		const results = await pipeline(session, items, [
			(input) => ({ prompt: `Process: ${input.text}` }),
		]);

		expect(results).toHaveLength(3);
		expect(results.every((r) => r !== null)).toBe(true);
	});

	it('returns empty for empty items or stages', async () => {
		expect(await pipeline({} as FlueSession, [], [])).toEqual([]);
		expect(await pipeline({} as FlueSession, [{ text: 'x' } as PromptResponse], [])).toEqual([]);
	});

	it('failed items return null without crashing others', async () => {
		const session = createFailingSession(['bad']);
		const items: PromptResponse[] = [
			{ text: 'good' } as PromptResponse,
			{ text: 'bad' } as PromptResponse,
			{ text: 'good' } as PromptResponse,
		];

		const results = await pipeline(session, items, [
			(input) => ({ prompt: `Process: ${input.text}` }),
		]);

		expect(results).toHaveLength(3);
		expect(results[0]).not.toBeNull();
		expect(results[1]).toBeNull();
		expect(results[2]).not.toBeNull();
	});

	it('supports named workflows as string stages', async () => {
		const session = createMockSession({ 'Run full analysis on': 'analyzed' });

		registerWorkflow('full-analysis', async (input) => {
			return session.task(`Run full analysis on: ${input.text}`);
		});

		const items: PromptResponse[] = [{ text: 'ticket-42' } as PromptResponse];
		const results = await pipeline(session, items, [
			'full-analysis',
			(input) => ({ prompt: `Summarize: ${input.text}` }),
		]);

		expect(results).toHaveLength(1);
		expect(results[0]?.text).toBeDefined();
	});

	it('throws for unknown workflow name', async () => {
		const items: PromptResponse[] = [{ text: 'x' } as PromptResponse];
		await expect(
			pipeline(createMockSession(), items, ['nonexistent-workflow']),
		).rejects.toThrow('Unknown workflow');
	});
});

describe('phase() and log()', () => {
	it('phase() outputs to console', () => {
		const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
		phase('Research');
		expect(spy).toHaveBeenCalledWith(expect.stringContaining('Research'));
		spy.mockRestore();
	});

	it('log() outputs to console', () => {
		const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
		log('Found 5 items');
		expect(spy).toHaveBeenCalledWith(expect.stringContaining('Found 5 items'));
		spy.mockRestore();
	});
});
