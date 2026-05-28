import { type FlueContext, type FlueSession } from '@flue/runtime';
import * as v from 'valibot';

import { localWithoutBuiltinTools } from '../lib/sandbox.ts';
import {
	createSessionPlan,
	resolveTurnContext,
	StationRouteSchema,
	type SessionPlan,
	type TurnContext,
	TurnTypeSchema,
} from '../lib/session-plan.ts';
import { analyticsToolset } from '../toolsets/analytics.ts';
import { explorerToolset } from '../toolsets/explorer.ts';
import {
	createArtifactPersistenceTools,
	createContextPersistenceTools,
	createTracePersistenceTools,
	createWorkflowPersistenceTools,
} from '../tools/persistence.ts';
import { createToolPolicy } from '../tools/policy.ts';
import { readSourceCatalogText, selectKbArticles } from '../tools/waiter-docs.ts';

export const triggers = { webhook: true };

const SourceSchema = v.picklist(['kb', 'manifest', 'bigquery', 'metabase', 'slack', 'drive', 'repo', 'jira']);
const RouteSchema = StationRouteSchema;

const PayloadSchema = v.object({
	message: v.string(),
	sessionName: v.optional(v.string(), 'default'),
	streamName: v.optional(v.string()),
	branchName: v.optional(v.string()),
	activeRoute: v.optional(RouteSchema),
	stationSessionName: v.optional(v.string()),
	turnType: v.optional(TurnTypeSchema),
	source: v.optional(v.picklist(['web', 'slack', 'cli']), 'cli'),
	userId: v.optional(v.string()),
	email: v.optional(v.string()),
	maxGb: v.optional(v.number(), 1),
	allowMetabaseCreate: v.optional(v.boolean(), false),
	allowGoogleDriveWrite: v.optional(v.boolean(), false),
	allowWorkflowMutation: v.optional(v.boolean(), false),
	waiterModel: v.optional(v.string()),
	kitchenModel: v.optional(v.string()),
	rework: v.optional(v.boolean(), false),
	priorAnswer: v.optional(v.string()),
});

type Route = v.InferOutput<typeof RouteSchema>;

const KitchenOrderSchema = v.object({
	route: RouteSchema,
	intent: v.string(),
	rewrittenTask: v.string(),
	sources: v.array(SourceSchema),
	constraints: v.array(v.string()),
	acceptanceCriteria: v.array(v.string()),
	allowedActions: v.array(v.string()),
	requestedOutput: v.string(),
	clarifyingQuestion: v.optional(v.string()),
});

type KitchenOrder = v.InferOutput<typeof KitchenOrderSchema>;

const WaiterDecisionSchema = v.object({
	action: v.picklist(['continue_station', 'run_preflight', 'clarify']),
	route: v.optional(RouteSchema),
	rationale: v.string(),
	stationInstruction: v.optional(v.string()),
	clarifyingQuestion: v.optional(v.string()),
});

type WaiterDecision = v.InferOutput<typeof WaiterDecisionSchema>;

const ExplorerPreflightSchema = v.object({
	status: v.picklist(['ready_for_analytics', 'needs_more_exploration', 'needs_user_clarification', 'blocked']),
	confidence: v.picklist(['low', 'medium', 'high']),
	recommendedRoute: RouteSchema,
	suggestedSources: v.array(SourceSchema),
	summary: v.string(),
	candidateModels: v.optional(v.array(
		v.object({
			name: v.string(),
			relationName: v.optional(v.string()),
			evidence: v.array(v.string()),
			concerns: v.array(v.string()),
		}),
	), []),
	recommendedNextStep: v.string(),
	gaps: v.array(v.string()),
});

const KitchenResultSchema = v.object({
	answer: v.string(),
	confidence: v.picklist(['low', 'medium', 'high']),
	artifacts: v.array(
		v.object({
			type: v.picklist(['sql', 'csv', 'metabase_card', 'doc_update', 'workflow_spec']),
			id: v.optional(v.string()),
			path: v.optional(v.string()),
			url: v.optional(v.string()),
		}),
	),
	followupQuestions: v.array(v.string()),
	kitchenSummary: v.string(),
	needsReview: v.boolean(),
});

type KitchenResult = v.InferOutput<typeof KitchenResultSchema>;

const PostflightReviewSchema = v.object({
	verdict: v.picklist(['accept', 'revise', 'clarify', 'block']),
	rationale: v.string(),
	issues: v.array(v.string()),
	feedbackToStation: v.optional(v.string()),
	userClarifyingQuestion: v.optional(v.string()),
	finalResponseGuidance: v.optional(v.string()),
});

type PostflightReview = v.InferOutput<typeof PostflightReviewSchema>;

const FinalResponseSchema = v.object({
	finalResponse: v.string(),
	needsUserClarification: v.boolean(),
	clarifyingQuestion: v.optional(v.string()),
});

