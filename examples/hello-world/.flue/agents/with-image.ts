import { http, type Agent, type AgentContext } from '@flue/runtime';
import * as v from 'valibot';

export const channels = [http()];

// A 1×1 fully-yellow PNG. The model should describe a tiny solid-yellow image.
const TEST_PNG_BASE64 =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

export async function init({ spawn }: AgentContext): Promise<Agent> {
	// Sonnet has more reliable vision than Haiku for tiny test images.
	return spawn({ model: 'anthropic/claude-sonnet-4-6' });
}

export async function onMessage(agent: Agent) {
	const harness = agent.harness();
	const session = await harness.session();

	const image = { type: 'image' as const, data: TEST_PNG_BASE64, mimeType: 'image/png' };

	// Non-result branch — tests the direct harness.prompt path.
	const plain = await session.prompt('What color is this image?', { images: [image] });
	console.log('[with-image] plain:', plain.text);

	// Result branch — tests runWithResultTools (used by skill() and any prompt with `result`).
	const structured = await session.prompt('What color is this image?', {
		images: [image],
		result: v.object({ sawImage: v.boolean(), color: v.string() }),
	});
	console.log('[with-image] structured:', structured.data);

	return { plain: plain.text, structured: structured.data };
}
