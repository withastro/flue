import { assertSkillDefinition } from '../skill-definition.ts';
import type { Skill } from '../types.ts';
import { requireRenderFrame } from './frame.ts';

/**
 * Mount a skill in the agent's catalog. Skills are progressive disclosure:
 * every mounted skill costs one always-present catalog line (name +
 * description) in the system prompt, and the model pulls the full
 * instructions on demand with the framework's `activate_skill` tool — the
 * briefing arrives as the tool result, so the prompt prefix never changes.
 * Supporting files stay lazy until explicitly read.
 *
 * Accepts a `SkillReference` (a `SKILL.md` import — packaged automatically
 * by the build — or `defineSkill(...)`) or an inline `SkillDefinition`
 * object (same validation, applied here):
 *
 * ```ts
 * import triageSkill from '../skills/triage/SKILL.md';
 *
 * function ReproducePhase({ check, onComplete }: PhaseProps) {
 *   useSkill(triageSkill);
 *   return 'Activate the `triage` skill before starting this phase.';
 * }
 * ```
 *
 * Always-on skill content needs no hook — import the markdown file (any
 * `.md` import loads as a string) and pass it to `useInstruction()`. Mounts are
 * static like everything else: a skill mounted by a phase hook is
 * cataloged on every turn; the hook's instruction says when to
 * activate it. Duplicate names across the render fail fast.
 */
export function useSkill(skill: Skill): void {
	const frame = requireRenderFrame('useSkill');
	if (!skill || typeof skill !== 'object' || Array.isArray(skill)) {
		throw new Error(
			'[flue] useSkill() requires a skill: a SKILL.md import or a skill definition (from `defineSkill(...)` or written inline).',
		);
	}
	if (!('__flueSkillReference' in skill)) {
		assertSkillDefinition(skill, 'useSkill()');
	}
	if (frame.skills.some((mounted) => mounted.name === skill.name)) {
		throw new Error(
			`[flue] useSkill() mounted the skill name "${skill.name}" twice in one render. Each skill mounts once; share it from a single custom hook.`,
		);
	}
	frame.skills.push(skill);
}