export default async function ({ init, payload, id, runId }: FlueContext) {
	const parsed = v.parse(PayloadSchema, payload);
	const waiterModel = parsed.waiterModel || process.env.WAITER_MODEL || 'openai/gpt-4.1';
	const kitchenModel = parsed.kitchenModel || process.env.ANALYTICS_MODEL || 'openai/gpt-4.1-mini';
	const turn = resolveTurnContext({
		turnType: parsed.turnType,
		rework: parsed.rework,
	});
	const preflightSessionPlan = createSessionPlan({
		sessionName: parsed.sessionName,
		streamName: parsed.streamName,
		branchName: parsed.branchName,
		turnType: turn.type,
		runId,
	});
	const policy = createToolPolicy({
		source: parsed.source,
		userId: parsed.userId,
		email: parsed.email,
		conversationId: parsed.streamName || parsed.sessionName || id,
		runId,
		maxGb: parsed.maxGb,
		allowMetabaseCreate: parsed.allowMetabaseCreate,
		allowGoogleDriveWrite: parsed.allowGoogleDriveWrite,
		allowWorkflowMutation: parsed.allowWorkflowMutation,
	});

	const waiterHarness = await init({
		name: 'waiter',
		sandbox: localWithoutBuiltinTools(),
		model: waiterModel,
		role: 'waiter',
		tools: [
			...createContextPersistenceTools(policy),
			...createArtifactPersistenceTools(policy),
			...createTracePersistenceTools(),
		],
	});
	const waiterSession = await waiterHarness.session(preflightSessionPlan.waiterSessionName);

	const decisionResult = await decideWaiterAction({
		waiterSession,
		message: parsed.message,
		turn,
		activeRoute: parsed.activeRoute,
		streamName: preflightSessionPlan.streamName,
		stationSessionName: parsed.stationSessionName,
		priorAnswer: parsed.priorAnswer,
	});
	const decision = decisionResult.decision;
	const activeRoute = parsed.activeRoute;
	const canContinueStation = decision.action === 'continue_station' && activeRoute !== undefined && turn.type === 'mainline';
	if (canContinueStation) {
		const sessionPlan = createSessionPlan({
			sessionName: parsed.sessionName,
			streamName: preflightSessionPlan.streamName,
			branchName: parsed.branchName,
			turnType: 'mainline',
			runId,
			route: activeRoute,
		});
		const stationSessionName = parsed.stationSessionName || sessionPlan.stationSessionName;
		if (!stationSessionName) throw new Error('Station session name is required for station continuation.');
		const stationResult = await runStationContinuation({
			init,
			policy,
			kitchenModel,
			route: activeRoute,
			sessionName: stationSessionName,
			message: parsed.message,
			decision,
			maxGb: parsed.maxGb,
			allowMetabaseCreate: parsed.allowMetabaseCreate,
		});
		return {
			reply: stationResult.text,
			waiterModel,
			kitchenModel,
			turn,
			decision,
			sessionPlan: {
				...sessionPlan,
				stationSessionName,
			},
			usage: {
				waiter: { decision: decisionResult.usage },
				station: stationResult.usage,
			},
		};
	}

	if (decision.action === 'clarify' && decision.clarifyingQuestion) {
		return {
			reply: decision.clarifyingQuestion,
			waiterModel,
			kitchenModel,
			turn,
			decision,
			sessionPlan: preflightSessionPlan,
			usage: { waiter: { decision: decisionResult.usage } },
		};
	}

	const sourceCatalog = await readOptionalSourceCatalog();
	const selectedKbArticles = await selectKbArticles(parsed.message, { limit: 2 });
	const explorerResult = await runExplorerPreflight({
		init,
		policy,
		sessionName: preflightSessionPlan.preflightSessionName,
		message: parsed.message,
		turn,
		sessionPlan: preflightSessionPlan,
		sourceCatalog,
		selectedKbArticles,
	});
	const explorerData = applyPreflightQualityGate(explorerResult.data);
	const orderResult = await draftKitchenOrder({
		waiterSession,
		message: parsed.message,
		rework: turn.isRework,
		priorAnswer: parsed.priorAnswer,
		turn,
		explorerData,
		sourceCatalog,
	});
	const order = orderResult.order;
	const sessionPlan = createSessionPlan({
		sessionName: parsed.sessionName,
		streamName: preflightSessionPlan.streamName,
		branchName: parsed.branchName,
		turnType: turn.type,
		runId,
		route: order.route,
	});
	if (order.clarifyingQuestion) {
		return {
			reply: order.clarifyingQuestion,
			waiterModel,
			kitchenModel,
			turn,
			decision,
			sessionPlan,
			order,
			explorer: explorerData,
			usage: { waiter: { decision: decisionResult.usage, order: orderResult.usage }, explorer: explorerResult.usage },
		};
	}

	if (
		explorerData.status === 'needs_user_clarification' ||
		explorerData.status === 'blocked' ||
		(explorerData.status === 'needs_more_exploration' && !shouldDispatchForStationValidation(explorerData, order))
	) {
		const clarification = await waiterSession.prompt(
			[
				'Mode: clarify_or_block.',
				'The explorer utility could not produce a ready domain work order.',
				'Ask the user one concise clarifying question, explain the blocker, or state that more source research is required before domain work.',
				`Original user request:\n${parsed.message}`,
				`Turn context:\n${JSON.stringify(turn, null, 2)}`,
				`Session plan:\n${JSON.stringify(sessionPlan, null, 2)}`,
				`Draft work order:\n${JSON.stringify(order, null, 2)}`,
				`Explorer preflight:\n${JSON.stringify(explorerData, null, 2)}`,
			].join('\n\n'),
			{ result: FinalResponseSchema },
		);
		return {
			reply: clarification.data.finalResponse,
			waiterModel,
			kitchenModel,
			turn,
			decision,
			sessionPlan,
			order,
			explorer: explorerData,
			usage: { waiter: { decision: decisionResult.usage, order: orderResult.usage, final: clarification.usage }, explorer: explorerResult.usage },
		};
	}

	let kitchenResult;
	try {
		kitchenResult = await runKitchenStation({
			init,
			policy,
			kitchenModel,
			sessionPlan,
			turn,
			order,
			explorerData,
		});
	} catch (error) {
		const blockerResult = await waiterSession.prompt(
			[
				'Mode: station_failure_response.',
				'The analytics station failed before returning a schema result.',
				'Write a concise user-facing blocker response. Include what the explorer found, what analytics attempted, and what must be fixed next.',
				'Do not pretend the analysis was completed.',
				`Original user request:\n${parsed.message}`,
				`Turn context:\n${JSON.stringify(turn, null, 2)}`,
				`Session plan:\n${JSON.stringify(sessionPlan, null, 2)}`,
				`Work order:\n${JSON.stringify(order, null, 2)}`,
				`Explorer preflight:\n${JSON.stringify(explorerData, null, 2)}`,
				`Station error:\n${error instanceof Error ? error.message : String(error)}`,
			].join('\n\n'),
			{ result: FinalResponseSchema },
		);
		return {
			reply: blockerResult.data.finalResponse,
			waiterModel,
			kitchenModel,
			turn,
			decision,
			sessionPlan,
			order,
			explorer: explorerData,
			kitchenError: error instanceof Error ? error.message : String(error),
			usage: {
				waiter: { decision: decisionResult.usage, order: orderResult.usage, final: blockerResult.usage },
				explorer: explorerResult.usage,
			},
		};
	}

	const postflightReviews: Array<{ review: PostflightReview; usage?: unknown }> = [];
	const postflightResult = await reviewKitchenDelivery({
		waiterSession,
		message: parsed.message,
		turn,
		sessionPlan,
		order,
		explorerData,
		kitchenResult: kitchenResult.data,
		attempt: 1,
	});
	postflightReviews.push(postflightResult);

	let finalKitchenResult = kitchenResult;
	if (postflightResult.review.verdict === 'clarify' && postflightResult.review.userClarifyingQuestion) {
		return {
			reply: postflightResult.review.userClarifyingQuestion,
			waiterModel,
			kitchenModel,
			turn,
			decision,
			sessionPlan,
			order,
			explorer: explorerData,
			kitchen: kitchenResult.data,
			postflight: postflightReviews.map((entry) => entry.review),
			usage: {
				waiter: {
					decision: decisionResult.usage,
					order: orderResult.usage,
					postflight: postflightReviews.map((entry) => entry.usage),
				},
				explorer: explorerResult.usage,
				kitchen: kitchenResult.usage,
			},
		};
	}

	if (postflightResult.review.verdict === 'revise' && postflightResult.review.feedbackToStation) {
		finalKitchenResult = await reviseKitchenStation({
			session: kitchenResult.session,
			turn,
			sessionPlan,
			order,
			explorerData,
			previousResult: kitchenResult.data,
			review: postflightResult.review,
		});
		const secondPostflight = await reviewKitchenDelivery({
			waiterSession,
			message: parsed.message,
			turn,
			sessionPlan,
			order,
			explorerData,
			kitchenResult: finalKitchenResult.data,
			attempt: 2,
		});
		postflightReviews.push(secondPostflight);
		if (secondPostflight.review.verdict === 'clarify' && secondPostflight.review.userClarifyingQuestion) {
			return {
				reply: secondPostflight.review.userClarifyingQuestion,
				waiterModel,
				kitchenModel,
				turn,
				decision,
				sessionPlan,
				order,
				explorer: explorerData,
				kitchen: finalKitchenResult.data,
				postflight: postflightReviews.map((entry) => entry.review),
				usage: {
					waiter: {
						decision: decisionResult.usage,
						order: orderResult.usage,
						postflight: postflightReviews.map((entry) => entry.usage),
					},
					explorer: explorerResult.usage,
					kitchen: kitchenResult.usage,
					kitchenRevision: finalKitchenResult.usage,
				},
			};
		}
	}

	let finalResult;
	try {
		finalResult = await waiterSession.prompt(
			[
				'Mode: final_review.',
				'Review this station result and write the final user-facing response.',
				'Do not emit the station answer verbatim if it needs caveats, clarification, or formatting.',
				'If the station result is blocked, explain the blocker and the attempted plan.',
				`Original user request:\n${parsed.message}`,
				`Turn context:\n${JSON.stringify(turn, null, 2)}`,
				`Session plan:\n${JSON.stringify(sessionPlan, null, 2)}`,
				`Work order:\n${JSON.stringify(order, null, 2)}`,
				`Explorer preflight:\n${JSON.stringify(explorerData, null, 2)}`,
				`Postflight reviews:\n${JSON.stringify(postflightReviews.map((entry) => entry.review), null, 2)}`,
				`Station result:\n${JSON.stringify(finalKitchenResult.data, null, 2)}`,
			].join('\n\n'),
			{ result: FinalResponseSchema },
		);
	} catch (error) {
		return {
			reply: [
				'I could not complete the analysis because the final review step failed after the analytics station returned.',
				`Explorer preflight: ${explorerData.summary}`,
				`Station summary: ${finalKitchenResult.data.kitchenSummary}`,
				`Error: ${error instanceof Error ? error.message : String(error)}`,
			].join('\n\n'),
			waiterModel,
			kitchenModel,
			turn,
			decision,
			sessionPlan,
			order,
			explorer: explorerData,
			kitchen: finalKitchenResult.data,
			postflight: postflightReviews.map((entry) => entry.review),
			finalError: error instanceof Error ? error.message : String(error),
			usage: {
				waiter: {
					decision: decisionResult.usage,
					order: orderResult.usage,
					postflight: postflightReviews.map((entry) => entry.usage),
				},
				explorer: explorerResult.usage,
				kitchen: kitchenResult.usage,
				...(finalKitchenResult !== kitchenResult ? { kitchenRevision: finalKitchenResult.usage } : {}),
			},
		};
	}

	return {
		reply: finalResult.data.finalResponse,
		waiterModel,
		kitchenModel,
		turn,
		decision,
		sessionPlan,
		order,
		explorer: explorerData,
		kitchen: finalKitchenResult.data,
		postflight: postflightReviews.map((entry) => entry.review),
		usage: {
			waiter: {
				decision: decisionResult.usage,
				order: orderResult.usage,
				postflight: postflightReviews.map((entry) => entry.usage),
				final: finalResult.usage,
			},
			explorer: explorerResult.usage,
			kitchen: kitchenResult.usage,
			...(finalKitchenResult !== kitchenResult ? { kitchenRevision: finalKitchenResult.usage } : {}),
		},
	};
}

