import { defineAgent, type ActionContext } from '@flue/runtime';
import edgeSummary from '../skills/edge-summary/SKILL.md' with { type: 'skill' };
import instructions from './with-bundled-skill.instructions.md' with { type: 'text' };
import * as v from 'valibot';

export const triggers = { webhook: true };

const bundledSkillAgent = defineAgent({
	name: 'with-bundled-skill',
	model: 'cloudflare/@cf/moonshotai/kimi-k2.6',
	instructions,
	skills: [edgeSummary],
});

export default async function ({ init, payload }: ActionContext) {
	const harness = await init({ agent: bundledSkillAgent });
	const session = await harness.session();
	const result = await session.skill(edgeSummary, {
		args: {
			text: payload?.text ?? 'Flue bundles spec-compliant skills into Cloudflare Workers.',
		},
		result: v.object({ summary: v.string() }),
	});
	return result.data;
}
