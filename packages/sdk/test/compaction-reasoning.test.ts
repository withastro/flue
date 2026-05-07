/**
 * F6/6 + F9: compaction must not inherit per-call / role / session reasoning.
 * It takes only the agent-level `reasoning: 'off'` opt-out as input;
 * anything else leaves the internal `'high'` default in place.
 *
 * The production guard lives in `src/compaction.ts` inside a private
 * function (`generateSummary`). Exercising it end-to-end would require a
 * fetch mock for `completeSimple`, which is disproportionate to the
 * surface this test protects. Instead we take two cheap signals:
 *
 *   1) A local mirror of the guard, to document the intended semantics
 *      in isolation. This is test-theatre in the strict sense — changing
 *      `compaction.ts` would not fail these assertions.
 *
 *   2) A source-text check that the actual guard condition in
 *      `compaction.ts` matches the expected expression. That *does* fail
 *      if someone flips `!==` to `===` or drops the model check.
 *
 * Together they cover "the rule is X" and "the code spells it the same
 * way". If you rewrite compaction to use a different expression, update
 * this file (that's the point).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── 1) Semantic mirror ────────────────────────────────────────────────────

function shouldUseHighReasoning(
	modelReasoning: boolean,
	agentReasoning: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | undefined,
): boolean {
	return modelReasoning && agentReasoning !== 'off';
}

describe('compaction reasoning guard (semantic mirror)', () => {
	it('uses high when model supports reasoning and agent did not opt out', () => {
		assert.equal(shouldUseHighReasoning(true, undefined), true);
		assert.equal(shouldUseHighReasoning(true, 'medium'), true);
		assert.equal(shouldUseHighReasoning(true, 'low'), true);
		assert.equal(shouldUseHighReasoning(true, 'xhigh'), true);
	});

	it('skips reasoning when model does not support it', () => {
		assert.equal(shouldUseHighReasoning(false, undefined), false);
		assert.equal(shouldUseHighReasoning(false, 'high'), false);
	});

	it('respects agent-level "off" even on reasoning-capable models', () => {
		assert.equal(shouldUseHighReasoning(true, 'off'), false);
	});
});

// ─── 2) Source-text anchor ─────────────────────────────────────────────────

describe('compaction reasoning guard (source anchor)', () => {
	it('still spells the guard the way the mirror above expects', () => {
		// Reads the production source file and asserts the guard expression
		// is textually present. This catches a refactor that changes the
		// semantics (e.g. dropping the `!== 'off'` check) without updating
		// this test file alongside it.
		const here = dirname(fileURLToPath(import.meta.url));
		const src = readFileSync(join(here, '..', 'src', 'compaction.ts'), 'utf-8');

		// Normalise whitespace before matching so a reformat doesn't break us.
		const normalised = src.replace(/\s+/g, ' ');

		assert.match(
			normalised,
			/if \(model\.reasoning && reasoning !== 'off'\) \{ completionOptions\.reasoning = 'high'; \}/,
			'compaction.ts no longer contains the expected guard expression — ' +
				'update test/compaction-reasoning.test.ts if the semantics changed intentionally.',
		);
	});

	it('exports compact and prepareCompaction', async () => {
		// Light shape check: the session call site imports these by name.
		// We don't assert arity here (optional params with defaults don't
		// count, which makes Function.length a brittle signal; F10).
		const mod = await import('../src/compaction.ts');
		assert.equal(typeof mod.compact, 'function');
		assert.equal(typeof mod.prepareCompaction, 'function');
	});
});
