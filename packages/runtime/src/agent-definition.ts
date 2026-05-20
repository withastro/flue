import * as v from 'valibot';
import type { AgentDefinition, Skill, ThinkingLevel, ToolDefinition } from './types.ts';

const AGENT_DEFINITION_FIELDS = new Set([
	'model',
	'instructions',
	'skills',
	'tools',
	'subagents',
	'thinkingLevel',
	'compaction',
]);

const VALID_THINKING_LEVELS = {
	off: true,
	minimal: true,
	low: true,
	medium: true,
	high: true,
	xhigh: true,
} as const satisfies Record<ThinkingLevel, true>;

const AgentDefinitionSchema = v.looseObject({
	model: v.optional(v.union([v.string(), v.literal(false)])),
	instructions: v.optional(v.string()),
	skills: v.optional(v.array(v.unknown())),
	tools: v.optional(v.array(v.unknown())),
	subagents: v.optional(v.array(v.unknown())),
	thinkingLevel: v.optional(v.string()),
	compaction: v.optional(v.union([v.literal(false), v.looseObject({})])),
});

export function defineAgent(definition: AgentDefinition): AgentDefinition {
	assertAgentDefinition(definition, 'defineAgent()', new WeakSet());
	return definition;
}

function assertAgentDefinition(
	value: unknown,
	label: string,
	activeDefinitions: WeakSet<object>,
): asserts value is AgentDefinition {
	const parsed = v.safeParse(AgentDefinitionSchema, value);
	if (!parsed.success) {
		throw new Error(`[flue] ${label} requires a valid agent definition: ${formatIssues(parsed.issues)}.`);
	}

	const definition = parsed.output as AgentDefinition;
	const source = value as object;
	if (activeDefinitions.has(source)) {
		throw new Error(`[flue] ${label} must not contain circular subagents.`);
	}
	activeDefinitions.add(source);

	assertKnownFields(definition, label);
	assertThinkingLevel(definition.thinkingLevel, label);
	assertCompaction(definition.compaction, label);
	assertTools(definition.tools, label);
	assertSkills(definition.skills, label);
	assertUniqueNames(definition.tools, `${label} tools`, 'tool');
	assertUniqueNames(definition.skills, `${label} skills`, 'skill');

	for (const [index, subagent] of definition.subagents?.entries() ?? []) {
		assertAgentDefinition(subagent, `${label} subagents[${index}]`, activeDefinitions);
	}

	activeDefinitions.delete(source);
}

function assertKnownFields(definition: AgentDefinition, label: string): void {
	for (const key of Object.keys(definition)) {
		if (!AGENT_DEFINITION_FIELDS.has(key)) {
			throw new Error(`[flue] ${label} received unknown agent definition field "${key}".`);
		}
	}
}

function assertThinkingLevel(value: ThinkingLevel | undefined, label: string): void {
	if (value !== undefined && !(value in VALID_THINKING_LEVELS)) {
		throw new Error(
			`[flue] ${label} thinkingLevel must be one of: ${Object.keys(VALID_THINKING_LEVELS).join(', ')}.`,
		);
	}
}

function assertCompaction(definition: AgentDefinition['compaction'], label: string): void {
	if (definition === undefined || definition === false) {
		return;
	}

	for (const key of Object.keys(definition)) {
		if (key !== 'reserveTokens' && key !== 'keepRecentTokens' && key !== 'model') {
			throw new Error(`[flue] ${label} compaction received unknown field "${key}".`);
		}
	}
	assertTokenCount(definition.reserveTokens, `${label} compaction.reserveTokens`);
	assertTokenCount(definition.keepRecentTokens, `${label} compaction.keepRecentTokens`);
	if (definition.model !== undefined && typeof definition.model !== 'string') {
		throw new Error(`[flue] ${label} compaction.model must be a string.`);
	}
}

function assertTokenCount(value: number | undefined, label: string): void {
	if (value === undefined) {
		return;
	}
	if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
		throw new Error(`[flue] ${label} must be a non-negative integer.`);
	}
}

function assertTools(values: unknown[] | undefined, label: string): asserts values is ToolDefinition[] | undefined {
	for (const [index, value] of values?.entries() ?? []) {
		if (!value || typeof value !== 'object') {
			throw new Error(`[flue] ${label} tools[${index}] must be a tool definition object.`);
		}
		const tool = value as Partial<ToolDefinition>;
		assertNonEmptyString(tool.name, `${label} tools[${index}].name`);
		assertNonEmptyString(tool.description, `${label} tools[${index}].description`);
		if (!tool.parameters || typeof tool.parameters !== 'object') {
			throw new Error(`[flue] ${label} tools[${index}].parameters is required.`);
		}
		if (typeof tool.execute !== 'function') {
			throw new Error(`[flue] ${label} tools[${index}].execute must be a function.`);
		}
	}
}

function assertSkills(values: unknown[] | undefined, label: string): asserts values is Skill[] | undefined {
	for (const [index, value] of values?.entries() ?? []) {
		if (!value || typeof value !== 'object') {
			throw new Error(`[flue] ${label} skills[${index}] must be a skill definition object.`);
		}
		const skill = value as Partial<Skill>;
		assertNonEmptyString(skill.name, `${label} skills[${index}].name`);
		assertNonEmptyString(skill.description, `${label} skills[${index}].description`);
	}
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
	if (typeof value !== 'string' || value.trim().length === 0) {
		throw new Error(`[flue] ${label} must be a non-empty string.`);
	}
}

function assertUniqueNames(
	values: ToolDefinition[] | Skill[] | undefined,
	label: string,
	kind: 'tool' | 'skill',
): void {
	if (!values) {
		return;
	}

	const seen = new Set<string>();
	for (const value of values) {
		if (seen.has(value.name)) {
			throw new Error(`[flue] ${label} must not contain duplicate ${kind} name "${value.name}".`);
		}
		seen.add(value.name);
	}
}

function formatIssues(issues: readonly v.BaseIssue<unknown>[]): string {
	return issues.map((issue) => issue.message).join('; ');
}
