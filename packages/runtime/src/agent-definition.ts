import * as v from 'valibot';
import type { AgentDefinition, AgentInit, Skill, ThinkingLevel, ToolDefinition } from './types.ts';

const AGENT_DEFINITION_FIELDS = new Set([
	'name',
	'description',
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
	name: v.optional(v.string()),
	description: v.optional(v.string()),
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

export function assertResolvedAgentDefinition(definition: AgentDefinition, label: string): AgentDefinition {
	assertAgentDefinition(definition, label, new WeakSet());
	return definition;
}

export function resolveAgentDefinition(options: AgentInit | undefined): AgentDefinition {
	const inherited = options?.inherit;
	return {
		name: inherited?.name,
		description: inherited?.description,
		model: hasOwn(options, 'model') ? options?.model : inherited?.model,
		instructions: hasOwn(options, 'instructions') ? options?.instructions : inherited?.instructions,
		skills: hasOwn(options, 'skills') ? options?.skills : inherited?.skills,
		tools: hasOwn(options, 'tools') ? options?.tools : inherited?.tools,
		subagents: hasOwn(options, 'subagents') ? options?.subagents : inherited?.subagents,
		thinkingLevel: hasOwn(options, 'thinkingLevel') ? options?.thinkingLevel : inherited?.thinkingLevel,
		compaction: hasOwn(options, 'compaction') ? options?.compaction : inherited?.compaction,
	};
}

function hasOwn<T extends object, K extends PropertyKey>(value: T | undefined, key: K): value is T & Record<K, unknown> {
	return Boolean(value && Object.hasOwn(value, key));
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
	if (definition.name !== undefined) assertAgentName(definition.name, `${label} name`);
	if (definition.description !== undefined) assertNonEmptyString(definition.description, `${label} description`);
	assertThinkingLevel(definition.thinkingLevel, label);
	assertCompaction(definition.compaction, label);
	assertTools(definition.tools, label);
	assertSkills(definition.skills, label);
	assertSubagents(definition.subagents, label, activeDefinitions);
	assertUniqueNames(definition.tools, `${label} tools`, 'tool');
	assertUniqueNames(definition.skills, `${label} skills`, 'skill');
	assertUniqueNames(definition.subagents, `${label} subagents`, 'subagent');

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

function assertSubagents(
	values: unknown[] | undefined,
	label: string,
	activeDefinitions: WeakSet<object>,
): asserts values is AgentDefinition[] | undefined {
	for (const [index, value] of values?.entries() ?? []) {
		if (!value || typeof value !== 'object') {
			throw new Error(`[flue] ${label} subagents[${index}] must be an agent definition object.`);
		}
		const subagent = value as Partial<AgentDefinition>;
		assertAgentName(subagent.name, `${label} subagents[${index}].name`);
		assertAgentDefinition(value, `${label} subagents[${index}]`, activeDefinitions);
	}
}

function assertAgentName(value: unknown, label: string): asserts value is string {
	assertNonEmptyString(value, label);
	if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(value)) {
		throw new Error(`[flue] ${label} must start with a letter and contain only letters, numbers, "_", or "-".`);
	}
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
	if (typeof value !== 'string' || value.trim().length === 0) {
		throw new Error(`[flue] ${label} must be a non-empty string.`);
	}
}

function assertUniqueNames(
	values: ToolDefinition[] | Skill[] | AgentDefinition[] | undefined,
	label: string,
	kind: 'tool' | 'skill' | 'subagent',
): void {
	if (!values) {
		return;
	}

	const seen = new Set<string>();
	for (const value of values) {
		const name = value.name;
		if (!name) continue;
		if (seen.has(name)) {
			throw new Error(`[flue] ${label} must not contain duplicate ${kind} name "${name}".`);
		}
		seen.add(name);
	}
}

function formatIssues(issues: readonly v.BaseIssue<unknown>[]): string {
	return issues.map((issue) => issue.message).join('; ');
}
