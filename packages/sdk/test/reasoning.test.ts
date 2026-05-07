/**
 * Unit tests for the reasoning option resolver.
 *
 * Covers:
 *   - Precedence (call > role > session > agent) for reasoning.
 *   - `"off"` semantics: allowed at init / role / session tiers, rejected per-call.
 *   - Validation against non-reasoning models: throws a clear error naming the field.
 *   - Frontmatter parsing for role files: accepts known levels, rejects typos.
 *
 * The actual forwarding sink is `harness.state.thinkingLevel` inside pi-agent-core,
 * which maps it to `SimpleStreamOptions.reasoning` on every stream call (see
 * `agent.js:createLoopConfig`). These tests pin down the decision logic that
 * feeds that sink. An end-to-end snapshot of the outgoing HTTP body is tracked
 * as follow-up (see changeset).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
	parseReasoningFrontmatter,
	resolveCallReasoning,
} from '../src/roles.ts';
import type { Role } from '../src/types.ts';

// ─── Fixtures ───────────────────────────────────────────────────────────────

function reasoningModel() {
	return {
		id: 'claude-opus-4-7',
		name: 'Claude Opus 4.7',
		api: 'anthropic-messages',
		provider: 'anthropic',
		baseUrl: 'https://example.test',
		reasoning: true,
		input: ['text'],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8192,
	} as const;
}

function nonReasoningModel() {
	return {
		...reasoningModel(),
		id: 'claude-haiku-4-5',
		reasoning: false,
	} as const;
}

function roles(): Record<string, Role> {
	return {
		researcher: {
			name: 'researcher',
			description: '',
			instructions: '',
			reasoning: 'low',
		},
		planner: {
			name: 'planner',
			description: '',
			instructions: '',
			// No reasoning declared — should fall through to session/agent.
		},
		quiet: {
			name: 'quiet',
			description: '',
			instructions: '',
			reasoning: 'off',
		},
	};
}

// ─── resolveCallReasoning ───────────────────────────────────────────────────

describe('resolveCallReasoning precedence', () => {
	it('returns undefined when no tier configures reasoning', () => {
		const resolved = resolveCallReasoning({
			roles: {},
			model: reasoningModel() as any,
			callSite: 'test',
		});
		assert.equal(resolved, undefined);
	});

	it('uses the agent default when nothing else is set', () => {
		const resolved = resolveCallReasoning({
			roles: {},
			agentReasoning: 'medium',
			model: reasoningModel() as any,
			callSite: 'test',
		});
		assert.equal(resolved, 'medium');
	});

	it('session beats agent', () => {
		const resolved = resolveCallReasoning({
			roles: {},
			agentReasoning: 'medium',
			sessionReasoning: 'high',
			model: reasoningModel() as any,
			callSite: 'test',
		});
		assert.equal(resolved, 'high');
	});

	it('role beats session and agent', () => {
		const resolved = resolveCallReasoning({
			roles: roles(),
			roleName: 'researcher',
			agentReasoning: 'medium',
			sessionReasoning: 'high',
			model: reasoningModel() as any,
			callSite: 'test',
		});
		assert.equal(resolved, 'low');
	});

	it('call-level beats everything else', () => {
		const resolved = resolveCallReasoning({
			roles: roles(),
			roleName: 'researcher',
			agentReasoning: 'medium',
			sessionReasoning: 'high',
			callReasoning: 'xhigh',
			model: reasoningModel() as any,
			callSite: 'test',
		});
		assert.equal(resolved, 'xhigh');
	});

	it('call-level beats a role that set reasoning to "off"', () => {
		// F6/1: `"off"` is a value, not a wildcard. A per-call effort must
		// override a role-level opt-out, confirming that roles don't lock
		// out higher tiers for individual calls that need them.
		const resolved = resolveCallReasoning({
			roles: roles(),
			roleName: 'quiet',
			agentReasoning: 'low',
			callReasoning: 'xhigh',
			model: reasoningModel() as any,
			callSite: 'test',
		});
		assert.equal(resolved, 'xhigh');
	});

	it('call-level beats a session default of "off"', () => {
		// F6/2: same semantics for session tier.
		const resolved = resolveCallReasoning({
			roles: {},
			sessionReasoning: 'off',
			callReasoning: 'high',
			model: reasoningModel() as any,
			callSite: 'test',
		});
		assert.equal(resolved, 'high');
	});

	it('role without reasoning falls through to session', () => {
		const resolved = resolveCallReasoning({
			roles: roles(),
			roleName: 'planner',
			agentReasoning: 'medium',
			sessionReasoning: 'high',
			model: reasoningModel() as any,
			callSite: 'test',
		});
		assert.equal(resolved, 'high');
	});

	it('honors role "off" even when agent default is set', () => {
		const resolved = resolveCallReasoning({
			roles: roles(),
			roleName: 'quiet',
			agentReasoning: 'high',
			model: reasoningModel() as any,
			callSite: 'test',
		});
		assert.equal(resolved, 'off');
	});

	it('honors agent "off" when nothing overrides it', () => {
		const resolved = resolveCallReasoning({
			roles: {},
			agentReasoning: 'off',
			model: reasoningModel() as any,
			callSite: 'test',
		});
		assert.equal(resolved, 'off');
	});
});

// ─── resolveCallReasoning: validation errors ────────────────────────────────

describe('resolveCallReasoning validation', () => {
	it('throws a clear error when the resolved model does not support reasoning', () => {
		assert.throws(
			() =>
				resolveCallReasoning({
					roles: {},
					callReasoning: 'high',
					model: nonReasoningModel() as any,
					callSite: 'this prompt() call',
				}),
			(err: Error) => {
				// Message must name the field, the model, and the call site.
				assert.match(err.message, /reasoning/);
				assert.match(err.message, /anthropic\/claude-haiku-4-5/);
				assert.match(err.message, /this prompt\(\) call/);
				return true;
			},
		);
	});

	it('throws when a non-reasoning model is paired with an inherited agent default', () => {
		// An agent-level reasoning default should not silently no-op on a
		// non-reasoning model — surface it.
		assert.throws(
			() =>
				resolveCallReasoning({
					roles: {},
					agentReasoning: 'medium',
					model: nonReasoningModel() as any,
					callSite: 'this skill("x") call',
				}),
			/not supported by model/,
		);
	});

	it('rejects "off" as a per-call value', () => {
		assert.throws(
			() =>
				resolveCallReasoning({
					roles: {},
					// Bypass the public type system — "off" must be rejected at runtime
					// even when something slips past the compile-time surface.
					callReasoning: 'off' as any,
					model: reasoningModel() as any,
					callSite: 'this prompt() call',
				}),
			/"off" is only valid as an agent-level or role-level default/,
		);
	});

	it('allows "off" at the agent/role/session tiers against any model', () => {
		// "off" means "do not request reasoning" — so no model capability check
		// is needed. Verified via the non-reasoning model not throwing.
		const resolved = resolveCallReasoning({
			roles: {},
			agentReasoning: 'off',
			model: nonReasoningModel() as any,
			callSite: 'test',
		});
		assert.equal(resolved, 'off');
	});
});

// ─── parseReasoningFrontmatter ──────────────────────────────────────────────

describe('parseReasoningFrontmatter', () => {
	it('accepts every known level', () => {
		for (const level of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const) {
			assert.equal(parseReasoningFrontmatter(level, 'role "x"'), level);
		}
	});

	it('trims whitespace and normalises case', () => {
		assert.equal(parseReasoningFrontmatter('  HIGH  ', 'role "x"'), 'high');
	});

	it('returns undefined for missing / empty values', () => {
		assert.equal(parseReasoningFrontmatter(undefined, 'role "x"'), undefined);
		assert.equal(parseReasoningFrontmatter('', 'role "x"'), undefined);
		assert.equal(parseReasoningFrontmatter('   ', 'role "x"'), undefined);
	});

	it('throws on unknown values, naming the source for debuggability', () => {
		assert.throws(
			() => parseReasoningFrontmatter('reallyhigh', 'role "planner" (roles/planner.md)'),
			(err: Error) => {
				assert.match(err.message, /Invalid reasoning level "reallyhigh"/);
				assert.match(err.message, /role "planner" \(roles\/planner\.md\)/);
				assert.match(err.message, /off, minimal, low, medium, high, xhigh/);
				return true;
			},
		);
	});
});
