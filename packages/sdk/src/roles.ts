import type { Model } from '@mariozechner/pi-ai';
import type { ModelThinkingLevel, Role, ThinkingLevel } from './types.ts';

export function assertRoleExists(roles: Record<string, Role>, roleName: string | undefined): void {
	if (!roleName) return;
	if (roles[roleName]) return;
	const available = Object.keys(roles);
	const list = available.length > 0 ? available.join(', ') : '(none defined)';
	throw new Error(
		`[flue] Role "${roleName}" not registered. Available roles: ${list}. ` +
			`Define roles as markdown files in \`roles/\` (or \`.flue/roles/\`).`,
	);
}

export function resolveEffectiveRole(options: {
	roles: Record<string, Role>;
	agentRole?: string;
	sessionRole?: string;
	callRole?: string;
}): string | undefined {
	const role = options.callRole ?? options.sessionRole ?? options.agentRole;
	assertRoleExists(options.roles, role);
	return role;
}

export function resolveRoleModel(
	roles: Record<string, Role>,
	roleName: string | undefined,
): string | undefined {
	assertRoleExists(roles, roleName);
	return roleName ? roles[roleName]?.model : undefined;
}

/**
 * Resolve the role-level reasoning default (if any). Returns `undefined` when
 * the role is unset or declares no reasoning preference, so callers can fall
 * through to the next tier in the precedence chain.
 */
export function resolveRoleReasoning(
	roles: Record<string, Role>,
	roleName: string | undefined,
): ModelThinkingLevel | undefined {
	assertRoleExists(roles, roleName);
	return roleName ? roles[roleName]?.reasoning : undefined;
}

const VALID_REASONING_LEVELS: readonly ModelThinkingLevel[] = [
	'off',
	'minimal',
	'low',
	'medium',
	'high',
	'xhigh',
];

/**
 * Parse a `reasoning:` frontmatter value from a role markdown file. Keeps
 * parsing strict — unknown levels throw so typos surface at build time.
 *
 * Defensive against non-string inputs: the built-in frontmatter parser
 * always produces strings, but a future swap to a YAML 1.1 parser would
 * coerce bare `off`/`on` to booleans, so we reject non-strings with a
 * clear message that tells the author to quote the value.
 */
export function parseReasoningFrontmatter(
	raw: unknown,
	sourceLabel: string,
): ModelThinkingLevel | undefined {
	if (raw === undefined || raw === null) return undefined;
	if (typeof raw !== 'string') {
		throw new Error(
			`[flue] Invalid reasoning value in ${sourceLabel}: expected a string, ` +
				`got ${typeof raw} (${JSON.stringify(raw)}). ` +
				`Quote the value — e.g. \`reasoning: "off"\` — to avoid YAML boolean coercion.`,
		);
	}
	const normalized = raw.trim().toLowerCase();
	if (!normalized) return undefined;
	if (!(VALID_REASONING_LEVELS as readonly string[]).includes(normalized)) {
		throw new Error(
			`[flue] Invalid reasoning level "${raw}" in ${sourceLabel}. ` +
				`Expected one of: ${VALID_REASONING_LEVELS.join(', ')}.`,
		);
	}
	return normalized as ModelThinkingLevel;
}

interface ResolveReasoningArgs {
	roles: Record<string, Role>;
	agentReasoning?: ModelThinkingLevel;
	sessionReasoning?: ModelThinkingLevel;
	roleName?: string;
	callReasoning?: ThinkingLevel;
	model: Model<any>;
	callSite: string;
}

/**
 * Resolve the effective reasoning level for a call using the same precedence
 * model uses: call > role > session > agent.
 *
 * Validates that the resolved model actually supports reasoning. Throws with
 * a clear message naming the field and the model when it does not.
 *
 * Returns `undefined` when no reasoning is configured at any tier — the
 * harness leaves `thinkingLevel` as `"off"`, matching the legacy behaviour.
 */
export function resolveCallReasoning(
	args: ResolveReasoningArgs,
): ModelThinkingLevel | undefined {
	const { roles, agentReasoning, sessionReasoning, roleName, callReasoning, model, callSite } =
		args;

	const roleReasoning = resolveRoleReasoning(roles, roleName);
	const effective: ModelThinkingLevel | undefined =
		callReasoning ?? roleReasoning ?? sessionReasoning ?? agentReasoning;

	if (effective === undefined) return undefined;

	// Per-call `reasoning` must be a concrete level — `"off"` is only a
	// default/init-time escape hatch. Per-call code picks an effort level or
	// omits the field entirely.
	if (callReasoning !== undefined && (callReasoning as ModelThinkingLevel) === 'off') {
		throw new Error(
			`[flue] Invalid per-call reasoning value "off" for ${callSite}. ` +
				`"off" is only valid as an agent-level or role-level default. ` +
				`Omit the \`reasoning\` option to use the default instead.`,
		);
	}

	// A value of `"off"` at any tier explicitly disables reasoning; no
	// reasoning-capable model is required to honor that.
	if (effective === 'off') return 'off';

	if (!model.reasoning) {
		throw new Error(
			`[flue] \`reasoning\` option is not supported by model "${model.provider}/${model.id}" ` +
				`(pi-ai metadata reports reasoning=false). Called from ${callSite}. ` +
				`Use a reasoning-capable model or remove the \`reasoning\` option.`,
		);
	}

	return effective;
}