export function createKitchenOrder(
	message: string,
	rework = false,
	priorAnswer?: string,
	preflight?: v.InferOutput<typeof ExplorerPreflightSchema>,
): KitchenOrder {
	return createKitchenOrderFromPreflight(message, rework, priorAnswer, preflight);
}

async function decideWaiterAction(input: {
	waiterSession: FlueSession;
	message: string;
	turn: TurnContext;
	activeRoute?: Route;
	streamName: string;
	stationSessionName?: string;
	priorAnswer?: string;
}): Promise<{ decision: WaiterDecision; usage?: unknown }> {
	try {
		const result = await input.waiterSession.prompt(
			[
				'Mode: intake_decision.',
				'Every user-initiated message reaches this role first.',
				'Decide the next action. Do not answer the user from this step.',
				'Choose continue_station only when all are true:',
				'- this is a mainline turn',
				'- an active station route exists',
				'- the message is a natural continuation that the active station can answer from its session and tools',
				'- no new source selection, preflight research, re-routing, user clarification, or final-review gate is needed',
				'Choose run_preflight for side questions, rework, topic switches, ambiguous source-of-truth questions, route changes, or anything requiring new research before a station should work.',
				'Choose clarify only when the next useful step cannot be chosen without user input.',
				`Turn context:\n${JSON.stringify(input.turn, null, 2)}`,
				`Active route: ${input.activeRoute || 'none'}.`,
				`Active stream: ${input.streamName}.`,
				`Known station session: ${input.stationSessionName || 'derived from session plan when needed'}.`,
				input.priorAnswer ? `Prior rejected answer:\n${input.priorAnswer}` : '',
				`User message:\n${input.message}`,
			].filter(Boolean).join('\n\n'),
			{ result: WaiterDecisionSchema },
		);
		return { decision: result.data, usage: result.usage };
	} catch {
		return {
			decision: fallbackWaiterDecision(input),
		};
	}
}

