/**
 * Dynamic resources: tools, skills, and subagents may be declared
 * conditionally (`if (cond) useSkill(s)`), so the set the model can use
 * changes across renders. The runtime never rewrites the presentation
 * surfaces the model already read (the system prompt's skill catalog, the
 * task tool's roster) — those stay frozen on a durable BASELINE snapshot.
 * Instead, every render's declared set is diffed against the durable
 * LAST-NARRATED snapshot and the delta is appended as a `resources` signal,
 * so the transcript records exactly when each resource appeared,
 * disappeared, or changed. Compaction rebaselines: the post-compaction
 * prompt snapshots the then-current sets and the delta bookkeeping before
 * it stops mattering.
 *
 * This module is the pure core: snapshot types (shared with the durable
 * `resource_snapshot` record), the diff, and the signal-body rendering.
 */

import { fnv1a64 } from './fnv.ts';

/**
 * One resource as the model sees it named. `schema` only appears on tool
 * entries: a canonical JSON-schema digest of the input schema — tracked so
 * schema changes count as updates, but never reprinted in signals (the live
 * schema reaches the model natively in the request's tools array).
 */
interface ResourceEntry {
	name: string;
	description?: string;
	schema?: string;
}

/** One declared tool: a {@link ResourceEntry} whose description is required. */
export interface ToolResourceEntry extends ResourceEntry {
	description: string;
}

/** The declared resource sets of one render, in declaration order. */
export interface ResourceSnapshot {
	skills: ResourceEntry[];
	tools: ToolResourceEntry[];
	subagents: ResourceEntry[];
	/**
	 * Digest of the render's composed instruction document (returned prose +
	 * `useInstruction` contributions). Tracked so an instruction change is
	 * announced with an `instructions` signal — the content itself is never
	 * reprinted (the live prompt reaches the model natively). Absent on
	 * snapshots recorded before this field existed; such a baseline adopts
	 * silently.
	 */
	instructionsDigest?: string;
}

/**
 * Digest one render's composed instruction document (FNV-1a 64-bit — change
 * detection, not cryptography). `undefined` (an agent with no instruction
 * document) digests as the empty string, so gaining or losing the document
 * counts as a change like any edit.
 */
export function digestInstructions(instructions: string | undefined): string {
	return fnv1a64(instructions ?? '');
}

/**
 * Whether the instruction document changed between two snapshots. A previous
 * snapshot without a digest (recorded before the field existed) never counts
 * as changed — the next recorded snapshot carries the digest and detection
 * starts from there.
 */
export function instructionsChanged(previous: ResourceSnapshot, next: ResourceSnapshot): boolean {
	return (
		previous.instructionsDigest !== undefined &&
		next.instructionsDigest !== undefined &&
		previous.instructionsDigest !== next.instructionsDigest
	);
}

/**
 * The `instructions` signal body: a marker, not a message. The model's live
 * system prompt already IS the new version, so the signal only pins WHEN the
 * ground shifted — which is all a model needs to explain its own earlier
 * behavior to itself. Deliberately tiny: an agent whose instruction document
 * churns emits this every turn, and that visibility is a feature (churn is
 * a smell worth surfacing), so the marker must cost almost nothing.
 */
export const INSTRUCTIONS_UPDATED_SIGNAL_BODY = 'System instructions updated.';

export type ResourceKind = 'skill' | 'tool' | 'subagent';

export interface ResourceKindDelta {
	kind: ResourceKind;
	added: ResourceEntry[];
	removed: string[];
	updated: ResourceEntry[];
}

/**
 * Diff two snapshots by resource name. Returns one delta per kind that
 * actually changed — an empty array means the model's view is current.
 * An entry counts as updated when its description (or, for tools, its
 * schema digest) changed.
 */
export function diffResourceSnapshots(
	previous: ResourceSnapshot,
	next: ResourceSnapshot,
): ResourceKindDelta[] {
	const deltas: ResourceKindDelta[] = [];
	const kinds: Array<{ kind: ResourceKind; previous: ResourceEntry[]; next: ResourceEntry[] }> = [
		{ kind: 'skill', previous: previous.skills, next: next.skills },
		{ kind: 'tool', previous: previous.tools, next: next.tools },
		{ kind: 'subagent', previous: previous.subagents, next: next.subagents },
	];
	for (const { kind, previous: before, next: after } of kinds) {
		const beforeByName = new Map(before.map((entry) => [entry.name, entry]));
		const afterNames = new Set(after.map((entry) => entry.name));
		const added = after.filter((entry) => !beforeByName.has(entry.name));
		const removed = before.filter((entry) => !afterNames.has(entry.name)).map((e) => e.name);
		const updated = after.filter((entry) => {
			const existing = beforeByName.get(entry.name);
			return existing !== undefined && !resourceEntryEquals(existing, entry);
		});
		if (added.length > 0 || removed.length > 0 || updated.length > 0) {
			deltas.push({ kind, added, removed, updated });
		}
	}
	return deltas;
}

