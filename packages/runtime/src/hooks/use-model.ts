import { assertCompaction, assertThinkingLevel } from '../agent-tuning.ts';
import type { CompactionConfig, ThinkingLevel } from '../types.ts';
import { requireRenderFrame } from './frame.ts';

/** Model-call tuning accepted alongside the model specifier. */
export interface UseModelOptions {
	/** Default reasoning effort. Individual operations may override this value. */
	thinkingLevel?: ThinkingLevel;
	/**
	 * Automatic conversation-compaction configuration. `false` disables
	 * threshold compaction; overflow recovery and explicit compaction still
	 * compact when needed.
	 */
	compaction?: false | CompactionConfig;
}

/**
 * Declare the agent's model — `useModel('anthropic/claude-sonnet-4-6')`.
 * Required: an agent render without a `useModel` call cannot start.
 *
 * Call it exactly once per render, in the agent function body or a custom
 * hook it calls. The ARGUMENT may vary render to render (pick a model from
 * durable state); the CALL may not disappear.
 *
 * Values are SUBMISSION-SCOPED: the runtime reads them when a submission
 * starts, so a different value computed by a later render takes effect on
 * the next submission, not mid-run.
 *
 * `options` carries model-call tuning: `thinkingLevel` (default reasoning
 * effort) and `compaction` (threshold-compaction configuration, or `false`
 * to disable).
 */
export function useModel(model: string, options: UseModelOptions = {}): void {
	const frame = requireRenderFrame('useModel');
	if (frame.kind === 'subagent') {
		throw new Error(
			'[flue] useModel() is not available in a subagent render. A delegate declares its model on its useSubagent() definition.',
		);
	}
	if (frame.model !== undefined) {
		throw new Error(
			'[flue] useModel() was called twice in one render. An agent has one model; call useModel() exactly once (compute the specifier before the call if it depends on state).',
		);
	}
	if (typeof model !== 'string' || model.trim().length === 0) {
		throw new Error(
			"[flue] useModel() requires a model specifier string, like 'anthropic/claude-sonnet-4-6'.",
		);
	}
	if (options === null || typeof options !== 'object' || Array.isArray(options)) {
		throw new Error('[flue] useModel() options must be an object.');
	}
	for (const key of Object.keys(options)) {
		if (key !== 'thinkingLevel' && key !== 'compaction') {
			throw new Error(`[flue] useModel() options received unknown field "${key}".`);
		}
	}
	assertThinkingLevel(options.thinkingLevel, 'useModel() options');
	assertCompaction(options.compaction, 'useModel() options');
	frame.model = model;
	if (options.thinkingLevel !== undefined) frame.thinkingLevel = options.thinkingLevel;
	if (options.compaction !== undefined) frame.compaction = options.compaction;
}