function fallbackWaiterDecision(input: {
	message: string;
	turn: TurnContext;
	activeRoute?: Route;
}): WaiterDecision {
	if (input.turn.type === 'mainline' && input.activeRoute) {
		return {
			action: 'continue_station',
			route: input.activeRoute,
			rationale: 'Fallback: mainline turn with an active route can continue in the station.',
			stationInstruction: input.message,
		};
	}
	return {
		action: 'run_preflight',
		route: input.activeRoute,
		rationale: 'Fallback: no active mainline station or explicit turn flag requires orchestration.',
	};
}

async function runStationContinuation(input: {
	init: FlueContext['init'];
	policy: ReturnType<typeof createToolPolicy>;
	kitchenModel: string;
	route: Route;
	sessionName: string;
	message: string;
	decision: WaiterDecision;
	maxGb: number;
	allowMetabaseCreate: boolean;
}) {
	const harness = await input.init({
		name: `station-${input.route}`,
		sandbox: localWithoutBuiltinTools(),
		model: input.kitchenModel,
		role: input.route,
		tools: stationToolsForRoute(input.route, input.policy),
	});
	const session = await harness.session(input.sessionName);
	return session.prompt(
		[
			'Mode: station_continuation.',
			'Continue the active user thread directly. Answer the user without broad re-triage.',
			'Use this station session history for continuity.',
			'Use tools only when needed for an accurate answer.',
			`Active route: ${input.route}.`,
			`Default BigQuery dry-run limit: ${input.maxGb} GB.`,
			`Metabase creation enabled: ${input.allowMetabaseCreate ? 'yes' : 'no'}.`,
			`Waiter pass-through rationale:\n${input.decision.rationale}`,
			input.decision.stationInstruction ? `Waiter station instruction:\n${input.decision.stationInstruction}` : '',
			`User message:\n${input.message}`,
		].filter(Boolean).join('\n\n'),
	);
}

