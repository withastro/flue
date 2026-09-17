import { describe, expect, it } from 'vitest';
import { raceToolWithDeadline, ToolTimeoutError } from './abort.ts';

function hangOnSignal(signal?: AbortSignal): Promise<string> {
	// Signal-aware: reject with the signal's reason when it fires, like a
	// well-behaved tool reacting to its own `context.signal` aborting.
	return new Promise((_resolve, reject) => {
		if (signal?.aborted) reject(signal.reason);
		else signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
	});
}

describe('raceToolWithDeadline', () => {
	it('settles a hung run with a ToolTimeoutError when the deadline expires', async () => {
		let started = false;
		const error = await raceToolWithDeadline(
			async () => {
				started = true;
				return hangOnSignal();
			},
			undefined,
			20,
			'fetch',
		).then(
			() => null,
			(error) => error,
		);
		expect(started).toBe(true);
		expect(error).toBeInstanceOf(ToolTimeoutError);
		expect((error as ToolTimeoutError).toolName).toBe('fetch');
		expect((error as ToolTimeoutError).timeoutMs).toBe(20);
		expect((error as Error).message).toBe('Tool "fetch" timed out after 20ms');
	});

	it('times out even when the run ignores its signal entirely', async () => {
		const error = await raceToolWithDeadline(
			() => new Promise<string>(() => {}),
			undefined,
			10,
			'signal-deaf',
		).then(
			() => null,
			(error) => error,
		);
		expect(error).toBeInstanceOf(ToolTimeoutError);
		expect((error as Error).message).toContain('signal-deaf');
	});

	it('settles with the timeout error even when the run rejects on its own signal first', async () => {
		// The run observes the composed signal aborting and throws the
		// signal's own reason — the deadline still wins deterministically.
		const error = await raceToolWithDeadline(
			() => hangOnSignal(),
			undefined,
			10,
			'well-behaved',
		).then(
			() => null,
			(error) => error,
		);
		expect(error).toBeInstanceOf(ToolTimeoutError);
	});

	it('passes a host abort through as an abort error, not a timeout', async () => {
		const controller = new AbortController();
		controller.abort(new DOMException('host cancelled', 'AbortError'));
		const error = await raceToolWithDeadline(
			() => hangOnSignal(),
			controller.signal,
			10_000,
			'fetch',
		).then(
			() => null,
			(error) => error,
		);
		expect(error).toBeInstanceOf(DOMException);
		expect((error as DOMException).name).toBe('AbortError');
		expect(error).not.toBeInstanceOf(ToolTimeoutError);
	});

	it('resolves normally when the run finishes before the deadline', async () => {
		const result = await raceToolWithDeadline(async () => 'done', undefined, 1_000, 'quick');
		expect(result).toBe('done');
	});

	it('passes a thrown tool error through unchanged', async () => {
		const boom = new Error('boom');
		const error = await raceToolWithDeadline(
			async () => {
				throw boom;
			},
			undefined,
			1_000,
			'fetch',
		).then(
			() => null,
			(error) => error,
		);
		expect(error).toBe(boom);
	});

	it('discards the abandoned run late settlement without an unhandled rejection', async () => {
		const late = Promise.withResolvers<string>();
		const error = await raceToolWithDeadline(
			async () => {
				void late.promise;
				return new Promise<string>(() => {});
			},
			undefined,
			1,
			'fetch',
		).then(
			() => null,
			(error) => error,
		);
		expect(error).toBeInstanceOf(ToolTimeoutError);
		// The abandoned run's promise resolves later; the race already consumed
		// both settlement paths, so this must not surface as an unhandled
		// rejection (vitest fails the run if it does).
		late.resolve('late');
		await new Promise((resolve) => setTimeout(resolve, 10));
	});
});
