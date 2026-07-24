import { type HookStateStore, isRendering, requireRenderFrame } from './frame.ts';
import { normalizeJsonValue } from './json-value.ts';

/**
 * Durable agent state: an API over the record log of the agent instance.
 *
 * `usePersistentState` reads the value as of this render (reduced from the instance's
 * `state_write` records) and returns a setter that persists a new value —
 * either directly (`setPhase('drafting')`) or through an updater
 * (`setCount((previous) => previous + 1)`) resolved at call time.
 * Reads are render-time snapshots; writes are silent — they never post a
 * message, never wake the agent, and never re-render mid-run. The next
 * turn's render reads the latest persisted values.
 *
 * ```ts
 * export default function SupportAgent() {
 *   const [phase, setPhase] = usePersistentState<Phase>('phase', 'gathering');
 *
 *   useTool({
 *     name: 'begin_draft',
 *     description: 'Call once the case facts are verified.',
 *     run: () => setPhase('drafting'),
 *   });
 *
 *   return `Current phase: ${phase}.`;
 * }
 * ```
 *
 * Semantics:
 * - Values are JSON: writes are normalized through a JSON round-trip and
 *   throw on non-serializable input. There is no unset — a name, once
 *   written, always has a value (`defaultValue` fills in before the first
 *   write and is never persisted itself).
 * - The updater form is the read-modify-write path: `previous` resolves at
 *   CALL time through the write buffer (this attempt's writes over the
 *   snapshot; `defaultValue` before the first write ever). The render value
 *   is a snapshot — two callbacks in one turn each spreading it would drop
 *   each other's writes; updaters compose instead. Any function argument is
 *   treated as an updater (a function was never a legal value — values are
 *   JSON).
 * - Writing the current value again is a no-op: no record is appended.
 * - Writes made by tools become durable atomically with the tool batch that
 *   made them — if the batch settles, the write is durable; if recovery
 *   settles the batch as interrupted, the write never happened.
 * - The setter throws during render: a render is a pure read of the record
 *   stream. Write from tool `run` functions and other runtime callbacks.
 * - State is scoped to the agent instance (its whole stream), keyed by
 *   `name`; declaring the same name twice in one render throws.
 * - The type parameter is a compile-time convenience only — nothing parses
 *   persisted values. For runtime enforcement, assert at the call site
 *   (`v.assert(schema, value)`) or compose your own hook over this one
 *   (e.g. a `usePersistentStateWithSchema(name, schema, defaultValue)` that parses
 *   reads and validates writes).
 */
export function usePersistentState<T>(name: string, defaultValue: T): [T, StateSetter<T>];
export function usePersistentState<T = unknown>(
	name: string,
): [T | undefined, StateSetter<T | undefined>];
export function usePersistentState(
	name: string,
	defaultValue?: unknown,
): [unknown, StateSetter<unknown>] {
	const frame = requireRenderFrame('usePersistentState');
	if (frame.kind === 'subagent') {
		throw new Error(
			'[flue] usePersistentState() is not available in a subagent render. Durable state is scoped to the agent instance; delegates run detached tasks with no state channel. Pass what the delegate needs through the task prompt instead.',
		);
	}
	if (typeof name !== 'string' || name.length === 0) {
		throw new Error(
			'[flue] usePersistentState(name, defaultValue?) takes the state name as its first argument — a non-empty string.',
		);
	}
	if (frame.stateNames.has(name)) {
		throw new Error(
			`[flue] Duplicate usePersistentState name "${name}" in one render. State names identify a value across renders and must be unique.`,
		);
	}
	frame.stateNames.add(name);

	const store = frame.state?.store;
	const persisted = readPersisted(name, frame.state?.snapshot, store);
	const value = persisted ? persisted.value : defaultValue;

	const setValue: StateSetter<unknown> = (next) => {
		if (isRendering()) {
			throw new Error(
				`[flue] State "${name}" was written during render. Renders are pure reads of the record stream — write from tool run functions or other runtime callbacks, and use the default value for the initial value.`,
			);
		}
		if (!store) {
			throw new Error(
				`[flue] State "${name}" has no durable runtime behind this render, so writes are unavailable.`,
			);
		}
		// An updater's `previous` resolves through the buffer at call time —
		// read-your-writes within the attempt — not the render snapshot the
		// closure was born with. The boxed `current` keeps persisted null/false
		// from falling back to the default.
		if (typeof next === 'function') {
			const current = store.current(name);
			next = (next as (previous: unknown) => unknown)(current ? current.value : defaultValue);
		}
		store.write(name, normalizeStateValue(name, next));
	};
	return [value, setValue];
}

export type StateSetter<T> = (value: T | ((previous: T) => T)) => void;

/** One durable write, in call order, as drained by the session for appending. */
export interface HookStateWrite {
	name: string;
	value: unknown;
}

/**
 * The runtime's write buffer for one harness lifetime (one submission
 * attempt). Setters push into it; the session drains it into the same append
 * batch as the tool batch's `tool_results_committed` record. No-op writes
 * (deep-equal to the current value) are dropped here, so "one actual change →
 * one record" holds no matter how often a setter is called.
 */
export interface HookStateBuffer extends HookStateStore {
	drain(): HookStateWrite[];
}

export function createHookStateBuffer(snapshot: ReadonlyMap<string, unknown>): HookStateBuffer {
	const overlay = new Map<string, unknown>();
	let pending: HookStateWrite[] = [];
	const currentValue = (name: string): { value: unknown } | undefined => {
		if (overlay.has(name)) return { value: overlay.get(name) };
		if (snapshot.has(name)) return { value: snapshot.get(name) };
		return undefined;
	};
	return {
		current: currentValue,
		write(name, value) {
			const current = currentValue(name);
			if (current && JSON.stringify(current.value) === JSON.stringify(value)) return;
			pending.push({ name, value });
			overlay.set(name, value);
		},
		drain() {
			const drained = pending;
			pending = [];
			return drained;
		},
	};
}

function readPersisted(
	name: string,
	snapshot: ReadonlyMap<string, unknown> | undefined,
	store: HookStateStore | undefined,
): { value: unknown } | undefined {
	// The store's view wins: it overlays writes made since the snapshot was
	// taken (same submission), so a re-render would read its own writes.
	const current = store?.current(name);
	if (current) return current;
	if (snapshot?.has(name)) return { value: snapshot.get(name) };
	return undefined;
}

function normalizeStateValue(name: string, value: unknown): unknown {
	return normalizeJsonValue(value, {
		label: 'State',
		name,
		undefinedMessage: `[flue] State "${name}" cannot be set to undefined. State values are JSON; there is no unset.`,
	});
}
