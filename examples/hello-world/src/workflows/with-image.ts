import { defineAgent, defineWorkflow, type WorkflowRouteHandler } from '@flue/runtime';
import * as v from 'valibot';

export const route: WorkflowRouteHandler = async (_c, next) => next();
const TEST_PNG_BASE64 =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
const agent = defineAgent(() => ({ model: 'anthropic/claude-sonnet-4-6' }));

export default defineWorkflow({
	agent,
	async run({ harness }) {
		const session = await harness.session();
		const image = { type: 'image' as const, data: TEST_PNG_BASE64, mimeType: 'image/png' };
		const plain = await session.prompt('What color is this image?', { images: [image] });
		const structured = await session.prompt('What color is this image?', {
			images: [image],
			result: v.object({ sawImage: v.boolean(), color: v.string() }),
		});
		return { plain: plain.text, structured: structured.data };
	},
});
