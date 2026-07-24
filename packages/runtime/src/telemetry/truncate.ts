/**
 * Structural, in-band content truncation — the safety net behind
 * `contentAttribute()` and, via the exported `truncateContent`, the helper
 * for tighter policy budgets inside a content transform. One algorithm, one
 * sentinel vocabulary, so policy truncation and physical truncation are
 * indistinguishable to whatever reads the traces.
 *
 * Contract: the result always serializes to valid JSON, the serialized form
 * fits the byte budget, what was removed is represented inside the payload
 * itself by `[flue]`-prefixed sentinels (the greppable marker that replaces
 * side-channel `*.truncated` attributes), and the input value is never
 * mutated.
 */

const ENCODER = new TextEncoder();

export const CONTENT_UNSERIALIZABLE = '[flue] content unserializable';
export const CONTENT_TRANSFORM_FAILED = '[flue] content transform failed; content omitted';
export const CONTENT_BUDGET_EXCEEDED = '[flue] content exceeds attribute budget';

/** Sentinels must themselves fit, so pathologically small budgets are refused. */
const MIN_BUDGET_BYTES = 128;
/** Below this, string leaves stop being worth splitting and we bail instead. */
const MIN_LEAF_BYTES = 64;

export function truncateContent(content: unknown, options: { maxBytes: number }): unknown {
	if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < MIN_BUDGET_BYTES) {
		throw new TypeError(`maxBytes must be a safe integer of at least ${MIN_BUDGET_BYTES}.`);
	}
	return fit(content, options.maxBytes);
}

/** Serialized UTF-8 byte length, or undefined when JSON can't represent it. */
function measure(value: unknown): number | undefined {
	let serialized: string | undefined;
	try {
		serialized = JSON.stringify(value);
	} catch {
		return undefined;
	}
	if (serialized === undefined) return undefined;
	return ENCODER.encode(serialized).byteLength;
}

function fit(value: unknown, budget: number): unknown {
	const size = measure(value);
	if (size === undefined) return CONTENT_UNSERIALIZABLE;
	if (size <= budget) return value;
	if (typeof value === 'string') return truncateString(value, budget);
	if (Array.isArray(value)) return truncateArray(value, budget);
	if (value !== null && typeof value === 'object') return shrinkStringLeaves(value, budget);
	// Non-string primitives serialize in a handful of bytes and never get here.
	return CONTENT_BUDGET_EXCEEDED;
}

/**
 * Longest prefix (binary-searched, surrogate-safe) whose serialized form plus
 * the in-band suffix fits the budget.
 */
function truncateString(value: string, budget: number): string {
	const totalBytes = ENCODER.encode(value).byteLength;
	let low = 0;
	let high = value.length - 1;
	let best: string | undefined;
	while (low <= high) {
		const mid = Math.floor((low + high) / 2);
		const prefix = safeSlice(value, mid);
		const dropped = totalBytes - ENCODER.encode(prefix).byteLength;
		const candidate = `${prefix} [flue:truncated, ${dropped} more bytes]`;
		if (ENCODER.encode(JSON.stringify(candidate)).byteLength <= budget) {
			best = candidate;
			low = mid + 1;
		} else {
			high = mid - 1;
		}
	}
	return best ?? `[flue:truncated, ${totalBytes} bytes]`;
}

/** Slice that never ends on the high half of a surrogate pair. */
function safeSlice(value: string, end: number): string {
	if (end > 0 && end < value.length) {
		const code = value.charCodeAt(end - 1);
		if (code >= 0xd800 && code <= 0xdbff) return value.slice(0, end - 1);
	}
	return value.slice(0, end);
}

/**
 * Drop whole elements from the front (for messages: oldest first) until the
 * rest fits, then represent the drop as one sentinel element matching the
 * array's item shape. A single element that is itself over budget gets its
 * string leaves shrunk in place.
 */