function resourceEntryEquals(a: ResourceEntry, b: ResourceEntry): boolean {
	return a.description === b.description && a.schema === b.schema;
}

const KIND_LABELS: Record<ResourceKind, { singular: string; plural: string; roster: string }> = {
	skill: { singular: 'skill', plural: 'skills', roster: 'All available skills' },
	tool: { singular: 'tool', plural: 'tools', roster: 'All available tools' },
	// Subagents are "agents" everywhere the model sees them (the task tool's
	// roster vocabulary), so the signals use the same word.
	subagent: { singular: 'agent', plural: 'agents', roster: 'All available agents' },
};

/**
 * Render one kind's delta as the signal body the model reads: added entries
 * as catalog-shape lines, removals and updates as factual one-liners, and
 * the current roster (names only) last so a chain of deltas always ends in
 * an unambiguous snapshot. Tool updates are name-only by design — the new
 * description/schema reaches the model natively in the tools array.
 */
export function renderResourceSignalBody(delta: ResourceKindDelta, roster: string[]): string {
	const { singular, plural, roster: rosterLabel } = KIND_LABELS[delta.kind];
	const lines: string[] = [];
	if (delta.added.length > 0) {
		lines.push(
			delta.added.length === 1 ? `New ${singular} available:` : `New ${plural} available:`,
		);
		for (const entry of delta.added) lines.push(catalogLine(entry));
	}
	for (const name of delta.removed) {
		lines.push(`The ${singular} "${name}" is no longer available.`);
	}
	for (const entry of delta.updated) {
		if (delta.kind === 'tool') {
			lines.push(`The tool "${entry.name}" was updated.`);
		} else {
			lines.push(`The ${singular} "${entry.name}" was updated:`, catalogLine(entry));
		}
	}
	lines.push(`${rosterLabel}: ${roster.join(', ')}`);
	return lines.join('\n');
}

function catalogLine(entry: ResourceEntry): string {
	return entry.description ? `- **${entry.name}** — ${entry.description}` : `- **${entry.name}**`;
}

/** Everything the `environment` signal tells the model about the new state. */
export interface EnvironmentSignalSnapshot {
	/** Working directory of the new environment; absent after a detach (no sandbox). */
	cwd: string | undefined;
	/** Full model-facing tool roster (builtins/adapter tools included), names only. */
	tools: string[];
	/** Live skill set — catalog-shape, since the prompt's skill catalog is stale by design. */
	skills: ResourceEntry[];
	/** Live subagent set — catalog-shape, matching the added-agent delta lines. */
	subagents: ResourceEntry[];
}

/**
 * The `environment` signal body: a deliberate FULL snapshot, not a delta.
 * An environment swap can be tool-invisible (a virtual `bash` replaced by a
 * container `bash`) while changing everything the model believed about its
 * filesystem, so this signal is emitted unconditionally on every swap and
 * restates the complete current state — verbose over ambiguous, on purpose.
 * Tools are names-only (descriptions and schemas reach the model natively in
 * the tools array); skills and agents keep catalog-shape lines because their
 * frozen presentation surfaces (prompt catalog, task roster) may be stale.
 */
/**
 * Body of the `resources` signal announcing optional MCP connections that
 * failed to resolve for this submission. Factual, one line per server; the
 * reason is the resolve error's message, truncated.
 */
export function renderMcpUnavailableSignalBody(
	unavailable: readonly { name: string; reason: string }[],
): string {
	const reason = (text: string) => (text.length > 300 ? `${text.slice(0, 300)}…` : text);
	if (unavailable.length === 1) {
		const entry = unavailable[0] as { name: string; reason: string };
		return `MCP server "${entry.name}" is unavailable for this response: ${reason(entry.reason)}. Its tools are not mounted.`;
	}
	return [
		'MCP servers unavailable for this response (their tools are not mounted):',
		...unavailable.map((entry) => `- "${entry.name}" — ${reason(entry.reason)}`),
	].join('\n');
}

export function renderEnvironmentSignalBody(snapshot: EnvironmentSignalSnapshot): string {
	const lines: string[] = [
		"The agent's execution environment (sandbox) was replaced.",
		snapshot.cwd !== undefined
			? `The current working directory is now \`${snapshot.cwd}\`.`
			: 'There is no sandbox anymore: shell and filesystem tools are unavailable.',
		'Files, directories, and command results from the previous environment may no longer be accessible — do not rely on anything learned about the previous environment without re-verifying it here, unless instructed otherwise.',
		'',
		`All available tools: ${snapshot.tools.length > 0 ? snapshot.tools.join(', ') : '(none)'}`,
	];
	if (snapshot.skills.length > 0) {
		lines.push('All available skills:');
		for (const entry of snapshot.skills) lines.push(catalogLine(entry));
	} else {
		lines.push('All available skills: (none)');
	}
	if (snapshot.subagents.length > 0) {
		lines.push('All available agents:');
		for (const entry of snapshot.subagents) lines.push(catalogLine(entry));
	} else {
		lines.push('All available agents: (none)');
	}
	return lines.join('\n');
}
