/**
 * Context compaction for long sessions. When context approaches the model's
 * window limit, older messages are summarized and replaced with a structured summary.
 *
 * Trigger modes:
 * 1. Threshold — tokens exceed (contextWindow - reserveTokens). Compact, no retry.
 * 2. Overflow — LLM returned context overflow. Compact, then auto-retry.
 */
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import { completeSimple, isContextOverflow } from '@mariozechner/pi-ai';
import type {
	AssistantMessage,
	Message,
	Model,
	SimpleStreamOptions,
	TextContent,
	ToolResultMessage,
	Usage,
	UserMessage,
} from '@mariozechner/pi-ai';

// ─── Settings ───────────────────────────────────────────────────────────────

export interface CompactionSettings {
	enabled: boolean;
	reserveTokens: number;
	keepRecentTokens: number;
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
	enabled: true,
	reserveTokens: 16384,
	keepRecentTokens: 20000,
};

// ─── Token Estimation ───────────────────────────────────────────────────────

export function calculateContextTokens(usage: Usage): number {
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function getAssistantUsage(msg: AgentMessage): Usage | undefined {
	if (msg.role === 'assistant' && 'usage' in msg) {
		const assistantMsg = msg as AssistantMessage;
		if (
			assistantMsg.stopReason !== 'aborted' &&
			assistantMsg.stopReason !== 'error' &&
			assistantMsg.usage
		) {
			return assistantMsg.usage;
		}
	}
	return undefined;
}

function getLastAssistantUsageInfo(
	messages: AgentMessage[],
): { usage: Usage; index: number } | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i]!;
		const usage = getAssistantUsage(msg);
		if (usage) return { usage, index: i };
	}
	return undefined;
}

/** chars/4 heuristic. Conservative (overestimates). */
export function estimateTokens(message: AgentMessage): number {
	let chars = 0;
	switch (message.role) {
		case 'user': {
			const { content } = message as UserMessage;
			if (typeof content === 'string') {
				chars = content.length;
			} else if (Array.isArray(content)) {
				for (const block of content) {
					if (block.type === 'text') {
						chars += block.text.length;
					}
				}
			}
			return Math.ceil(chars / 4);
		}
		case 'assistant': {
			const { content } = message as AssistantMessage;
			for (const block of content) {
				if (block.type === 'text') {
					chars += block.text.length;
				} else if (block.type === 'thinking') {
					chars += block.thinking.length;
				} else if (block.type === 'toolCall') {
					chars += block.name.length + JSON.stringify(block.arguments).length;
				}
			}
			return Math.ceil(chars / 4);
		}
		case 'toolResult': {
			const { content } = message as ToolResultMessage;
			for (const block of content) {
				if (block.type === 'text') {
					chars += block.text.length;
				} else if (block.type === 'image') {
					// Approximate token cost for an image block
					chars += 4800;
				}
			}
			return Math.ceil(chars / 4);
		}
	}
	return 0;
}

export function estimateContextTokens(messages: AgentMessage[]): {
	tokens: number;
	usageTokens: number;
	trailingTokens: number;
	lastUsageIndex: number | null;
} {
	const usageInfo = getLastAssistantUsageInfo(messages);
	if (!usageInfo) {
		let estimated = 0;
		for (const message of messages) {
			estimated += estimateTokens(message);
		}
		return { tokens: estimated, usageTokens: 0, trailingTokens: estimated, lastUsageIndex: null };
	}
	const usageTokens = calculateContextTokens(usageInfo.usage);
	let trailingTokens = 0;
	for (let i = usageInfo.index + 1; i < messages.length; i++) {
		trailingTokens += estimateTokens(messages[i]!);
	}
	return {
		tokens: usageTokens + trailingTokens,
		usageTokens,
		trailingTokens,
		lastUsageIndex: usageInfo.index,
	};
}

export function shouldCompact(
	contextTokens: number,
	contextWindow: number,
	settings: CompactionSettings,
): boolean {
	if (!settings.enabled) return false;
	return contextTokens > contextWindow - settings.reserveTokens;
}

// ─── File Operation Tracking ────────────────────────────────────────────────

interface FileOps {
	read: Set<string>;
	written: Set<string>;
	edited: Set<string>;
}

