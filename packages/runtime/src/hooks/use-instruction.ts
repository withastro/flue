import { requireRenderFrame } from './frame.ts';

/**
 * Append raw instruction text for the current render — the deliberately
 * low-level escape hatch. Text lands after the agent's returned instruction,
 * in call order — whether called directly in the agent body or inside a
 * custom hook. No structure, no identity, no change tracking: prefer a
 * custom hook for anything coherent.
 *
 * ```ts
 * export function Marketing() {
 *   useInstruction('Write in Acme voice: warm, concise.');
 *   return 'You draft marketing copy for Acme.';
 * }
 * ```
 *
 * Callable only while the agent function renders (directly in its body or in
 * a custom hook it calls); throws anywhere else.
 */
export function useInstruction(text: string): void {
	const frame = requireRenderFrame('useInstruction');
	if (typeof text !== 'string' || text.trim().length === 0) {
		throw new Error('[flue] useInstruction() requires a non-empty string.');
	}
	frame.instructions.push(text);
}
