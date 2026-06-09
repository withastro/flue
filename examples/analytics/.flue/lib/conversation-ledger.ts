import type { SessionPlan, TurnContext } from './session-plan.ts';
import type { ExplorationRequest } from './exploration.ts';

export type LedgerReplyType = 'final' | 'followup_question';

export interface ConversationLedgerEvent {
	phase: 'intake' | 'exploration' | 'order' | 'station' | 'postflight' | 'reply';
	summary: string;
	data?: unknown;
}

export interface ConversationLedger {
	version: 1;
	conversationId: string;
	streamName: string;
	runId?: string;
	turn: TurnContext;
	sessionPlan?: SessionPlan;
	events: ConversationLedgerEvent[];
	reply: {
		type: LedgerReplyType;
		text: string;
	};
	usage?: unknown;
}

export function buildConversationLedger(input: {
	rawUserMessage: string;
	resolvedTask?: string;
	runId?: string;
	turn: TurnContext;
	sessionPlan?: SessionPlan;
	decision?: unknown;
	explorationRequest?: ExplorationRequest;
	explorer?: unknown;
	order?: unknown;
	kitchen?: unknown;
	postflight?: unknown;
	reply: string;
	replyType: LedgerReplyType;
	usage?: unknown;
}): ConversationLedger {
	const conversationId = input.sessionPlan?.conversationSessionName || 'default';
	const streamName = input.sessionPlan?.streamName || 'main';
	const events: ConversationLedgerEvent[] = [
		{
			phase: 'intake',
			summary: input.resolvedTask && input.resolvedTask !== input.rawUserMessage
				? 'Resolved the latest user message against conversation context.'
				: 'Received user message.',
			data: compactObject({
				rawUserMessage: input.rawUserMessage,
				resolvedTask: input.resolvedTask,
				decision: input.decision,
			}),
		},
	];

	if (input.explorationRequest || input.explorer) {
		events.push({
			phase: 'exploration',
			summary: input.explorationRequest
				? 'Executed caller-directed exploration request.'
				: 'Used existing continuation context without preflight exploration.',
			data: compactObject({
				request: input.explorationRequest,
				result: input.explorer,
			}),
		});
	}
	if (input.order) {
		events.push({
			phase: 'order',
			summary: 'Created domain work order.',
			data: input.order,
		});
	}
	if (input.kitchen) {
		events.push({
			phase: 'station',
			summary: 'Received domain station result.',
			data: input.kitchen,
		});
	}
	if (input.postflight) {
		events.push({
			phase: 'postflight',
			summary: 'Reviewed station result for user-facing response.',
			data: input.postflight,
		});
	}
	events.push({
		phase: 'reply',
		summary: input.replyType === 'followup_question' ? 'Returned user follow-up question.' : 'Returned final user reply.',
		data: {
			replyType: input.replyType,
			reply: input.reply,
		},
	});

	return {
		version: 1,
		conversationId,
		streamName,
		runId: input.runId,
		turn: input.turn,
		sessionPlan: input.sessionPlan,
		events,
		reply: {
			type: input.replyType,
			text: input.reply,
		},
		usage: input.usage,
	};
}

function compactObject<T extends Record<string, unknown>>(value: T): Partial<T> {
	return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}
