import * as v from 'valibot';

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
	const conversationSessionName = input.sessionName || 'default';
	const runPart = safeSessionPart(input.runId || String(Date.now()));
	const streamName = safeSessionPart(
		input.turnType === 'topic_switch' && !input.streamName
			? `topic-${runPart}`
			: input.streamName || 'main',
	);
	const branchName = safeSessionPart(input.branchName || runPart);
	const usesBranchStationSession = input.turnType === 'side_question' || input.turnType === 'topic_switch';
	const streamPrefix = `${conversationSessionName}:stream:${streamName}`;
	const stationSessionName = input.route
		? usesBranchStationSession
			? `${streamPrefix}:branch:${branchName}:station:${safeSessionPart(input.route)}`
			: `${streamPrefix}:station:${safeSessionPart(input.route)}`
		: undefined;

	return {
		conversationSessionName,
		streamName,
		waiterSessionName: conversationSessionName,
		preflightSessionName: `${streamPrefix}:preflight:${runPart}`,
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

function safeSessionPart(value: string): string {
	const cleaned = value.trim().replace(/[^A-Za-z0-9_.:-]+/g, '_').replace(/^_+|_+$/g, '');
	return cleaned.slice(0, 80) || 'default';
}
