import type { CompactionConfig, DurabilityConfig, ThinkingLevel } from './types.ts';

/**
 * Field validation for agent tuning values, shared by the hooks that accept
 * them at render time (`useModel`) and the registration layer that accepts
 * them from module exports (`durability`).
 */

const VALID_THINKING_LEVELS = {
	off: true,
	minimal: true,
	low: true,
	medium: true,
	high: true,
	xhigh: true,
	max: true,
} as const satisfies Record<ThinkingLevel, true>;

export function assertThinkingLevel(value: ThinkingLevel | undefined, label: string): void {
	if (value !== undefined && !Object.hasOwn(VALID_THINKING_LEVELS, value)) {
		throw new Error(
			`[flue] ${label} thinkingLevel must be one of: ${Object.keys(VALID_THINKING_LEVELS).join(', ')}.`,
		);
	}
}

export function assertCompaction(
	definition: false | CompactionConfig | undefined,
	label: string,
): void {
	if (definition === undefined || definition === false) {
		return;
	}
	if (typeof definition !== 'object' || definition === null || Array.isArray(definition)) {
		throw new Error(`[flue] ${label} compaction must be a configuration object or \`false\`.`);
	}
	for (const key of Object.keys(definition)) {
		if (key !== 'reserveTokens' && key !== 'keepRecentTokens' && key !== 'model') {
			throw new Error(`[flue] ${label} compaction received unknown field "${key}".`);
		}
	}
	assertTokenCount(definition.reserveTokens, `${label} compaction.reserveTokens`);
	assertTokenCount(definition.keepRecentTokens, `${label} compaction.keepRecentTokens`);
	if (definition.model !== undefined && typeof definition.model !== 'string') {
		throw new Error(`[flue] ${label} compaction.model must be a string.`);
	}
}

export function assertDurability(definition: DurabilityConfig | undefined, label: string): void {
	if (definition === undefined) return;
	if (typeof definition !== 'object' || definition === null || Array.isArray(definition)) {
		throw new Error(`[flue] ${label} durability must be a configuration object.`);
	}
	for (const key of Object.keys(definition)) {
		if (key !== 'maxAttempts' && key !== 'timeoutMs') {
			throw new Error(`[flue] ${label} durability received unknown field "${key}".`);
		}
	}
	assertPositiveInteger(definition.maxAttempts, `${label} durability.maxAttempts`);
	assertPositiveInteger(definition.timeoutMs, `${label} durability.timeoutMs`);
}

function assertPositiveInteger(value: number | undefined, label: string): void {
	if (value === undefined) return;
	if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
		throw new Error(`[flue] ${label} must be a positive integer.`);
	}
}

function assertTokenCount(value: number | undefined, label: string): void {
	if (value === undefined) {
		return;
	}
	if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
		throw new Error(`[flue] ${label} must be a non-negative integer.`);
	}
}
