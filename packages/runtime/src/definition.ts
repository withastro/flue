import type { AgentDefinition, AgentInit, SkillDefinition, ToolDefinition } from './types.ts';

interface DefineAgentInput {
	name: string;
	description?: string;
	model?: string;
	instructions?: string;
	skills?: SkillDefinition[];
	tools?: ToolDefinition[];
	subagents?: AgentDefinition[];
}

export function defineAgent(input: DefineAgentInput): AgentDefinition {
	assertNonEmptyString(input.name, 'defineAgent({ name })');
	assertOptionalString(input.description, 'defineAgent({ description })');
	assertOptionalString(input.model, 'defineAgent({ model })');
	assertOptionalString(input.instructions, 'defineAgent({ instructions })');
	assertNamedValues(input.skills, 'skill');
	assertNamedValues(input.tools, 'tool');
	assertNamedValues(input.subagents, 'subagent');

	return Object.freeze({
		name: input.name,
		description: input.description,
		model: input.model,
		instructions: input.instructions,
		skills: input.skills ? Object.freeze([...input.skills]) : undefined,
		tools: input.tools ? Object.freeze([...input.tools]) : undefined,
		subagents: input.subagents ? Object.freeze([...input.subagents]) : undefined,
	});
}

export function normalizeAgentDefinition(options: AgentInit): AgentDefinition {
	const runtimeOptions = options as AgentInit & {
		instructions?: unknown;
		role?: unknown;
		roles?: unknown;
	};
	if (runtimeOptions.instructions !== undefined) {
		throw new Error(
			'[flue] init() received `instructions`. Instructions belong on an agent. ' +
				'Use defineAgent({ instructions: "..." }) and pass it as { agent }.',
		);
	}
	if (runtimeOptions.role !== undefined || runtimeOptions.roles !== undefined) {
		throw new Error(
			'[flue] Roles have been removed. Define a subagent with defineAgent({ ... }) and delegate via task() instead.',
		);
	}

	const agent = options.agent;
	if (agent !== undefined) assertAgentDefinition(agent, 'init({ agent })');
	// `false` intentionally suppresses any agent-level default until a call supplies its own model.
	const inlineModel = options.model === false ? undefined : options.model;
	const normalized: AgentDefinition = agent ?? Object.freeze({ name: 'inline' });
	const skills = mergeNamedResources(normalized.skills, options.skills, 'Skill');
	const tools = mergeNamedResources(normalized.tools, options.tools, 'Tool');
	const subagents = mergeNamedResources(normalized.subagents, options.subagents, 'Subagent');

	return Object.freeze({
		name: normalized.name,
		description: normalized.description,
		model: options.model === false ? undefined : (inlineModel ?? normalized.model),
		instructions: normalized.instructions,
		skills,
		tools,
		subagents,
	});
}

export function assertAgentDefinition(value: unknown, label: string): asserts value is AgentDefinition {
	if (!value || typeof value !== 'object') {
		throw new Error(`[flue] ${label} must be an AgentDefinition created by defineAgent().`);
	}
	const agent = value as Partial<AgentDefinition>;
	assertNonEmptyString(agent.name, `${label}.name`);
	assertOptionalString(agent.description, `${label}.description`);
	assertOptionalString(agent.model, `${label}.model`);
	assertOptionalString(agent.instructions, `${label}.instructions`);
	assertNamedValues(agent.skills, 'skill');
	assertNamedValues(agent.tools, 'tool');
	assertNamedValues(agent.subagents, 'subagent');
}

function mergeNamedResources<T extends { name: string }>(
	fromAgent: readonly T[] | undefined,
	fromInit: readonly T[] | undefined,
	label: string,
): readonly T[] | undefined {
	if (!fromAgent?.length && !fromInit?.length) return undefined;
	const merged = [...(fromAgent ?? []), ...(fromInit ?? [])];
	const seen = new Set<string>();
	for (const resource of merged) {
		assertNonEmptyString(resource?.name, `${label} name`);
		if (seen.has(resource.name)) {
			throw new Error(`[flue] ${label} name "${resource.name}" appears twice in init() configuration. Remove the duplicate.`);
		}
		seen.add(resource.name);
	}
	return Object.freeze(merged);
}

function assertNamedValues(values: readonly { name: string }[] | undefined, label: string): void {
	if (values === undefined) return;
	if (!Array.isArray(values)) throw new Error(`[flue] ${label}s must be an array.`);
	const names = new Set<string>();
	for (const value of values) {
		assertNonEmptyString(value?.name, `${label} name`);
		if (names.has(value.name)) {
			throw new Error(`[flue] Duplicate ${label} name "${value.name}".`);
		}
		names.add(value.name);
	}
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
	if (typeof value !== 'string' || value.trim().length === 0) {
		throw new Error(`[flue] ${label} must be a non-empty string.`);
	}
}

function assertOptionalString(value: unknown, label: string): void {
	if (value !== undefined && typeof value !== 'string') {
		throw new Error(`[flue] ${label} must be a string when provided.`);
	}
}
