/**
 * Shared JSON round-trip normalization for `useDataWriter` and
 * `usePersistentState`: reject `undefined`, `JSON.stringify` the value,
 * reject a stringify that itself produces `undefined` (e.g. a function or
 * symbol), then `JSON.parse` back — so the stored/emitted value is exactly
 * the shape a JSON round trip through the wire would produce. The two hooks
 * only differ in how they phrase the "written as undefined" case and in the
 * noun used across all three messages; both are supplied by the caller so
 * the emitted text stays exactly what each hook already says today.
 */
export function normalizeJsonValue(
	value: unknown,
	options: { label: string; name: string; undefinedMessage: string },
): unknown {
	if (value === undefined) {
		throw new Error(options.undefinedMessage);
	}
	let text: string | undefined;
	try {
		text = JSON.stringify(value);
	} catch (error) {
		throw new Error(
			`[flue] ${options.label} "${options.name}" value is not JSON-serializable: ${error instanceof Error ? error.message : String(error)}.`,
		);
	}
	if (text === undefined) {
		throw new Error(`[flue] ${options.label} "${options.name}" value is not JSON-serializable.`);
	}
	return JSON.parse(text);
}
