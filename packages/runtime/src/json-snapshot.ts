export type JsonValue =
	null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export function cloneJsonSerializable(value: unknown, label: string): unknown {
	assertJsonLike(value, label, new WeakSet());
	let json: string;
	try {
		json = JSON.stringify(value);
	} catch (error) {
		throw new Error(
			`[flue] ${label} must be JSON-serializable: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return JSON.parse(json) as unknown;
}

function assertJsonLike(value: unknown, path: string, seen: WeakSet<object>): void {
	if (value === null) return;
	const type = typeof value;
	if (type === 'string' || type === 'number' || type === 'boolean') {
		if (type === 'number' && !Number.isFinite(value)) {
			throw new Error(`[flue] ${path} must not contain non-finite numbers.`);
		}
		return;
	}
	if (type === 'undefined' || type === 'function' || type === 'symbol' || type === 'bigint') {
		throw new Error(`[flue] ${path} must not contain ${type} values.`);
	}
	if (typeof value !== 'object') return;
	if (seen.has(value)) throw new Error(`[flue] ${path} must not contain circular references.`);
	seen.add(value);
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) assertJsonLike(value[i], `${path}[${i}]`, seen);
		seen.delete(value);
		return;
	}
	if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
		throw new Error(
			`[flue] ${path} must contain only plain JSON objects, arrays, strings, numbers, booleans, or null.`,
		);
	}
	for (const [key, child] of Object.entries(value)) {
		// Match JSON.stringify: an object property whose value is undefined is
		// dropped, not an error. Idiomatic optional fields (`field?: T` left
		// unset) serialize cleanly; only undefined in non-droppable positions
		// (top level, array elements) still fails below.
		if (child === undefined) continue;
		assertJsonLike(child, `${path}.${key}`, seen);
	}
	seen.delete(value);
}
