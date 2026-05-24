import * as v from 'valibot';
import type { AgentCreateContext, AgentProfile, AgentRuntimeConfig, CreatedAgent, Skill, ThinkingLevel, ToolDefinition } from './types.ts';

const AGENT_PROFILE_FIELDS = new Set([
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

const AGENT_RUNTIME_FIELDS = new Set([
	...AGENT_PROFILE_FIELDS,
	'profile',
	'cwd',
	'sandbox',
	'persist',
]);

const VALID_THINKING_LEVELS = {
	off: true,
	minimal: true,
	low: true,
	medium: true,
	high: true,
	xhigh: true,
} as const satisfies Record<ThinkingLevel, true>;

const AgentProfileSchema = v.looseObject({
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

export function defineAgentProfile(profile: AgentProfile): AgentProfile {
	assertAgentProfile(profile, 'defineAgentProfile()', new WeakSet());
	return profile;
}

export function createAgent<TPayload = unknown, TEnv = Record<string, any>>(
	initialize: (context: AgentCreateContext<TPayload, TEnv>) => AgentRuntimeConfig | Promise<AgentRuntimeConfig>,
): CreatedAgent<TPayload, TEnv> {
	if (typeof initialize !== 'function') {
		throw new Error('[flue] createAgent() requires an initializer function.');
	}
	return Object.freeze({ __flueCreatedAgent: true as const, initialize });
}


export function assertResolvedAgentProfile(profile: AgentProfile, label: string): AgentProfile {
	assertAgentProfile(profile, label, new WeakSet());
	return profile;
}

export function resolveAgentProfile(options: AgentRuntimeConfig | undefined): AgentProfile {
	assertAgentRuntimeConfig(options);
	const profile = options?.profile;
	return {
		name: hasOwn(options, 'name') ? options?.name : profile?.name,
		description: hasOwn(options, 'description') ? options?.description : profile?.description,
		model: hasOwn(options, 'model') ? options?.model : profile?.model,
		instructions: hasOwn(options, 'instructions') ? options?.instructions : profile?.instructions,
		skills: hasOwn(options, 'skills') ? options?.skills : profile?.skills,
		tools: hasOwn(options, 'tools') ? options?.tools : profile?.tools,
		subagents: hasOwn(options, 'subagents') ? options?.subagents : profile?.subagents,
		thinkingLevel: hasOwn(options, 'thinkingLevel') ? options?.thinkingLevel : profile?.thinkingLevel,
		compaction: hasOwn(options, 'compaction') ? options?.compaction : profile?.compaction,
	};
}

function hasOwn<T extends object, K extends PropertyKey>(value: T | undefined, key: K): value is T & Record<K, unknown> {
	return Boolean(value && Object.hasOwn(value, key));
}

function assertAgentRuntimeConfig(value: AgentRuntimeConfig | undefined): void {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error('[flue] createAgent() initializer must return an agent runtime config object.');
	}
	for (const key of Object.keys(value)) {
		if (!AGENT_RUNTIME_FIELDS.has(key)) {
			throw new Error(`[flue] createAgent() initializer returned unknown runtime config field "${key}".`);
		}
	}
	if (value.profile !== undefined) {
		assertAgentProfile(value.profile, 'createAgent() profile', new WeakSet());
	}
}

function assertAgentProfile(
	value: unknown,
	label: string,
	activeDefinitions: WeakSet<object>,
): asserts value is AgentProfile {
	const parsed = v.safeParse(AgentProfileSchema, value);
	if (!parsed.success) {
		throw new Error(`[flue] ${label} requires a valid agent profile: ${formatIssues(parsed.issues)}.`);
	}

	const definition = parsed.output as AgentProfile;
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

function assertKnownFields(definition: AgentProfile, label: string): void {
	for (const key of Object.keys(definition)) {
		if (!AGENT_PROFILE_FIELDS.has(key)) {
			throw new Error(`[flue] ${label} received unknown agent profile field "${key}".`);
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

function assertCompaction(definition: AgentProfile['compaction'], label: string): void {
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
): asserts values is AgentProfile[] | undefined {
	for (const [index, value] of values?.entries() ?? []) {
		if (!value || typeof value !== 'object') {
			throw new Error(`[flue] ${label} subagents[${index}] must be an agent definition object.`);
		}
		const subagent = value as Partial<AgentProfile>;
		assertAgentName(subagent.name, `${label} subagents[${index}].name`);
		assertAgentProfile(value, `${label} subagents[${index}]`, activeDefinitions);
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
	values: ToolDefinition[] | Skill[] | AgentProfile[] | undefined,
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
