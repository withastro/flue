/**
 * Internal helpers for aggregating `PromptUsage`. Not re-exported from the
 * public SDK entry — they're an implementation detail of how prompt(),
 * skill(), task() and compaction roll up token + cost figures.
 *
 * Kept in their own module to share between `session.ts` (per-call
 * aggregation across the active path) and `session.ts`'s compaction
 * persistence path (normalizing pi-ai's `Usage` into our `PromptUsage`
 * before storing on a `CompactionEntry`).
 */
import type { Usage } from '@mariozechner/pi-ai';
import type { PromptUsage } from './types.ts';

/** All-zero `PromptUsage`. Identity element for `addUsage`. */
export function emptyUsage(): PromptUsage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/**
 * Field-wise sum of two `PromptUsage` values, including the nested `cost`
 * sub-object. Returns a fresh object; neither argument is mutated.
 */
export function addUsage(a: PromptUsage, b: PromptUsage): PromptUsage {
	return {
		input: a.input + b.input,
		output: a.output + b.output,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheWrite: a.cacheWrite + b.cacheWrite,
		totalTokens: a.totalTokens + b.totalTokens,
		cost: {
			input: a.cost.input + b.cost.input,
			output: a.cost.output + b.cost.output,
			cacheRead: a.cost.cacheRead + b.cost.cacheRead,
			cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite,
			total: a.cost.total + b.cost.total,
		},
	};
}

/**
 * Convert pi-ai's `Usage` into Flue's public `PromptUsage`. The shapes are
 * structurally identical today, but going through this normalizer keeps
 * Flue's public types decoupled from pi-ai's so future divergence in
 * pi-ai (e.g. additional fields) doesn't leak into the SDK's public
 * surface. Returns `undefined` when the input is `undefined`.
 */
export function fromProviderUsage(usage: Usage | undefined): PromptUsage | undefined {
	if (!usage) return undefined;
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		totalTokens: usage.totalTokens,
		cost: {
			input: usage.cost.input,
			output: usage.cost.output,
			cacheRead: usage.cost.cacheRead,
			cacheWrite: usage.cost.cacheWrite,
			total: usage.cost.total,
		},
	};
}
