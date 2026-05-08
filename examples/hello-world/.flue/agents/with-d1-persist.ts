import type { FlueContext } from '@flue/sdk';
import { d1Store } from '../persist/d1';

export const triggers = { webhook: true };

interface Payload {
	threadId: string;
	message: string;
}

/**
 * Demonstrates durable session state backed by Cloudflare D1.
 *
 * Two requests with the same `threadId` against the same D1 binding share a
 * single Flue session — useful when sessions need to be queryable from
 * outside the agent process (e.g. from a separate UI Worker or admin tool).
 * For per-instance hot-path persistence, the default DO SQLite store is
 * usually a better fit. See docs/persist-d1.md for the schema and trade-offs.
 */
export default async function ({ init, payload, env }: FlueContext<Payload>) {
	const agent = await init({
		model: 'anthropic/claude-haiku-4-5',
		persist: d1Store(env.DB),
	});
	const session = await agent.session(payload.threadId);
	const response = await session.prompt(payload.message);
	return { threadId: payload.threadId, response: response.text };
}
