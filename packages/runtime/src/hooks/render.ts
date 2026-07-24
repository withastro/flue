import { ToolNameConflictError } from '../errors.ts';
import type { ResourceSnapshot, ToolResourceEntry } from '../resources.ts';
import { valibotToJsonSchema } from '../schema.ts';
import type { ToolDefinition } from '../tool-types.ts';
import type {
	AgentFunction,
	AgentProps,
	AgentRuntimeConfig,
	DeliveredMessage,
	ResolvedSubagent,
	SubagentDefinition,
} from '../types.ts';
import { type RenderFrame, type RenderStateContext, renderWithFrame } from './frame.ts';

/**
 * The props the runtime passes to the root agent function. On a bare render
 * with no backing instance (tests/tooling), reading `id` throws — the same
 * contract as `useDelivery()` on an unbacked render. A subagent's agent
 * function never receives props: a delegate runs in isolation from the
 * parent.
 */
function agentPropsFor(state: RenderStateContext | undefined): AgentProps {
	if (state?.instanceId !== undefined) return { id: state.instanceId };
	const props = {};
	Object.defineProperty(props, 'id', {
		get(): string {
			throw new Error(
				'[flue] This render has no agent instance behind it, so `props.id` is unavailable. Pass `instanceId` in the render state to back it in tests and tooling.',
			);
		},
	});
	return props as AgentProps;
}

/**
 * Run one render of an agent function: invoke it inside a fresh frame,
 * validate the returned instruction, and map the hook attachments onto the
 * internal runtime-config shape the initialization path consumes. The whole
 * config is hook-composed — `useModel` declares the model and its tuning,
 * `useSandbox` the environment; hooks validated each value when it was
 * declared.
 */
export function renderAgentFunction(
	agent: AgentFunction<AgentProps>,
	state?: RenderStateContext,
): AgentRuntimeConfig {
	return renderAgentFunctionWithStructure(agent, state).config;
}

/**
 * The structural fingerprint of one render. Message data (by name) feeds the
 * invariance guard — it must be identical across renders, because the parts
 * are the response's client-facing identity. `usePersistentState` is
 * conditional-friendly like resources: its names may vary render to render
 * (its record-log storage is keyed by name, not by declaration order or
 * presence) and duplicate names within one render are rejected directly off
 * `frame.stateNames` (see `usePersistentState`), so no state fingerprint is
 * carried here. Event hooks
 * (`useAgentStart`/`useAgentFinish`/`useResponseStart`/`useResponseFinish`)
 * have no durable identity at all — each seam runs whatever the current
 * render declares, so they may be conditional and reordered freely and are
 * not fingerprinted. Resources (tools, skills, subagents) are DYNAMIC: they
 * may be declared conditionally, and the session narrates their set changes
 * to the model instead of forbidding them. The sandbox is neither: it may be
 * declared conditionally, and a presence flip swaps the environment at the
 * next turn boundary (narrated as an `environment` signal) — never mid-turn,
 * and never as an identity violation.
 */
export interface AgentRenderStructure {
	messageDataNames: readonly string[];
	/**
	 * The render's declared resources with content fingerprints (tool schema
	 * digests included), in declaration order. The session diffs consecutive
	 * snapshots against the durable last-narrated set to announce adds,
	 * removals, and updates.
	 */
	resources: ResourceSnapshot;
}

/** `renderAgentFunction` plus the render's structural fingerprint. */
export function renderAgentFunctionWithStructure(
	agent: AgentFunction<AgentProps>,
	state?: RenderStateContext,
): { config: AgentRuntimeConfig; structure: AgentRenderStructure } {
	const props = agentPropsFor(state);
	const { result, frame } = renderWithFrame(() => agent(props), state);
	assertAgentInstruction(result);
	assertUniqueToolNames(frame);
	// Hand the render's lifecycle and boundary declarations to the session
	// through the shared output channel — replaced wholesale each render, so
	// per-turn re-renders refresh the closures the same way tools and
	// instructions refresh.
	if (state?.output) {
		state.output.responseStarts = [...frame.responseStarts];
		state.output.responseFinishes = [...frame.responseFinishes];
		state.output.agentStarts = [...frame.agentStarts];
		state.output.agentFinishes = [...frame.agentFinishes];
	}
	const instructions = composeAgentDocument(result, frame);
	const tools = frame.tools;
	return {
		config: {
			...(frame.model !== undefined ? { model: frame.model } : {}),
			...(instructions !== undefined ? { instructions } : {}),
			...(tools.length > 0 ? { tools } : {}),
			...(frame.thinkingLevel !== undefined ? { thinkingLevel: frame.thinkingLevel } : {}),
			...(frame.compaction !== undefined ? { compaction: frame.compaction } : {}),
			...(frame.cwd !== undefined ? { cwd: frame.cwd } : {}),
			...(frame.sandbox !== undefined ? { sandbox: frame.sandbox } : {}),
			...(frame.skills.length > 0 ? { skills: frame.skills } : {}),
			...(frame.subagents.length > 0 ? { subagents: frame.subagents } : {}),
			...(frame.mcpConnections.length > 0 ? { mcpConnections: frame.mcpConnections } : {}),
		},
		structure: {
			messageDataNames: [...frame.messageDataNames],
			resources: {
				skills: frame.skills.map((skill) => ({
					name: skill.name,
					...(skill.description ? { description: skill.description } : {}),
				})),
				tools: tools.map((tool) => toolResourceEntry(tool)),
				subagents: frame.subagents.map((subagent) => ({
					name: subagent.name,
					description: subagent.description,
				})),
			},
		},
	};
}

