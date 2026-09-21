import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createTurnDeadline } from './agent-coordinator.ts';

const HOUR = 60 * 60 * 1000;

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

it('aborts at the deadline it was armed with', () => {
	const abort = vi.fn();
	const deadline = createTurnDeadline(Date.now() + 5_000, abort);

	vi.advanceTimersByTime(4_999);
	expect(abort).not.toHaveBeenCalled();
	expect(deadline.expired()).toBe(false);

	vi.advanceTimersByTime(1);
	expect(abort).toHaveBeenCalledTimes(1);
	expect(deadline.expired()).toBe(true);
	deadline.clear();
});

it('re-arms past the claim-time placeholder when the session stamps a longer deadline', () => {
	const abort = vi.fn();
	const startedAt = Date.now();
	// What `claimSubmission` writes before the session resolves the agent's
	// configured durability timeout.
	const deadline = createTurnDeadline(startedAt + HOUR, abort);
	deadline.arm(startedAt + 3 * HOUR);

	vi.advanceTimersByTime(HOUR);
	expect(abort).not.toHaveBeenCalled();
	expect(deadline.expired()).toBe(false);

	vi.advanceTimersByTime(2 * HOUR);
	expect(abort).toHaveBeenCalledTimes(1);
	expect(deadline.expired()).toBe(true);
	deadline.clear();
});

it('re-arms short of the placeholder when the stamped deadline is nearer', () => {
	const abort = vi.fn();
	const startedAt = Date.now();
	const deadline = createTurnDeadline(startedAt + HOUR, abort);
	deadline.arm(startedAt + 10_000);

	vi.advanceTimersByTime(10_000);
	expect(abort).toHaveBeenCalledTimes(1);
	expect(deadline.expired()).toBe(true);

	// The placeholder's timer was cleared by the re-arm, so it cannot abort again.
	vi.advanceTimersByTime(HOUR);
	expect(abort).toHaveBeenCalledTimes(1);
	deadline.clear();
});

it('stays unarmed when the row carries no deadline', () => {
	const abort = vi.fn();
	const deadline = createTurnDeadline(0, abort);

	vi.advanceTimersByTime(HOUR);
	expect(abort).not.toHaveBeenCalled();
	expect(deadline.expired()).toBe(false);

	deadline.arm(Date.now() + 1_000);
	vi.advanceTimersByTime(1_000);
	expect(abort).toHaveBeenCalledTimes(1);
	deadline.clear();
});

it('clear stops the armed timer', () => {
	const abort = vi.fn();
	const deadline = createTurnDeadline(Date.now() + 1_000, abort);
	deadline.clear();

	vi.advanceTimersByTime(HOUR);
	expect(abort).not.toHaveBeenCalled();
});