function createFileOps(): FileOps {
	return { read: new Set(), written: new Set(), edited: new Set() };
}

function extractFileOpsFromMessage(message: AgentMessage, fileOps: FileOps): void {
	if (message.role !== 'assistant') return;
	const assistant = message as AssistantMessage;
	if (!Array.isArray(assistant.content)) return;
	for (const block of assistant.content) {
		if (block.type !== 'toolCall') continue;
		const args = block.arguments;
		if (!args) continue;
		const path = typeof args.path === 'string' ? args.path : undefined;
		if (!path) continue;
		switch (block.name) {
			case 'read':
				fileOps.read.add(path);
				break;
			case 'write':
				fileOps.written.add(path);
				break;
			case 'edit':
				fileOps.edited.add(path);
				break;
		}
	}
}

function computeFileLists(fileOps: FileOps): { readFiles: string[]; modifiedFiles: string[] } {
	const modified = new Set([...fileOps.edited, ...fileOps.written]);
	const readOnly = [...fileOps.read].filter((f) => !modified.has(f)).sort();
	const modifiedFiles = [...modified].sort();
	return { readFiles: readOnly, modifiedFiles };
}

function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
	const sections: string[] = [];
	if (readFiles.length > 0) {
		sections.push(`<read-files>\n${readFiles.join('\n')}\n</read-files>`);
	}
	if (modifiedFiles.length > 0) {
		sections.push(`<modified-files>\n${modifiedFiles.join('\n')}\n</modified-files>`);
	}
	if (sections.length === 0) return '';
	return `\n\n${sections.join('\n\n')}`;
}

// ─── Message Serialization ──────────────────────────────────────────────────

const TOOL_RESULT_MAX_CHARS = 2000;

function truncateForSummary(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const truncatedChars = text.length - maxChars;
	return `${text.slice(0, maxChars)}\n\n[... ${truncatedChars} more characters truncated]`;
}

/** Serialize messages to text so the summarization model doesn't treat it as a conversation to continue. */
function serializeConversation(messages: AgentMessage[]): string {
	const parts: string[] = [];
	for (const msg of messages) {
		if (msg.role === 'user') {
			const { content } = msg as UserMessage;
			const text =
				typeof content === 'string'
					? content
					: content
							.filter((c): c is TextContent => c.type === 'text')
							.map((c) => c.text)
							.join('');
			if (text) parts.push(`[User]: ${text}`);
		} else if (msg.role === 'assistant') {
			const { content } = msg as AssistantMessage;
			const textParts: string[] = [];
			const thinkingParts: string[] = [];
			const toolCalls: string[] = [];
			for (const block of content) {
				if (block.type === 'text') {
					textParts.push(block.text);
				} else if (block.type === 'thinking') {
					thinkingParts.push(block.thinking);
				} else if (block.type === 'toolCall') {
					const argsStr = Object.entries(block.arguments)
						.map(([k, v]) => `${k}=${JSON.stringify(v)}`)
						.join(', ');
					toolCalls.push(`${block.name}(${argsStr})`);
				}
			}
			if (thinkingParts.length > 0) {
				parts.push(`[Assistant thinking]: ${thinkingParts.join('\n')}`);
			}
			if (textParts.length > 0) {
				parts.push(`[Assistant]: ${textParts.join('\n')}`);
			}
			if (toolCalls.length > 0) {
				parts.push(`[Assistant tool calls]: ${toolCalls.join('; ')}`);
			}
		} else if (msg.role === 'toolResult') {
			const { content } = msg as ToolResultMessage;
			const text = content
				.filter((c): c is TextContent => c.type === 'text')
				.map((c) => c.text)
				.join('');
			if (text) {
				parts.push(`[Tool result]: ${truncateForSummary(text, TOOL_RESULT_MAX_CHARS)}`);
			}
		}
	}
	return parts.join('\n\n');
}

// ─── Summarization Prompts ──────────────────────────────────────────────────