function toolResourceEntry(tool: ToolDefinition): ToolResourceEntry {
	return {
		name: tool.name,
		description: tool.description,
		...(tool.input ? { schema: JSON.stringify(valibotToJsonSchema(tool.input)) } : {}),
	};
}

/**
 * Render a delegate's agent function into the self-contained profile shape
 * the task machinery consumes. Runs at delegation time, in its own frame,
 * fresh per task — closures read current values, and two delegations to the
 * same subagent render independently. Subagent frames reject root-scoped
 * hooks (`usePersistentState`, `useSandbox`); nested `useSubagent` declarations pass
 * through for the delegate's own task tool, governed by the delegation
 * depth cap.
 *
 * `delivery` is the parent's task prompt as a `DeliveredMessage` — the
 * delegate's triggering input, readable via `useDelivery()` exactly like a
 * root agent reads its dispatch.
 */
export function resolveSubagentDefinition(
	subagent: SubagentDefinition,
	delivery?: DeliveredMessage,
): ResolvedSubagent {
	const { result, frame } = renderWithFrame(
		subagent.agent as () => unknown,
		delivery ? { snapshot: new Map(), store: undefined, delivery } : undefined,
		'subagent',
	);
	assertAgentInstruction(result);
	assertUniqueToolNames(frame);
	const instructions = composeAgentDocument(result, frame);
	const tools = frame.tools;
	return {
		name: subagent.name,
		description: subagent.description,
		...(subagent.model !== undefined ? { model: subagent.model } : {}),
		...(subagent.thinkingLevel !== undefined ? { thinkingLevel: subagent.thinkingLevel } : {}),
		...(instructions !== undefined ? { instructions } : {}),
		...(tools.length > 0 ? { tools } : {}),
		...(frame.skills.length > 0 ? { skills: frame.skills } : {}),
		...(frame.subagents.length > 0 ? { subagents: frame.subagents } : {}),
	};
}

/**
 * Message data names are the response's client-facing identity and must be
 * declared identically on every render. Everything else may vary: resources
 * (tools, skills, subagents) may be declared conditionally — the session
 * narrates their changes to the model; `usePersistentState` may be declared
 * conditionally too — its record-log storage is keyed by name, so a name's
 * absence on a given render is just a render that didn't touch it; event
 * hooks may be declared conditionally — each seam runs whatever the current
 * render declares, at-least-once per delivery; and the sandbox is exempt —
 * presence may change between renders, and the session swaps the environment
 * at the next turn boundary and narrates it. Throws with the precise delta
 * when consecutive renders disagree on an identity kind.
 */
export function assertRenderStructureInvariance(
	previous: AgentRenderStructure,
	next: AgentRenderStructure,
): void {
	const messageDataDelta = setDelta(previous.messageDataNames, next.messageDataNames);
	if (messageDataDelta) {
		throw new Error(
			`[flue] The agent's render changed identity between turns: message data ${messageDataDelta}. ` +
				"Message data must be declared unconditionally on every render — the named parts are the response's client-facing identity. Resources (tools, skills, subagents), persisted state, event hooks, and the sandbox may all be conditional.",
		);
	}
}

function setDelta(previous: readonly string[], next: readonly string[]): string | undefined {
	const before = new Set(previous);
	const after = new Set(next);
	const added = [...after].filter((name) => !before.has(name));
	const removed = [...before].filter((name) => !after.has(name));
	if (added.length === 0 && removed.length === 0) return undefined;
	return [
		...(added.length > 0 ? [`added ${added.join(', ')}`] : []),
		...(removed.length > 0 ? [`removed ${removed.join(', ')}`] : []),
	].join('; ');
}

/**
 * The agent's instruction document, concatenated in composition order: the
 * agent's returned instruction first, then `useInstruction` contributions in
 * call order. Authors own all formatting — the runtime only joins with blank
 * lines.
 */
function composeAgentDocument(base: string | undefined, frame: RenderFrame): string | undefined {
	const parts = [...(base !== undefined && base.length > 0 ? [base] : []), ...frame.instructions];
	if (parts.length === 0) return undefined;
	return parts.join('\n\n');
}

function assertUniqueToolNames(frame: RenderFrame): void {
	const seen = new Set<string>();
	const all = frame.tools;
	for (const tool of all) {
		if (seen.has(tool.name)) {
			throw new ToolNameConflictError({ name: tool.name, conflict: 'duplicate', source: 'custom' });
		}
		seen.add(tool.name);
	}
}

function assertAgentInstruction(value: unknown): asserts value is string | undefined {
	if (isPromiseLike(value)) {
		throw new Error(
			'[flue] Agent functions must be synchronous. Move async work into tools, actions, or resource factories.',
		);
	}
	if (value !== undefined && typeof value !== 'string') {
		throw new Error(
			'[flue] An agent returns its instruction string (or nothing). Everything else — model, sandbox, tools — is composed with hooks in the body.',
		);
	}
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
	return (
		typeof value === 'object' &&
		value !== null &&
		'then' in value &&
		typeof (value as { then: unknown }).then === 'function'
	);
}