function createKitchenOrderFromPreflight(
	message: string,
	rework = false,
	priorAnswer?: string,
	preflight?: v.InferOutput<typeof ExplorerPreflightSchema>,
): KitchenOrder {
	const lower = message.toLowerCase();
	const analyticsSignals = [
		'bigquery',
		'bq',
		'dbt',
		'metabase',
		'sql',
		'model',
		'metric',
		'count',
		'volume',
		'trend',
		'cohort',
		'dashboard',
		'distribution',
		'cases by',
		'case creation',
		'incident',
		'firm',
		'month',
	];
	const route = preflight?.recommendedRoute ??
		(analyticsSignals.some((signal) => lower.includes(signal)) ? 'analytics' : 'knowledge');
	const sources = preflight?.suggestedSources?.length ? preflight.suggestedSources : selectSources(lower, route);
	const reworkPrefix = rework ? 'Rework request after rejected answer. ' : '';
	const priorContext = priorAnswer ? ` Prior rejected answer: ${priorAnswer}` : '';
	const preflightContext = preflight
		? ` Explorer preflight summary: ${preflight.summary} Recommended next step: ${preflight.recommendedNextStep}`
		: '';

	return {
		route,
		intent: `${reworkPrefix}${message}`,
		rewrittenTask: `${message}${priorContext}${preflightContext}`,
		sources,
		constraints: [
			'Do not create persistent artifacts unless the requested action is explicit and the matching tool policy enables it.',
			'Return enough evidence for orchestrator review.',
		],
		acceptanceCriteria: [
			'Station result directly addresses the user request.',
			'Station result includes caveats, blockers, and artifacts needed for orchestrator review.',
		],
		allowedActions:
			route === 'analytics'
				? ['manifest lookup', 'BigQuery validation/query', 'Metabase research', 'Metabase creation only if explicitly requested and enabled']
				: route === 'knowledge'
					? ['KB lookup', 'Slack search when relevant', 'Drive search/read when relevant', 'Jira history query when relevant']
					: ['bounded research', 'prepare workflow/documentation plan', 'mutating actions only when explicitly requested and enabled'],
		requestedOutput:
			route === 'analytics'
				? 'A concise analytics answer with caveats and artifacts when applicable.'
				: route === 'knowledge'
					? 'A concise answer grounded in the knowledge evidence.'
					: 'A concise station report with completed actions, blockers, and next steps.',
	};
}

async function draftKitchenOrder(input: {
	waiterSession: FlueSession;
	message: string;
	rework?: boolean;
	priorAnswer?: string;
	turn: TurnContext;
	explorerData: v.InferOutput<typeof ExplorerPreflightSchema>;
	sourceCatalog: string;
}): Promise<{ order: KitchenOrder; usage?: unknown }> {
	try {
		const result = await input.waiterSession.prompt(
			[
				'Mode: draft_work_order.',
				'Create a domain work order, not a final answer.',
				'Use the explorer preflight as supporting context. Do not answer the user directly from this step.',
				'Choose route:',
				'- analytics: metrics, SQL, dbt, BigQuery, dashboards, distributions.',
				'- knowledge: product/internal explanation from KB, Slack, Drive, Jira history, or repo context.',
				'- workflow: specialized execution such as event creation, ticket/PR automation, or cross-system action.',
				'- documentation: writing/updating project or user context.',
				'If the user request is too ambiguous, set clarifyingQuestion.',
				'For rework, explicitly address why the prior answer may have failed.',
				'For side_question, produce a bounded branch work order that does not rely on station memory from the current mainline unless the user explicitly asks for it.',
				'For topic_switch, treat the request as a fresh stream under the same user conversation.',
				`Turn context:\n${JSON.stringify(input.turn, null, 2)}`,
				`Rework: ${input.rework ? 'yes' : 'no'}`,
				input.priorAnswer ? `Prior rejected answer:\n${input.priorAnswer}` : '',
				input.sourceCatalog ? `Source catalog:\n${input.sourceCatalog}` : '',
				`Explorer preflight:\n${JSON.stringify(input.explorerData, null, 2)}`,
				`User request:\n${input.message}`,
			].filter(Boolean).join('\n\n'),
			{ result: KitchenOrderSchema },
		);
		return { order: result.data, usage: result.usage };
	} catch {
		return {
			order: createKitchenOrder(input.message, input.rework, input.priorAnswer, input.explorerData),
		};
	}
}