const SUMMARIZATION_SYSTEM_PROMPT =
	'You are a context summarization assistant. Your task is to read a conversation between a user and an AI coding assistant, then produce a structured summary following the exact format specified.\n\nDo NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.';

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const TURN_PREFIX_SUMMARIZATION_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix.`;

// ─── Cut Point Detection ────────────────────────────────────────────────────

/** Valid cut points: user or assistant messages. Never cut at toolResult. */
function findValidCutPoints(messages: AgentMessage[], start: number, end: number): number[] {
	const cutPoints: number[] = [];
	for (let i = start; i < end; i++) {
		const role = messages[i]!.role;
		if (role === 'user' || role === 'assistant') {
			cutPoints.push(i);
		}
	}
	return cutPoints;
}

function findTurnStartIndex(messages: AgentMessage[], index: number, start: number): number {
	for (let i = index; i >= start; i--) {
		if (messages[i]!.role === 'user') return i;
	}
	return -1;
}

interface CutPointResult {
	firstKeptIndex: number;
	turnStartIndex: number;
	isSplitTurn: boolean;
}

function findCutPoint(
	messages: AgentMessage[],
	start: number,
	end: number,
	keepRecentTokens: number,
): CutPointResult {
	const cutPoints = findValidCutPoints(messages, start, end);
	if (cutPoints.length === 0) {
		return { firstKeptIndex: start, turnStartIndex: -1, isSplitTurn: false };
	}

	let accumulatedTokens = 0;
	let cutIndex = cutPoints[0]!;

	for (let i = end - 1; i >= start; i--) {
		const messageTokens = estimateTokens(messages[i]!);
		accumulatedTokens += messageTokens;
		if (accumulatedTokens >= keepRecentTokens) {
			for (let c = 0; c < cutPoints.length; c++) {
				if (cutPoints[c]! >= i) {
					cutIndex = cutPoints[c]!;
					break;
				}
			}
			break;
		}
	}

	const isUserMessage = messages[cutIndex]!.role === 'user';
	const turnStartIndex = isUserMessage ? -1 : findTurnStartIndex(messages, cutIndex, start);

	return {
		firstKeptIndex: cutIndex,
		turnStartIndex,
		isSplitTurn: !isUserMessage && turnStartIndex !== -1,
	};
}

// ─── Compaction Preparation ─────────────────────────────────────────────────

export interface CompactionPreparation {
	firstKeptIndex: number;
	messagesToSummarize: AgentMessage[];
	turnPrefixMessages: AgentMessage[];
	isSplitTurn: boolean;
	tokensBefore: number;
	previousSummary: string | undefined;
	fileOps: FileOps;
	settings: CompactionSettings;
}

export interface CompactionResult {
	summary: string;
	firstKeptIndex: number;
	tokensBefore: number;
	details: { readFiles: string[]; modifiedFiles: string[] };
}

/** Pure function — no I/O. Finds cut point, extracts messages to summarize, tracks file ops. */
export function prepareCompaction(
	messages: AgentMessage[],
	settings: CompactionSettings,
	previousCompaction?: {
		summary: string;
		firstKeptIndex: number;
		details?: { readFiles: string[]; modifiedFiles: string[] };
	},
): CompactionPreparation | undefined {
	if (messages.length === 0) return undefined;

	const boundaryStart = previousCompaction ? previousCompaction.firstKeptIndex : 0;
	const boundaryEnd = messages.length;
	const tokensBefore = estimateContextTokens(messages).tokens;

	const cutPoint = findCutPoint(messages, boundaryStart, boundaryEnd, settings.keepRecentTokens);

	if (cutPoint.firstKeptIndex <= boundaryStart) return undefined;

	const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptIndex;

	const messagesToSummarize = messages.slice(boundaryStart, historyEnd);
	const turnPrefixMessages = cutPoint.isSplitTurn
		? messages.slice(cutPoint.turnStartIndex, cutPoint.firstKeptIndex)
		: [];

	const fileOps = createFileOps();
	if (previousCompaction?.details) {
		for (const f of previousCompaction.details.readFiles ?? []) fileOps.read.add(f);
		for (const f of previousCompaction.details.modifiedFiles ?? []) fileOps.edited.add(f);
	}
	for (const msg of messagesToSummarize) {
		extractFileOpsFromMessage(msg, fileOps);
	}
	for (const msg of turnPrefixMessages) {
		extractFileOpsFromMessage(msg, fileOps);
	}

	return {
		firstKeptIndex: cutPoint.firstKeptIndex,
		messagesToSummarize,
		turnPrefixMessages,
		isSplitTurn: cutPoint.isSplitTurn,
		tokensBefore,
		previousSummary: previousCompaction?.summary,
		fileOps,
		settings,
	};
}

// ─── Summary Generation ─────────────────────────────────────────────────────

async function generateSummary(
	currentMessages: AgentMessage[],
	model: Model<any>,
	reserveTokens: number,
	apiKey: string | undefined,
	signal: AbortSignal | undefined,
	previousSummary?: string,
): Promise<string> {
	const maxTokens = Math.min(Math.floor(0.8 * reserveTokens), 16000);
	const basePrompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;

	const conversationText = serializeConversation(currentMessages);
	let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
	if (previousSummary) {
		promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
	}
	promptText += basePrompt;

	const summarizationMessages: UserMessage[] = [
		{ role: 'user', content: [{ type: 'text', text: promptText }], timestamp: Date.now() },
	];

	const completionOptions: SimpleStreamOptions = { maxTokens, signal };
	if (apiKey) completionOptions.apiKey = apiKey;
	if (model.reasoning) completionOptions.reasoning = 'high';

	const response = await completeSimple(
		model,
		{ systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages },
		completionOptions,
	);

	if (response.stopReason === 'error') {
		throw new Error(`Summarization failed: ${response.errorMessage || 'Unknown error'}`);
	}

	return response.content
		.filter((c): c is TextContent => c.type === 'text')
		.map((c) => c.text)
		.join('\n');
}

async function generateTurnPrefixSummary(
	messages: AgentMessage[],
	model: Model<any>,
	reserveTokens: number,
	apiKey: string | undefined,
	signal: AbortSignal | undefined,
): Promise<string> {
	const maxTokens = Math.min(Math.floor(0.5 * reserveTokens), 16000);
	const conversationText = serializeConversation(messages);
	const promptText = `<conversation>\n${conversationText}\n</conversation>\n\n${TURN_PREFIX_SUMMARIZATION_PROMPT}`;

	const summarizationMessages: UserMessage[] = [
		{ role: 'user', content: [{ type: 'text', text: promptText }], timestamp: Date.now() },
	];

	const completionOptions: SimpleStreamOptions = { maxTokens, signal };
	if (apiKey) completionOptions.apiKey = apiKey;

	const response = await completeSimple(
		model,
		{ systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages },
		completionOptions,
	);

	if (response.stopReason === 'error') {
		throw new Error(
			`Turn prefix summarization failed: ${response.errorMessage || 'Unknown error'}`,
		);
	}

	return response.content
		.filter((c): c is TextContent => c.type === 'text')
		.map((c) => c.text)
		.join('\n');
}

// ─── Main Compaction Function ───────────────────────────────────────────────

export async function compact(
	preparation: CompactionPreparation,
	model: Model<any>,
	apiKey: string | undefined,
	signal?: AbortSignal,
): Promise<CompactionResult> {
	const {
		firstKeptIndex,
		messagesToSummarize,
		turnPrefixMessages,
		isSplitTurn,
		tokensBefore,
		previousSummary,
		fileOps,
		settings,
	} = preparation;

	let summary: string;
	if (isSplitTurn && turnPrefixMessages.length > 0) {
		const [historyResult, turnPrefixResult] = await Promise.all([
			messagesToSummarize.length > 0
				? generateSummary(
						messagesToSummarize,
						model,
						settings.reserveTokens,
						apiKey,
						signal,
						previousSummary,
					)
				: Promise.resolve('No prior history.'),
			generateTurnPrefixSummary(turnPrefixMessages, model, settings.reserveTokens, apiKey, signal),
		]);
		summary = `${historyResult}\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefixResult}`;
	} else {
		summary = await generateSummary(
			messagesToSummarize,
			model,
			settings.reserveTokens,
			apiKey,
			signal,
			previousSummary,
		);
	}

	const { readFiles, modifiedFiles } = computeFileLists(fileOps);
	summary += formatFileOperations(readFiles, modifiedFiles);

	return { summary, firstKeptIndex, tokensBefore, details: { readFiles, modifiedFiles } };
}
export { isContextOverflow };