function truncateArray(value: unknown[], budget: number): unknown {
	const messageShaped = isMessageArray(value);
	const items = [...value];
	let droppedCount = 0;
	let droppedBytes = 0;
	while (items.length > 1) {
		const removed = items.shift();
		droppedCount += 1;
		droppedBytes += (measure(removed) ?? 0) + 1;
		const candidate = [sentinelItem(messageShaped, droppedCount, droppedBytes), ...items];
		const size = measure(candidate);
		if (size !== undefined && size <= budget) return candidate;
	}
	const sentinel =
		droppedCount > 0 ? sentinelItem(messageShaped, droppedCount, droppedBytes) : undefined;
	const overhead = (sentinel ? (measure(sentinel) ?? 0) + 1 : 0) + 4;
	// Shrink the last element only when a workable slice of the budget is left
	// beside the sentinel, and re-measure the result: nested fit() calls bottom
	// out in fixed-size markers that can overshoot a tight budget.
	const innerBudget = budget - overhead;
	if (innerBudget >= MIN_LEAF_BYTES) {
		const shrunk = fit(items[0], innerBudget);
		const candidate = sentinel ? [sentinel, shrunk] : [shrunk];
		const size = measure(candidate);
		if (size !== undefined && size <= budget) return candidate;
	}
	// Nothing fits beside the sentinel: count the last element as dropped too,
	// and bail to the bare exceeded marker when even that sentinel is too big.
	const allDropped = [
		sentinelItem(messageShaped, droppedCount + 1, droppedBytes + (measure(items[0]) ?? 0) + 1),
	];
	const allDroppedSize = measure(allDropped);
	if (allDroppedSize !== undefined && allDroppedSize <= budget) return allDropped;
	return CONTENT_BUDGET_EXCEEDED;
}

function isMessageArray(value: unknown[]): boolean {
	return (
		value.length > 0 &&
		value.every(
			(item) =>
				item !== null &&
				typeof item === 'object' &&
				typeof (item as { role?: unknown }).role === 'string' &&
				Array.isArray((item as { parts?: unknown }).parts),
		)
	);
}

/**
 * `role: 'flue'` is deliberate: honest, filterable, and never confused with a
 * real conversation turn.
 */
function sentinelItem(messageShaped: boolean, count: number, bytes: number): unknown {
	const text = `[flue] ${count} ${messageShaped ? 'messages' : 'items'} omitted (${bytes} bytes) to fit the attribute budget`;
	if (!messageShaped) return text;
	return { role: 'flue', parts: [{ type: 'text', content: text }] };
}

/**
 * Repeatedly halve the longest string leaf (on a detached copy) until the
 * value fits. When every leaf is already small and the structure alone is
 * over budget, bail to the sentinel rather than mangle the shape.
 */
function shrinkStringLeaves(value: object, budget: number): unknown {
	let clone: unknown;
	try {
		clone = structuredClone(value);
	} catch {
		return CONTENT_UNSERIALIZABLE;
	}
	let previousSize = Number.POSITIVE_INFINITY;
	for (;;) {
		const size = measure(clone);
		if (size === undefined) return CONTENT_UNSERIALIZABLE;
		if (size <= budget) return clone;
		// A sentinel-bearing replacement is never shorter than ~126 bytes, so a
		// short leaf can come back equal or larger. The size of each pass must
		// strictly decrease or no sequence of leaf truncations can ever fit.
		if (size >= previousSize) return CONTENT_BUDGET_EXCEEDED;
		previousSize = size;
		const leaf = longestStringLeaf(clone);
		if (!leaf) return CONTENT_BUDGET_EXCEEDED;
		const leafBytes = ENCODER.encode(leaf.value).byteLength;
		if (leafBytes < MIN_LEAF_BYTES) return CONTENT_BUDGET_EXCEEDED;
		leaf.set(truncateString(leaf.value, Math.max(Math.floor(leafBytes / 2), MIN_BUDGET_BYTES)));
	}
}

interface StringLeaf {
	value: string;
	set(replacement: string): void;
}

function longestStringLeaf(value: unknown): StringLeaf | undefined {
	let best: StringLeaf | undefined;
	walk(value);
	return best;

	function walk(node: unknown): void {
		if (Array.isArray(node)) {
			node.forEach((child, index) => {
				visit(child, (replacement) => (node[index] = replacement));
			});
			return;
		}
		if (node !== null && typeof node === 'object') {
			for (const [key, child] of Object.entries(node)) {
				visit(child, (replacement) => ((node as Record<string, unknown>)[key] = replacement));
			}
		}
	}

	function visit(child: unknown, set: (replacement: string) => void): void {
		if (typeof child === 'string') {
			if (!best || child.length > best.value.length) best = { value: child, set };
			return;
		}
		walk(child);
	}
}
