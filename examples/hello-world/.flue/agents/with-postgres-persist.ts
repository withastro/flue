import type { FlueContext } from '@flue/sdk';
import pg from 'pg';
import { postgresStore } from '../persist/postgres';

export const triggers = { webhook: true };

interface Payload {
	threadId: string;
	message: string;
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

/**
 * Demonstrates durable session state backed by Postgres.
 *
 * Two requests with the same `threadId` against the same `DATABASE_URL` share
 * a single Flue session — the second request can recall what the first one
 * said. See docs/persist-postgres.md for the schema and a docker-compose
 * Postgres for local verification.
 */
export default async function ({ init, payload }: FlueContext<Payload>) {
	const agent = await init({
		model: 'anthropic/claude-haiku-4-5',
		persist: postgresStore(pool),
	});
	const session = await agent.session(payload.threadId);
	const response = await session.prompt(payload.message);
	return { threadId: payload.threadId, response: response.text };
}
