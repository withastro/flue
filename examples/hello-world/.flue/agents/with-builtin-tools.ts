import type { FlueContext } from '@flue/runtime';

export const triggers = { webhook: true };

/**
 * Built-in tool allowlist example.
 *
 * The agent can search and read the knowledge base, but cannot call bash,
 * write files, edit files, or spawn task sessions.
 */
export default async function ({ init, payload }: FlueContext) {
	const harness = await init({ model: 'anthropic/claude-sonnet-4-6' });
	const session = await harness.session('readonly-support', {
		builtinTools: ['read', 'grep', 'glob'],
	});

	await session.fs.mkdir('/knowledge-base', { recursive: true });
	await session.fs.writeFile(
		'/knowledge-base/billing.md',
		'Refunds are available within 30 days of purchase. Contact billing support for exceptions.',
	);

	return await session.prompt(
		`Search /knowledge-base and answer this customer question: ${payload.message}`,
	);
}
