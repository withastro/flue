'use agent';
import { useModel, useSkill, useTool } from '@flue/runtime';
import review from '../skills/review/SKILL.md';

export function WithImportedSkill() {
	useModel('anthropic/claude-haiku-4-5');
	// Registering the reference packages the skill's files with the build and
	// exposes it to every model turn — including the tool's scratch prompt
	// below, whose session carries the same skill catalog.
	useSkill(review);
	useTool({
		name: 'run-review-skill',
		description: 'Run the imported `review` skill and return its answer.',
		harness: true,
		async run({ harness }) {
			const response = await harness.prompt(
				`Use the "${review.name}" skill and report its result.`,
			);
			return { text: response.text, reference: review.name };
		},
	});
	return 'When asked to run the demo, call the `run-review-skill` action and report its result.';
}
