import type { FlueContext } from '@flue/runtime';
import * as v from 'valibot';

export const triggers = { webhook: true };

// A 1×1 fully-yellow PNG. The model should describe a tiny solid-yellow image.
const TEST_PNG_BASE64 =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

export default async function ({ init }: FlueContext) {
	// Sonnet has more reliable vision than Haiku for tiny test images.
	const harness = await init({ model: 'anthropic/claude-sonnet-4-6' });
	const session = await harness.session();

	const image = { type: 'image' as const, data: TEST_PNG_BASE64, mimeType: 'image/png' };

	// Non-schema branch — tests the direct harness.prompt path.
	const plain = await session.prompt('What color is this image?', { images: [image] });
	console.log('[with-image] plain:', plain.text);

	// Schema branch — tests runWithResultTools (used by skill() and any prompt with `schema`).
	const structured = await session.prompt('What color is this image?', {
		images: [image],
		schema: v.object({ sawImage: v.boolean(), color: v.string() }),
	});
	console.log('[with-image] structured:', structured.data);

	return { plain: plain.text, structured: structured.data };
}
