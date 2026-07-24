import { assertThinkingLevel } from '../agent-tuning.ts';
import type { SubagentDefinition } from '../types.ts';
import { requireRenderFrame } from './frame.ts';

/**
 * Validate a subagent definition. Shared between {@link defineSubagent}
 * (module-load time) and {@link useSubagent} (mount time) so a definition
 * can reach the mount site without passing through the helper.
 */
function assertSubagentDefinition(
	subagent: unknown,
	source: string,
): asserts subagent is SubagentDefinition {
	if (!subagent || typeof subagent !== 'object' || Array.isArray(subagent)) {
		throw new Error(`[flue] ${source} requires an options object: { name, description, agent }.`);
	}
	const { name, description, agent, model, thinkingLevel } =
		subagent as Partial<SubagentDefinition>;
	if (typeof name !== 'string' || name.trim().length === 0) {
		throw new Error(`[flue] ${source} name must be a non-empty string.`);
	}
	if (typeof description !== 'string' || description.trim().length === 0) {
		throw new Error(
			`[flue] ${source} "${name}" needs a non-empty description — it is the catalog line the model uses to decide when to delegate.`,
		);
	}
	if (typeof agent !== 'function') {
		throw new Error(
			`[flue] ${source} "${name}" needs \`agent\`: the agent function that defines the delegate (rendered when the model delegates to it).`,
		);
	}
	if (model !== undefined && (typeof model !== 'string' || model.trim().length === 0)) {
		throw new Error(`[flue] ${source} "${name}" model must be a non-empty string.`);
	}
	// Same validation useModel() applies — a typo'd level must fail at
	// authoring time, not deep inside the first delegated task run.
	assertThinkingLevel(thinkingLevel, `${source} "${name}"`);
}

/**
 * Declare a reusable subagent. A typing helper in the `defineTool()` mold:
 * it validates the definition and returns it frozen, so bad definitions
 * fail at module load instead of first render. The returned object is the
 * exportable unit — define a delegate once, mount it from any agent with
 * `useSubagent(...)`.
 *
 * ```ts
 * function IssueClassifier() {
 *   return 'Return the likely product area and urgency for the reported issue.';
 * }
 *
 * export const issueClassifier = defineSubagent({
 *   name: 'issue_classifier',
 *   description: 'Classifies support issues for routing.',
 *   agent: IssueClassifier,
 * });
 * ```
 *
 * `useSubagent(...)` also accepts the same object inline (same validation,
 * applied at the mount site). Per-mount overrides spread cleanly:
 * `useSubagent({ ...issueClassifier, model: 'anthropic/claude-haiku-4-5' })`.
 */
export function defineSubagent(definition: SubagentDefinition): SubagentDefinition {
	assertSubagentDefinition(definition, 'defineSubagent()');
	return Object.freeze({
		name: definition.name,
		description: definition.description,
		agent: definition.agent,
		...(definition.model !== undefined ? { model: definition.model } : {}),
		...(definition.thinkingLevel !== undefined ? { thinkingLevel: definition.thinkingLevel } : {}),
	});
}

/**
 * The delegate function behind {@link GeneralSubagent}. Deliberately blank:
 * no instructions, no hooks. The child gets the filesystem context
 * discovered from its cwd (AGENTS.md, workspace skills), the environment's
 * own tools, and the parent's model — nothing else.
 */
function FlueGeneralAgent(): undefined {
	return undefined;
}

/**
 * A blank general-purpose delegate, ready to declare with
 * `useSubagent(GeneralSubagent)`. Delegation is a declared capability — the
 * `task` tool's required `agent` parameter only resolves against declared
 * subagents — and this is the opt-in for agents that want fresh-context
 * delegation without authoring a specialist: the child shares the parent's
 * environment (sandbox tools, filesystem context, model) but inherits none
 * of the parent's instructions, tools, skills, or subagents.
 *
 * The `flue-general` name is framework-reserved by convention; declare your
 * own delegates under your own names.
 */
export const GeneralSubagent: SubagentDefinition = defineSubagent({
	name: 'flue-general',
	description:
		'General-purpose agent for independent research, file exploration, and parallel work. ' +
		'Runs with a fresh context and the workspace tools; give it complete instructions in the prompt.',
	agent: FlueGeneralAgent,
});

/**
 * Declare a delegate the model can hand focused work to via the framework's
 * `task` tool. The `agent` function defines the delegate's whole world — it
 * is rendered at delegation time, in its own frame, fresh per task — and the
 * delegate is isolated from the parent: nothing flows in except the shared
 * environment and, unless overridden here, the parent's model and reasoning
 * effort. The delegate runs a detached session and only its final text
 * returns to the parent.
 *
 * ```ts
 * function Reproducer() {
 *   useSkill(reproduceSkill);
 *   return 'You reproduce one issue. Write your findings to report.md.';
 * }
 *
 * function ReproducePhase() {
 *   useSubagent({
 *     name: 'reproducer',
 *     description: 'Sets up the reproduction for one issue and writes report.md.',
 *     agent: Reproducer,
 *   });
 *   return 'Delegate the reproduction to the `reproducer` subagent.';
 * }
 * ```
 *
 * `name` + `description` are the delegate's catalog identity on the `task`
 * tool — the description is how the model decides when to delegate. To share
 * one delegate across agents, export it with {@link defineSubagent} and mount
 * the exported definition. Inside the delegate's render, `useTool()`,
 * `useInstruction()`, `useSkill()`, custom hooks, and nested `useSubagent()`
 * all compose as usual; `usePersistentState()` and `useSandbox()` throw
 * (durable state is instance-scoped and delegates share the parent
 * environment). Duplicate delegate names in one render fail fast.
 */
export function useSubagent(subagent: SubagentDefinition): void {
	const frame = requireRenderFrame('useSubagent');
	assertSubagentDefinition(subagent, 'useSubagent()');
	const { name, description, agent, model, thinkingLevel } = subagent;
	if (frame.subagents.some((declared) => declared.name === name)) {
		throw new Error(
			`[flue] useSubagent() declared the subagent name "${name}" twice in one render. Each delegate declares once; share it from a single custom hook.`,
		);
	}
	frame.subagents.push({
		name,
		description,
		agent,
		...(model !== undefined ? { model } : {}),
		...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
	});
}