async function runKitchenStation(input: {
	init: FlueContext['init'];
	policy: ReturnType<typeof createToolPolicy>;
	kitchenModel: string;
	sessionPlan: SessionPlan;
	turn: TurnContext;
	order: KitchenOrder;
	explorerData: v.InferOutput<typeof ExplorerPreflightSchema>;
}): Promise<{ data: KitchenResult; usage?: unknown; session: FlueSession }> {
	if (!input.sessionPlan.stationSessionName) {
		throw new Error('Station session name is required after routing.');
	}

	if (input.order.route === 'analytics') {
		const kitchenHarness = await input.init({
			name: 'kitchen-analytics',
			sandbox: localWithoutBuiltinTools(),
			model: input.kitchenModel,
			role: 'analytics',
			tools: stationToolsForRoute('analytics', input.policy),
		});
		const kitchenSession = await kitchenHarness.session(input.sessionPlan.stationSessionName);
		const result = await kitchenSession.prompt(buildAnalyticsKitchenPrompt(input.order, input.explorerData, input.turn, input.sessionPlan), {
			result: KitchenResultSchema,
		});
		return { data: result.data, usage: result.usage, session: kitchenSession };
	}

	if (input.order.route === 'knowledge') {
		const kitchenHarness = await input.init({
			name: 'kitchen-knowledge',
			sandbox: localWithoutBuiltinTools(),
			model: input.kitchenModel,
			role: 'knowledge',
			tools: stationToolsForRoute('knowledge', input.policy),
		});
		const kitchenSession = await kitchenHarness.session(input.sessionPlan.stationSessionName);
		const result = await kitchenSession.prompt(buildKnowledgeKitchenPrompt(input.order, input.explorerData, input.turn, input.sessionPlan), {
			result: KitchenResultSchema,
		});
		return { data: result.data, usage: result.usage, session: kitchenSession };
	}

	const kitchenHarness = await input.init({
		name: `kitchen-${input.order.route}`,
		sandbox: localWithoutBuiltinTools(),
		model: input.kitchenModel,
		role: input.order.route,
		tools: stationToolsForRoute(input.order.route, input.policy),
	});
	const kitchenSession = await kitchenHarness.session(input.sessionPlan.stationSessionName);
	const result = await kitchenSession.prompt(
		[
			`Mode: ${input.order.route}_station.`,
			'Return a schema-valid station result for orchestrator review.',
			`Turn context:\n${JSON.stringify(input.turn, null, 2)}`,
			`Session plan:\n${JSON.stringify(input.sessionPlan, null, 2)}`,
			`Kitchen order:\n${JSON.stringify(input.order, null, 2)}`,
			`Explorer preflight:\n${JSON.stringify(input.explorerData, null, 2)}`,
		].join('\n\n'),
		{ result: KitchenResultSchema },
	);
	return { data: result.data, usage: result.usage, session: kitchenSession };
}

async function reviewKitchenDelivery(input: {
	waiterSession: FlueSession;
	message: string;
	turn: TurnContext;
	sessionPlan: SessionPlan;
	order: KitchenOrder;
	explorerData: v.InferOutput<typeof ExplorerPreflightSchema>;
	kitchenResult: KitchenResult;
	attempt: number;
}): Promise<{ review: PostflightReview; usage?: unknown }> {
	try {
		const result = await input.waiterSession.prompt(
			[
				'Mode: postflight_gate.',
				'Review the station delivery before any user-facing final response.',
				'Return accept only when final response editing can handle remaining issues.',
				'Return revise when the station should correct incomplete work, weak evidence, wrong source choice, missing artifacts, or unsupported claims.',
				'Return clarify when the user must answer a question before further station work can be useful.',
				'Return block when policy, access, or tool failure prevents completion.',
				'Do not answer the user from this step.',
				'The loop is bounded: attempt 1 may send work back; attempt 2 should usually accept, clarify, or block.',
				`Postflight attempt: ${input.attempt}`,
				`Original user request:\n${input.message}`,
				`Turn context:\n${JSON.stringify(input.turn, null, 2)}`,
				`Session plan:\n${JSON.stringify(input.sessionPlan, null, 2)}`,
				`Work order:\n${JSON.stringify(input.order, null, 2)}`,
				`Explorer preflight:\n${JSON.stringify(input.explorerData, null, 2)}`,
				`Station result:\n${JSON.stringify(input.kitchenResult, null, 2)}`,
			].join('\n\n'),
			{ result: PostflightReviewSchema },
		);
		return { review: result.data, usage: result.usage };
	} catch {
		return { review: fallbackPostflightReview(input.kitchenResult, input.attempt) };
	}
}

function fallbackPostflightReview(kitchenResult: KitchenResult, attempt: number): PostflightReview {
	if (attempt === 1 && (kitchenResult.needsReview || kitchenResult.confidence === 'low')) {
		return {
			verdict: 'revise',
			rationale: 'Fallback postflight: station marked the result as requiring review or low confidence.',
			issues: ['Station result was low-confidence or explicitly requested review.'],
			feedbackToStation:
				'Rework the result. Strengthen evidence, state blockers clearly, and return a complete schema-valid answer with caveats.',
		};
	}
	return {
		verdict: 'accept',
		rationale: 'Fallback postflight: no blocking structured issue detected.',
		issues: [],
	};
}

