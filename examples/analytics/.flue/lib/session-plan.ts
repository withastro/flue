import * as v from 'valibot';
import { createHash } from 'node:crypto';

export const TurnTypeSchema = v.picklist(['mainline', 'side_question', 'rework', 'topic_switch']);
export const StationRouteSchema = v.picklist(['analytics', 'knowledge', 'workflow', 'documentation']);

export type TurnType = v.InferOutput<typeof TurnTypeSchema>;
export type StationRoute = v.InferOutput<typeof StationRouteSchema>;

export interface TurnContext {
	type: TurnType;
	trigger: 'turnType' | 'legacy_rework' | 'default';
	isRework: boolean;
	usesBranchStationSession: boolean;
}

export interface SessionPlan {
	conversationSessionName: string;
	streamName: string;
	waiterSessionName: string;
	preflightSessionName: string;
	stationSessionName?: string;
	usesBranchStationSession: boolean;
	runPart: string;
}

export function resolveTurnContext(input: {
	turnType?: TurnType;
	rework?: boolean;
}): TurnContext {
	const type = input.turnType ?? (input.rework ? 'rework' : 'mainline');
	const effectiveType = input.rework && type === 'mainline' ? 'rework' : type;
	return {
		type: effectiveType,
		trigger: input.turnType
			? 'turnType'
			: input.rework
				? 'legacy_rework'
				: 'default',
		isRework: effectiveType === 'rework',
		usesBranchStationSession: effectiveType === 'side_question' || effectiveType === 'topic_switch',
	};
}

export function createSessionPlan(input: {
	sessionName?: string;
	streamName?: string;
	branchName?: string;
	turnType: TurnType;
	runId?: string;
	route?: StationRoute;
}): SessionPlan {
	const conversationSessionName = safeSessionPart(input.sessionName || 'default', 28);
	const runPart = safeSessionPart(input.runId || String(Date.now()), 24);
	const streamName = safeSessionPart(
		input.turnType === 'topic_switch' && !input.streamName
			? `topic-${runPart}`
			: input.streamName || 'main',
		20,
	);
	const branchName = safeSessionPart(input.branchName || runPart, 20);
	const usesBranchStationSession = input.turnType === 'side_question' || input.turnType === 'topic_switch';
	const streamPrefix = `${conversationSessionName}:s:${streamName}`;
	const stationSessionName = input.route
		? usesBranchStationSession
			? `${streamPrefix}:b:${branchName}:st:${safeSessionPart(input.route, 16)}`
			: `${streamPrefix}:st:${safeSessionPart(input.route, 16)}`
		: undefined;

	return {
		conversationSessionName,
		streamName,
		waiterSessionName: conversationSessionName,
		preflightSessionName: `${streamPrefix}:pf:${runPart}`,
		stationSessionName,
		usesBranchStationSession,
		runPart,
	};
}

export function shouldInvokeWaiter(input: {
	activeRoute?: StationRoute;
	turnType?: TurnType;
	rework?: boolean;
}): boolean {
	void input;
	return true;
}

function safeSessionPart(value: string, maxLength = 48): string {
	const cleaned = value.trim().replace(/[^A-Za-z0-9_.:-]+/g, '_').replace(/^_+|_+$/g, '');
	if (!cleaned) return 'default';
	if (cleaned.length <= maxLength) return cleaned;
	const hash = createHash('sha256').update(cleaned).digest('hex').slice(0, 10);
	const prefixLength = Math.max(1, maxLength - hash.length - 1);
	const prefix = cleaned.slice(0, prefixLength).replace(/[_:.:-]+$/g, '') || 'x';
	return `${prefix}_${hash}`;
}
