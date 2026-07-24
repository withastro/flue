'use agent';
import { useModel, useTool } from '@flue/runtime';
import * as v from 'valibot';

const TEST_PNG_BASE64 =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

export function WithImage() {
	useModel('anthropic/claude-sonnet-4-6');
	useTool({
		name: 'image-test',
		description: 'Send an image to the harness conversation in plain and structured prompts.',
		harness: true,
		async run({ harness }) {
			const image = { type: 'image' as const, data: TEST_PNG_BASE64, mimeType: 'image/png' };
			const plain = await harness.prompt('What color is this image?', { images: [image] });
			const structured = await harness.prompt('What color is this image?', {
				images: [image],
				result: v.object({ sawImage: v.boolean(), color: v.string() }),
			});
			return { plain: plain.text, structured: structured.data };
		},
	});
	return 'When asked to run a demo, call the `image-test` tool and report its result.';
}