async function reviseKitchenStation(input: {
	session: FlueSession;
	turn: TurnContext;
	sessionPlan: SessionPlan;
	order: KitchenOrder;
	explorerData: v.InferOutput<typeof ExplorerPreflightSchema>;
	previousResult: KitchenResult;
	review: PostflightReview;
}): Promise<{ data: KitchenResult; usage?: unknown; session: FlueSession }> {
	const result = await input.session.prompt(
		[
			'Mode: station_revision.',
			'The orchestrator rejected or questioned the previous delivery. Correct the work; do not defend the prior answer.',
			'Use tools again when needed. Do not rerun expensive steps blindly if prior evidence is still valid.',
			'Return a schema-valid station result for a second postflight gate.',
			`Turn context:\n${JSON.stringify(input.turn, null, 2)}`,
			`Session plan:\n${JSON.stringify(input.sessionPlan, null, 2)}`,
			`Original work order:\n${JSON.stringify(input.order, null, 2)}`,
			`Explorer preflight:\n${JSON.stringify(input.explorerData, null, 2)}`,
			`Previous station result:\n${JSON.stringify(input.previousResult, null, 2)}`,
			`Postflight review:\n${JSON.stringify(input.review, null, 2)}`,
		].join('\n\n'),
		{ result: KitchenResultSchema },
	);
	return { data: result.data, usage: result.usage, session: input.session };
}

function buildAnalyticsKitchenPrompt(
	order: KitchenOrder,
	explorerData: v.InferOutput<typeof ExplorerPreflightSchema>,
	turn: TurnContext,
	sessionPlan: SessionPlan,
): string {
	return [
		'Mode: analytics_station.',
		'Follow the work order exactly and return a schema-valid station result for orchestrator review.',
		'Use explorer preflight as planning evidence, not as ground truth.',
		`Turn context:\n${JSON.stringify(turn, null, 2)}`,
		`Session plan:\n${JSON.stringify(sessionPlan, null, 2)}`,
		`Kitchen order:\n${JSON.stringify(order, null, 2)}`,
		`Explorer preflight:\n${JSON.stringify(explorerData, null, 2)}`,
	].join('\n\n');
}

function buildKnowledgeKitchenPrompt(
	order: KitchenOrder,
	explorerData: v.InferOutput<typeof ExplorerPreflightSchema>,
	turn: TurnContext,
	sessionPlan: SessionPlan,
): string {
	return [
		'Mode: knowledge_station.',
		'Follow the work order exactly and return a schema-valid station result for orchestrator review.',
		`Turn context:\n${JSON.stringify(turn, null, 2)}`,
		`Session plan:\n${JSON.stringify(sessionPlan, null, 2)}`,
		`Kitchen order:\n${JSON.stringify(order, null, 2)}`,
		`Explorer preflight:\n${JSON.stringify(explorerData, null, 2)}`,
	].join('\n\n');
}

function stationToolsForRoute(
	route: v.InferOutput<typeof RouteSchema>,
	policy: ReturnType<typeof createToolPolicy>,
) {
	if (route === 'analytics') {
		return dedupeToolsByName([...analyticsToolset(policy), ...explorerToolset(policy)]);
	}
	if (route === 'documentation') {
		return dedupeToolsByName([
			...explorerToolset(policy),
			...createContextPersistenceTools(policy),
			...createArtifactPersistenceTools(policy),
		]);
	}
	if (route === 'workflow') {
		return dedupeToolsByName([
			...explorerToolset(policy),
			...createWorkflowPersistenceTools(policy),
			...createArtifactPersistenceTools(policy),
		]);
	}
	return dedupeToolsByName([...explorerToolset(policy), ...createArtifactPersistenceTools(policy)]);
}

function dedupeToolsByName<T extends { name: string }>(tools: T[]): T[] {
	const seen = new Set<string>();
	const result: T[] = [];
	for (const tool of tools) {
		if (seen.has(tool.name)) continue;
		seen.add(tool.name);
		result.push(tool);
	}
	return result;
}

async function runExplorerPreflight(input: {
	init: FlueContext['init'];
	policy: ReturnType<typeof createToolPolicy>;
	sessionName: string;
	message: string;
	turn: TurnContext;
	sessionPlan: SessionPlan;
	sourceCatalog: string;
	selectedKbArticles: Array<{ path: string; title: string; description: string }>;
}) {
	const explorerHarness = await input.init({
		name: 'explorer-tasker',
		sandbox: localWithoutBuiltinTools({ disableTaskTool: true }),
		model: process.env.EXPLORER_MODEL || 'openai/gpt-4.1-mini',
		role: 'explorer',
		tools: explorerToolset(input.policy),
	});
	const explorerSession = await explorerHarness.session(input.sessionName);
	return explorerSession.prompt(
		[
			'Mode: preflight.',
			'Every waiter-mediated request starts with this preflight. Gather enough context for the orchestrator to create a domain work order.',
			'Identify likely intent, recommended route, source domains, candidate sources/models, uncertainty, and the next station step.',
			'This is a detached per-run research session. Do not assume continuity from prior explorer runs.',
			'For side_question, gather only the evidence needed for the branch question without polluting the mainline station context.',
			'For topic_switch, treat this as a fresh topic stream under the same user conversation.',
			'Return status "ready_for_analytics" only when analytics kitchen can proceed with a concrete plan and known caveats.',
			'Return "needs_more_exploration" when candidate model choice is uncertain after bounded exploration.',
			'If the remaining work is SQL validation or model comparison that analytics station can perform, return ready_for_analytics with those gaps rather than stopping preflight.',
			'Set recommendedRoute to analytics for quantitative data questions, metrics, distributions, SQL, dashboards, or BigQuery work.',
			'Set recommendedRoute to knowledge for product/internal explanations that do not require data execution.',
			`Turn context:\n${JSON.stringify(input.turn, null, 2)}`,
			`Session plan:\n${JSON.stringify(input.sessionPlan, null, 2)}`,
			input.sourceCatalog ? `Source catalog:\n${input.sourceCatalog}` : '',
			input.selectedKbArticles.length > 0
				? `Potential KB articles:\n${input.selectedKbArticles
						.map((article) => `- ${article.path}: ${article.description}`)
						.join('\n')}`
				: '',
			`User request:\n${input.message}`,
		].filter(Boolean).join('\n\n'),
		{ result: ExplorerPreflightSchema },
	);
}

