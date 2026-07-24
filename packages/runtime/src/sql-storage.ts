/**
 * Minimal SQL storage interface shared by Cloudflare DO SQLite and node:sqlite.
 *
 * This is an internal implementation detail — not part of the public adapter
 * contract. Adapter authors implement {@link AgentSubmissionStore}, not this.
 */

interface SqlResult {
	toArray(): Array<Record<string, unknown>>;
}

export interface SqlStorage {
	exec(query: string, ...bindings: unknown[]): SqlResult;
}