function applyPreflightQualityGate(
	preflight: v.InferOutput<typeof ExplorerPreflightSchema>,
): v.InferOutput<typeof ExplorerPreflightSchema> {
	if (preflight.status !== 'ready_for_analytics') return preflight;
	const hasCandidate = preflight.candidateModels.length > 0;
	const candidatesHaveEvidence = hasCandidate && preflight.candidateModels.some((model) => model.evidence.length > 0);
	if (preflight.recommendedRoute === 'analytics' && preflight.confidence !== 'low' && hasCandidate && candidatesHaveEvidence) {
		return preflight;
	}
	if (preflight.recommendedRoute !== 'analytics' && preflight.confidence !== 'low') return preflight;

	return {
		...preflight,
		status: 'needs_more_exploration',
		confidence: preflight.confidence === 'high' ? 'medium' : preflight.confidence,
		summary: [
			preflight.summary,
			'Quality gate applied: preflight is not ready because candidate evidence is incomplete or unresolved gaps remain.',
		].join(' '),
		recommendedNextStep:
			!candidatesHaveEvidence
				? 'Continue source research and compare alternatives before kitchen execution.'
				: preflight.recommendedNextStep,
		gaps: [
			...preflight.gaps,
			'Need stronger source-of-truth evidence before dispatching analytics kitchen.',
		],
	};
}

function shouldDispatchForStationValidation(
	preflight: v.InferOutput<typeof ExplorerPreflightSchema>,
	order: KitchenOrder,
): boolean {
	if (preflight.recommendedRoute !== 'analytics' || order.route !== 'analytics') return false;
	if (preflight.confidence === 'low' || preflight.candidateModels.length === 0) return false;
	const hasEvidence = preflight.candidateModels.some((model) => model.evidence.length > 0);
	if (!hasEvidence) return false;
	const nextStep = `${preflight.recommendedNextStep} ${order.rewrittenTask}`.toLowerCase();
	return /\b(sql|bigquery|query|validation|validate|join|compare|count|distinct|schema)\b/.test(nextStep);
}

function selectSources(lowerMessage: string, route: v.InferOutput<typeof RouteSchema>): Array<v.InferOutput<typeof SourceSchema>> {
	const sources = new Set<v.InferOutput<typeof SourceSchema>>();
	if (route === 'analytics') {
		sources.add('manifest');
		sources.add('bigquery');
	}
	if (/(dashboard|card|metabase|chart|existing metric|prior metric)/.test(lowerMessage)) sources.add('metabase');
	if (/(dbt|manifest|model|column|table|warehouse|bigquery|sql|metric)/.test(lowerMessage)) {
		sources.add('manifest');
		sources.add('bigquery');
	}
	if (/(distribution|count|cases by|case creation|incident|firm|month|date|distinct|top values|date range)/.test(lowerMessage)) {
		sources.add('manifest');
		sources.add('bigquery');
	}
	if (/(what is|what are|how do i find|how does|explain|clp|flp|snapshot|product|workflow)/.test(lowerMessage)) {
		sources.add('kb');
	}
	if (/(slack|thread|decision|decide|decided|owner|owns|ownership|recent|discussion)/.test(lowerMessage)) {
		sources.add('slack');
	}
	if (/(drive|gdrive|prd|spec|launch plan|project plan)/.test(lowerMessage)) sources.add('drive');
	if (/(repo|code|implementation|implemented|event|api|service)/.test(lowerMessage)) sources.add('repo');
	if (/(jira|ticket|issue|pr|pull request|engineering history|what changed|shipped)/.test(lowerMessage)) sources.add('jira');
	if (sources.size === 0) sources.add('kb');
	return [...sources];
}

async function readOptionalSourceCatalog(): Promise<string> {
	try {
		return await readSourceCatalogText();
	} catch {
		return '';
	}
}

function isProductKnowledgeQuestion(message: string): boolean {
	const lower = message.toLowerCase();
	const productTerms = [
		'what is',
		'what are',
		'how do i find',
		'how does',
		'explain',
		'clp',
		'flp',
		'snapshot',
		'product',
		'workflow',
	];
	const analyticsTerms = ['query', 'sql', 'bigquery', 'metabase', 'dashboard', 'chart', 'count of', 'how many'];
	return productTerms.some((term) => lower.includes(term)) && !analyticsTerms.some((term) => lower.includes(term));
}
