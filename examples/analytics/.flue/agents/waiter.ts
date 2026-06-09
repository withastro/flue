import { type FlueContext, type FlueSession } from '@flue/runtime';
import { local } from '@flue/runtime/node';
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
import { selectKbArticles } from '../tools/kb.ts';
import { readSourceCatalogText } from '../tools/source-catalog.ts';
import { createWorkflowTemplateTools } from '../tools/workflow-templates.ts';
import { createProjectSkillTools } from '../tools/project-skills.ts';
import { createLocalWorkspaceTools } from '../tools/local.ts';
import { createJiraAutomationTools } from '../lib/tools.ts';
import {
	createWaiterExplorationRequest,
	ExplorationBriefSchema,
	formatExplorationRequest,
	type ExplorationRequest,
	type ExplorationSource,
} from '../lib/exploration.ts';
import { buildConversationLedger } from '../lib/conversation-ledger.ts';

export const triggers = { webhook: true };

const SourceSchema = v.picklist(['kb', 'manifest', 'bigquery', 'metabase', 'slack', 'drive', 'repo', 'jira', 'project_skill']);
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
	forcedSkillId: v.optional(v.string()),
	forcedRoute: v.optional(RouteSchema),
	rework: v.optional(v.boolean(), false),
	priorAnswer: v.optional(v.string()),
	priorWorkSummary: v.optional(v.string()),
	testFollowupQuestion: v.optional(v.string()),
	testScenario: v.optional(v.picklist([
		'pass_through',
		'preflight_blocker',
		'postflight_followup',
		'revise_then_block',
	])),
});

type WaiterPayload = v.InferOutput<typeof PayloadSchema>;
type Route = v.InferOutput<typeof RouteSchema>;

const KitchenOrderSchema = v.object({
	route: RouteSchema,
	skillId: v.optional(v.string()),
	intent: v.string(),
	rewrittenTask: v.string(),
	sources: v.array(SourceSchema),
	constraints: v.array(v.string()),
	acceptanceCriteria: v.array(v.string()),
	allowedActions: v.array(v.string()),
	requestedOutput: v.string(),
	clarifyingQuestion: v.optional(v.string()),
	blockerMessage: v.optional(v.string()),
	priorWorkSummary: v.optional(v.string()),
});

type KitchenOrder = v.InferOutput<typeof KitchenOrderSchema>;

const WaiterDecisionSchema = v.object({
	action: v.picklist(['continue_station', 'run_preflight', 'ask_user', 'reject']),
	route: v.optional(RouteSchema),
	rationale: v.string(),
	resolvedTask: v.optional(v.string()),
	priorWorkSummary: v.optional(v.string()),
	stationInstruction: v.optional(v.string()),
	explorationBrief: v.optional(ExplorationBriefSchema),
	clarifyingQuestion: v.optional(v.string()),
	userMessage: v.optional(v.string()),
});

type WaiterDecision = v.InferOutput<typeof WaiterDecisionSchema>;

const ExplorerFindingSchema = v.object({
	source: SourceSchema,
	title: v.string(),
	reference: v.string(),
	evidence: v.array(v.string()),
});

const ExplorerPreflightSchema = v.object({
	summary: v.string(),
	searchedSources: v.optional(v.array(SourceSchema), []),
	queryVariantsTried: v.optional(v.array(v.string()), []),
	findings: v.optional(v.array(ExplorerFindingSchema), []),
	candidateModels: v.optional(v.array(
		v.object({
			name: v.string(),
			relationName: v.optional(v.string()),
			evidence: v.array(v.string()),
			concerns: v.array(v.string()),
		}),
	), []),
	gaps: v.array(v.string()),
});

type ExplorerPreflight = v.InferOutput<typeof ExplorerPreflightSchema>;

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

type UserReplyType = 'final' | 'followup_question';

const PostflightReviewSchema = v.object({
	verdict: v.picklist(['accept', 'revise', 'ask_user', 'block']),
	rationale: v.string(),
	issues: v.array(v.string()),
	feedbackToStation: v.optional(v.string()),
	userMessage: v.optional(v.string()),
});

type PostflightReview = v.InferOutput<typeof PostflightReviewSchema>;

const FinalResponseSchema = v.object({
	finalResponse: v.string(),
	needsUserClarification: v.boolean(),
	clarifyingQuestion: v.optional(v.string()),
});

export default async function ({ init, payload, id, runId }: FlueContext) {
	const parsed = v.parse(PayloadSchema, payload);
	const turn = resolveTurnContext({
		turnType: parsed.turnType,
		rework: parsed.rework,
	});
	const waiterModel = resolveWaiterModel(parsed.waiterModel, turn.isRework);
	const kitchenModel = parsed.kitchenModel || process.env.ANALYTICS_MODEL || 'openai/gpt-5.4';
	if (parsed.testScenario !== undefined) {
		if (process.env.ANALYTICS_ENABLE_TEST_HOOKS !== '1') {
			throw new Error('testScenario requires ANALYTICS_ENABLE_TEST_HOOKS=1.');
		}
		return withConversationLedger(buildForcedTestScenario({
			scenario: parsed.testScenario,
			message: parsed.message,
			sessionName: parsed.sessionName,
			streamName: parsed.streamName,
			branchName: parsed.branchName,
			activeRoute: parsed.activeRoute,
			runId,
			turn,
			waiterModel,
			kitchenModel,
		}), { rawUserMessage: parsed.message, resolvedTask: parsed.message, runId });
	}
	if (parsed.testFollowupQuestion !== undefined) {
		if (process.env.ANALYTICS_ENABLE_TEST_HOOKS !== '1') {
			throw new Error('testFollowupQuestion requires ANALYTICS_ENABLE_TEST_HOOKS=1.');
		}
		return withConversationLedger({
			reply: userVisibleOrFallback(
				parsed.testFollowupQuestion,
				'I need one clarification before I can continue.',
			),
			replyType: 'followup_question' satisfies UserReplyType,
			waiterModel,
			kitchenModel,
			turn,
			decision: {
				action: 'ask_user' as const,
				rationale: 'Deterministic test hook forced a user-facing follow-up question.',
				clarifyingQuestion: parsed.testFollowupQuestion,
			},
			sessionPlan: createSessionPlan({
				sessionName: parsed.sessionName,
				streamName: parsed.streamName,
				branchName: parsed.branchName,
				turnType: turn.type,
				runId,
			}),
			usage: { waiter: { testHook: true } },
		}, { rawUserMessage: parsed.message, resolvedTask: parsed.message, runId });
	}
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
		sandbox: localWithoutBuiltinTools({ disableTaskTool: true }),
		model: waiterModel,
		role: 'waiter',
		tools: [
			...createContextPersistenceTools(policy),
			...createArtifactPersistenceTools(policy),
			...createTracePersistenceTools(),
		],
	});
	const waiterSession = await waiterHarness.session(preflightSessionPlan.waiterSessionName);

	const decisionResult = parsed.forcedSkillId
		? undefined
		: await decideWaiterAction({
				waiterSession,
				message: parsed.message,
				turn,
				activeRoute: parsed.activeRoute,
				streamName: preflightSessionPlan.streamName,
				stationSessionName: parsed.stationSessionName,
				priorAnswer: parsed.priorAnswer,
				priorWorkSummary: parsed.priorWorkSummary,
			});
	const decision: WaiterDecision = parsed.forcedSkillId
		? {
				action: 'run_preflight' as const,
				route: parsed.forcedRoute || 'workflow',
				rationale: `Deterministic project skill command: /${parsed.forcedSkillId}.`,
			}
		: decisionResult!.decision;
	const resolvedTask = resolveTaskForHandoff(parsed.message, decision);
	const priorWorkSummary = resolvePriorWorkSummary({
		payloadPriorWorkSummary: parsed.priorWorkSummary,
		priorAnswer: parsed.priorAnswer,
		decision,
	});
	const activeRoute = parsed.activeRoute;
	const canContinueStation = !parsed.forcedSkillId && decision.action === 'continue_station' && activeRoute !== undefined && turn.type === 'mainline';
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
			resolvedTask,
			priorWorkSummary,
			decision,
			maxGb: parsed.maxGb,
			allowMetabaseCreate: parsed.allowMetabaseCreate,
		});
		const activeSessionPlan = { ...sessionPlan, stationSessionName };
		const order = createContinuationOrder(resolvedTask, activeRoute, decision, priorWorkSummary);
		const explorerData = createContinuationExplorer(activeRoute, decision);
		const postflightReviews: Array<{ review: PostflightReview; usage?: unknown }> = [];
		const postflightResult = await reviewKitchenDelivery({
			waiterSession,
			message: resolvedTask,
			turn,
			sessionPlan: activeSessionPlan,
			order,
			explorerData,
			kitchenResult: stationResult.data,
			attempt: 1,
		});
		postflightReviews.push(postflightResult);
		let finalStationResult = stationResult;
		if (postflightResult.review.verdict === 'revise' && postflightResult.review.feedbackToStation) {
			finalStationResult = await reviseKitchenStation({
				session: stationResult.session,
				turn,
				sessionPlan: activeSessionPlan,
				order,
				explorerData,
				previousResult: stationResult.data,
				review: postflightResult.review,
			});
			const secondPostflight = await reviewKitchenDelivery({
				waiterSession,
				message: resolvedTask,
				turn,
				sessionPlan: activeSessionPlan,
				order,
				explorerData,
				kitchenResult: finalStationResult.data,
				attempt: 2,
			});
			postflightReviews.push(secondPostflight);
		}
		const finalPostflight = postflightReviews[postflightReviews.length - 1]!.review;
		return withConversationLedger({
			...buildPostflightUserReply(finalPostflight, finalStationResult.data),
			waiterModel,
			kitchenModel,
			turn,
			decision,
			sessionPlan: activeSessionPlan,
			order,
			kitchen: finalStationResult.data,
			postflight: postflightReviews.map((entry) => entry.review),
			usage: {
				waiter: {
					decision: decisionResult?.usage,
					postflight: postflightReviews.map((entry) => entry.usage),
				},
				station: stationResult.usage,
				...(finalStationResult !== stationResult ? { stationRevision: finalStationResult.usage } : {}),
			},
		}, { rawUserMessage: parsed.message, resolvedTask, runId });
	}

	if (decision.action === 'ask_user' && decision.clarifyingQuestion) {
		return withConversationLedger({
			reply: decision.clarifyingQuestion,
			replyType: 'followup_question' satisfies UserReplyType,
			waiterModel,
			kitchenModel,
			turn,
			decision,
			sessionPlan: preflightSessionPlan,
			usage: { waiter: { decision: decisionResult?.usage } },
		}, { rawUserMessage: parsed.message, resolvedTask, runId });
	}
	if (decision.action === 'reject') {
		return withConversationLedger({
			reply: userVisibleOrFallback(
				decision.userMessage,
				'I cannot help with that request because it does not fit the available analytics, knowledge, workflow, or documentation capabilities.',
			),
			replyType: 'final' satisfies UserReplyType,
			waiterModel,
			kitchenModel,
			turn,
			decision,
			sessionPlan: preflightSessionPlan,
			usage: { waiter: { decision: decisionResult?.usage } },
		}, { rawUserMessage: parsed.message, resolvedTask, runId });
	}

	const sourceCatalog = await readOptionalSourceCatalog();
	const selectedKbArticles = await selectKbArticles(resolvedTask, { limit: 2 });
	const explorationRequest = createWaiterExplorationRequest({
		message: parsed.message,
		resolvedTask,
		route: parsed.forcedRoute,
		turn,
		forcedSkillId: parsed.forcedSkillId,
		selectedKbArticles,
		brief: decision.explorationBrief,
	});
	const explorerResult = await runExplorerPreflight({
		init,
		policy,
		sessionName: preflightSessionPlan.preflightSessionName,
		message: resolvedTask,
		turn,
		sessionPlan: preflightSessionPlan,
		explorationRequest,
		sourceCatalog,
		selectedKbArticles,
		forcedSkillId: parsed.forcedSkillId,
		forcedRoute: parsed.forcedRoute,
		priorAnswer: parsed.priorAnswer,
		priorWorkSummary,
	});
	const explorerData = applyPreflightQualityGate(explorerResult.data);
	const orderResult = await draftKitchenOrder({
		waiterSession,
		message: resolvedTask,
		rework: turn.isRework,
		priorAnswer: parsed.priorAnswer,
		priorWorkSummary,
		turn,
		explorerData,
		sourceCatalog,
		forcedSkillId: parsed.forcedSkillId,
		forcedRoute: parsed.forcedRoute,
	});
	const order = withPriorWorkSummary(orderResult.order, priorWorkSummary);
	const sessionPlan = createSessionPlan({
		sessionName: parsed.sessionName,
		streamName: preflightSessionPlan.streamName,
		branchName: parsed.branchName,
		turnType: turn.type,
		runId,
		route: order.route,
	});
	if (order.clarifyingQuestion) {
		return withConversationLedger({
			reply: buildPreStationFollowup(explorerData, order),
			replyType: 'followup_question' satisfies UserReplyType,
			waiterModel,
			kitchenModel,
			turn,
			decision,
			sessionPlan,
			order,
			explorationRequest,
			explorer: explorerData,
			usage: { waiter: { decision: decisionResult?.usage, order: orderResult.usage }, explorer: explorerResult.usage },
		}, { rawUserMessage: parsed.message, resolvedTask, runId });
	}

	if (shouldReturnBeforeStation(explorerData, order)) {
		return withConversationLedger({
			reply: buildPreStationFollowup(explorerData, order),
			replyType: replyTypeForPreStation(explorerData, order),
			waiterModel,
			kitchenModel,
			turn,
			decision,
			sessionPlan,
			order,
			explorationRequest,
			explorer: explorerData,
			usage: { waiter: { decision: decisionResult?.usage, order: orderResult.usage }, explorer: explorerResult.usage },
		}, { rawUserMessage: parsed.message, resolvedTask, runId });
	}

	if (shouldUseShallowWorkflowEval(parsed, order)) {
		const { kitchen, review } = buildShallowWorkflowEvaluation(order);
		return withConversationLedger({
			...buildPostflightUserReply(review, kitchen),
			waiterModel,
			kitchenModel,
			turn,
			decision,
			sessionPlan,
			order,
			explorationRequest,
			explorer: explorerData,
			kitchen,
			postflight: [review],
			usage: {
				waiter: { decision: decisionResult?.usage, order: orderResult.usage, deterministicPostflight: true },
				explorer: explorerResult.usage,
			},
		}, { rawUserMessage: parsed.message, resolvedTask, runId });
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
		const stationLabel = `${order.route} station`;
		const blockerResult = await waiterSession.prompt(
			[
				'Mode: station_failure_response.',
				`The ${stationLabel} failed before returning a schema result.`,
				`Write a concise user-facing blocker response. Include what the explorer found, what the ${stationLabel} attempted, and what must be fixed next.`,
				'Do not pretend the analysis was completed.',
				`Original user request:\n${resolvedTask}`,
				resolvedTask === parsed.message ? '' : `Latest user message:\n${parsed.message}`,
				`Turn context:\n${JSON.stringify(turn, null, 2)}`,
				`Session plan:\n${JSON.stringify(sessionPlan, null, 2)}`,
				`Work order:\n${JSON.stringify(order, null, 2)}`,
				`Explorer summary:\n${formatExplorerPreflightForWaiter(explorerData)}`,
				`Station error:\n${error instanceof Error ? error.message : String(error)}`,
			].join('\n\n'),
			{ result: FinalResponseSchema },
		);
		return withConversationLedger({
			reply: userVisibleOrFallback(
				blockerResult.data.finalResponse,
				'I could not complete this yet. The run failed before the domain work returned a structured result.',
			),
			replyType: 'final' satisfies UserReplyType,
			waiterModel,
			kitchenModel,
			turn,
			decision,
			sessionPlan,
			order,
			explorationRequest,
			explorer: explorerData,
			kitchenError: error instanceof Error ? error.message : String(error),
			usage: {
				waiter: { decision: decisionResult?.usage, order: orderResult.usage, final: blockerResult.usage },
				explorer: explorerResult.usage,
			},
		}, { rawUserMessage: parsed.message, resolvedTask, runId });
	}

	const postflightReviews: Array<{ review: PostflightReview; usage?: unknown }> = [];
	const postflightResult = await reviewKitchenDelivery({
		waiterSession,
		message: resolvedTask,
		turn,
		sessionPlan,
		order,
		explorerData,
		kitchenResult: kitchenResult.data,
		attempt: 1,
	});
	postflightReviews.push(postflightResult);

	let finalKitchenResult = kitchenResult;
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
			message: resolvedTask,
			turn,
			sessionPlan,
			order,
			explorerData,
			kitchenResult: finalKitchenResult.data,
			attempt: 2,
		});
		postflightReviews.push(secondPostflight);
	}

	const finalPostflight = postflightReviews[postflightReviews.length - 1]!.review;
	return withConversationLedger({
		...buildPostflightUserReply(finalPostflight, finalKitchenResult.data),
		waiterModel,
		kitchenModel,
		turn,
		decision,
		sessionPlan,
		order,
		explorationRequest,
		explorer: explorerData,
		kitchen: finalKitchenResult.data,
		postflight: postflightReviews.map((entry) => entry.review),
		usage: {
			waiter: {
				decision: decisionResult?.usage,
				order: orderResult.usage,
				postflight: postflightReviews.map((entry) => entry.usage),
			},
			explorer: explorerResult.usage,
			kitchen: kitchenResult.usage,
			...(finalKitchenResult !== kitchenResult ? { kitchenRevision: finalKitchenResult.usage } : {}),
		},
	}, { rawUserMessage: parsed.message, resolvedTask, runId });
}

function withConversationLedger<T extends {
	reply: string;
	replyType: UserReplyType;
	turn: TurnContext;
	sessionPlan?: SessionPlan;
	decision?: unknown;
	explorationRequest?: ExplorationRequest;
	explorer?: unknown;
	order?: unknown;
	kitchen?: unknown;
	postflight?: unknown;
	usage?: unknown;
}>(response: T, input: {
	rawUserMessage: string;
	resolvedTask?: string;
	runId?: string;
}): T & { ledger: ReturnType<typeof buildConversationLedger> } {
	return {
		...response,
		ledger: buildConversationLedger({
			rawUserMessage: input.rawUserMessage,
			resolvedTask: input.resolvedTask,
			runId: input.runId,
			turn: response.turn,
			sessionPlan: response.sessionPlan,
			decision: response.decision,
			explorationRequest: response.explorationRequest,
			explorer: response.explorer,
			order: response.order,
			kitchen: response.kitchen,
			postflight: response.postflight,
			reply: response.reply,
			replyType: response.replyType,
			usage: response.usage,
		}),
	};
}

export function createKitchenOrder(
	message: string,
	rework = false,
	priorAnswer?: string,
	preflight?: ExplorerPreflight,
	forcedSkillId?: string,
	forcedRoute?: Route,
	priorWorkSummary?: string,
): KitchenOrder {
	return createKitchenOrderFromPreflight(message, rework, priorAnswer, preflight, forcedSkillId, forcedRoute, priorWorkSummary);
}

export function summarizeExplorerPreflightForWaiter(preflight: ExplorerPreflight) {
	const candidateLimit = 5;
	const detailLimit = 2;
	const findingLimit = 5;
	const searchedSources = preflight.searchedSources ?? [];
	const queryVariantsTried = preflight.queryVariantsTried ?? [];
	const findings = preflight.findings ?? [];
	return {
		summary: limitText(preflight.summary, 1200),
		searchedSources,
		queryVariantsTried: queryVariantsTried.slice(0, 8).map((query) => limitText(query, 180)),
		findings: findings.slice(0, findingLimit).map((finding) => ({
			source: finding.source,
			title: limitText(finding.title, 180),
			reference: limitText(finding.reference, 240),
			evidence: finding.evidence.slice(0, detailLimit).map((item) => limitText(item, 300)),
			omittedEvidenceCount: Math.max(0, finding.evidence.length - detailLimit),
		})),
		omittedFindingCount: Math.max(0, findings.length - findingLimit),
		gaps: preflight.gaps.slice(0, 6).map((gap) => limitText(gap, 300)),
		omittedGapCount: Math.max(0, preflight.gaps.length - 6),
		candidateModels: preflight.candidateModels.slice(0, candidateLimit).map((model) => ({
			name: model.name,
			relationName: model.relationName,
			evidence: model.evidence.slice(0, detailLimit).map((item) => limitText(item, 350)),
			concerns: model.concerns.slice(0, detailLimit).map((item) => limitText(item, 350)),
			omittedEvidenceCount: Math.max(0, model.evidence.length - detailLimit),
			omittedConcernCount: Math.max(0, model.concerns.length - detailLimit),
		})),
		omittedCandidateCount: Math.max(0, preflight.candidateModels.length - candidateLimit),
	};
}

function shouldUseShallowWorkflowEval(payload: WaiterPayload, order: KitchenOrder): boolean {
	return order.route === 'workflow' && Boolean(payload.forcedSkillId) && payload.allowWorkflowMutation !== true;
}

function buildShallowWorkflowEvaluation(order: KitchenOrder): { kitchen: KitchenResult; review: PostflightReview } {
	const skillName = order.skillId ? `/${order.skillId}` : 'the requested workflow';
	const answer = [
		`I did not execute ${skillName} because workflow mutation is disabled for this run.`,
		'The request is recognized as a workflow request. To run it, enable workflow mutation for the session; otherwise I can only review the requested scope and return a non-mutating plan or blocker.',
	].join(' ');
	const kitchen: KitchenResult = {
		answer,
		confidence: 'medium',
		artifacts: [],
		followupQuestions: [],
		kitchenSummary: 'Deterministic shallow workflow evaluation; no station execution or mutating action was run.',
		needsReview: false,
	};
	const review: PostflightReview = {
		verdict: 'block',
		rationale: 'Forced workflow command was recognized, but mutation is disabled and shallow evaluation prevents full workflow execution.',
		issues: ['Workflow mutation is disabled for this run.'],
		userMessage: answer,
	};
	return { kitchen, review };
}

function formatExplorerPreflightForWaiter(preflight: ExplorerPreflight): string {
	return JSON.stringify(summarizeExplorerPreflightForWaiter(preflight), null, 2);
}

function formatKitchenResultForWaiter(result: KitchenResult): string {
	return JSON.stringify({
		answer: limitText(result.answer, 4000),
		confidence: result.confidence,
		artifacts: result.artifacts,
		followupQuestions: result.followupQuestions,
		kitchenSummary: limitText(result.kitchenSummary, 1000),
		needsReview: result.needsReview,
	}, null, 2);
}

function limitText(value: string, maxLength: number): string {
	if (value.length <= maxLength) return value;
	return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function resolveWaiterModel(payloadModel: string | undefined, isRework: boolean): string {
	if (payloadModel) return payloadModel;
	if (isRework) {
		return process.env.REWORK_WAITER_MODEL ||
			process.env.WAITER_ESCALATION_MODEL ||
			process.env.WAITER_MODEL ||
			'anthropic/claude-sonnet-4-6';
	}
	return process.env.WAITER_MODEL || 'anthropic/claude-sonnet-4-6';
}

function buildForcedTestScenario(input: {
	scenario: 'pass_through' | 'preflight_blocker' | 'postflight_followup' | 'revise_then_block';
	message: string;
	sessionName?: string;
	streamName?: string;
	branchName?: string;
	activeRoute?: Route;
	runId: string;
	turn: TurnContext;
	waiterModel: string;
	kitchenModel: string;
}) {
	const route = input.activeRoute || 'analytics';
	const sessionPlan = createSessionPlan({
		sessionName: input.sessionName,
		streamName: input.streamName,
		branchName: input.branchName,
		turnType: input.turn.type,
		runId: input.runId,
		route,
	});
	const base = {
		waiterModel: input.waiterModel,
		kitchenModel: input.kitchenModel,
		turn: input.turn,
		sessionPlan,
		usage: { waiter: { testHook: true, scenario: input.scenario } },
	};

	if (input.scenario === 'pass_through') {
		const decision: WaiterDecision = {
			action: 'continue_station',
			route,
			rationale: 'Deterministic test hook forced pass-through continuation.',
			stationInstruction: 'This instruction must not replace the original user message.',
		};
		const order = createContinuationOrder(input.message, route, decision);
		const kitchen: KitchenResult = {
			answer: `Handled continuation: ${input.message}`,
			confidence: 'high',
			artifacts: [],
			followupQuestions: [],
			kitchenSummary: 'Forced pass-through continuation.',
			needsReview: false,
		};
		const review: PostflightReview = {
			verdict: 'accept',
			rationale: 'Forced pass-through result is accepted.',
			issues: [],
			userMessage: `Handled continuation: ${input.message}`,
		};
		return {
			...buildPostflightUserReply(review, kitchen),
			...base,
			decision,
			order,
			kitchen,
			postflight: [review],
		};
	}

	if (input.scenario === 'preflight_blocker') {
		const explorer: ExplorerPreflight = {
			summary: 'Required warehouse access is unavailable.',
			searchedSources: ['bigquery'],
			queryVariantsTried: ['original request'],
			findings: [],
			candidateModels: [],
			gaps: ['BigQuery job creation is not available for this test run.'],
		};
		const order = {
			...createKitchenOrder(input.message, false, undefined, explorer, undefined, route),
			blockerMessage: 'I cannot complete this yet because BigQuery job creation is not available for this test run.',
		};
		return {
			reply: buildPreStationFollowup(explorer, order),
			replyType: replyTypeForPreStation(explorer, order),
			...base,
			decision: {
				action: 'run_preflight' as const,
				route,
				rationale: 'Deterministic test hook forced a pre-station blocker.',
			},
			order,
			explorer,
		};
	}

	if (input.scenario === 'postflight_followup') {
		const kitchen: KitchenResult = {
			answer: 'Cannot choose the correct scope without one clarification.',
			confidence: 'medium',
			artifacts: [],
			followupQuestions: ['Which time window should I use?'],
			kitchenSummary: 'Station needs user scope clarification.',
			needsReview: true,
		};
		const review: PostflightReview = {
			verdict: 'ask_user',
			rationale: 'The station cannot proceed usefully without the missing scope.',
			issues: ['Missing time window.'],
			userMessage: 'Which time window should I use?',
		};
		return {
			...buildPostflightUserReply(review, kitchen),
			...base,
			decision: {
				action: 'run_preflight' as const,
				route,
				rationale: 'Deterministic test hook forced postflight follow-up.',
			},
			kitchen,
			postflight: [review],
		};
	}

	const kitchen: KitchenResult = {
		answer: 'Still blocked after revision: Jira mutation is not enabled.',
		confidence: 'low',
		artifacts: [],
		followupQuestions: [],
		kitchenSummary: 'Revision confirmed the same blocker.',
		needsReview: true,
	};
	const postflight: PostflightReview[] = [
		{
			verdict: 'revise',
			rationale: 'Initial station output lacked evidence.',
			issues: ['Missing verification.'],
			feedbackToStation: 'Verify the blocker and return a concrete completed/blocker answer.',
		},
		{
			verdict: 'block',
			rationale: 'The same blocker remains after revision.',
			issues: ['Jira mutation is not enabled.'],
			userMessage: 'I could not complete this because Jira mutation is not enabled for this run.',
		},
	];
	return {
		...buildPostflightUserReply(postflight[1]!, kitchen),
		...base,
		decision: {
			action: 'run_preflight' as const,
			route,
			rationale: 'Deterministic test hook forced revise-then-block.',
		},
		kitchen,
		postflight,
	};
}

function reworkPromptAddendum(priorAnswer?: string): string {
	return [
		'Rework addendum: the user rejected the prior result or sent it back to kitchen.',
		'Do a complete rethink of what the user is asking. Do not locally patch the previous answer.',
		'Reconsider intent, source selection, route, assumptions, missing validation, and whether the previous station solved the wrong problem.',
		'Use the prior answer only as evidence of what may have failed.',
		priorAnswer ? `Rejected prior answer:\n${priorAnswer}` : '',
	].filter(Boolean).join('\n');
}

async function decideWaiterAction(input: {
	waiterSession: FlueSession;
	message: string;
	turn: TurnContext;
	activeRoute?: Route;
	streamName: string;
	stationSessionName?: string;
	priorAnswer?: string;
	priorWorkSummary?: string;
}): Promise<{ decision: WaiterDecision; usage?: unknown }> {
	try {
		const result = await input.waiterSession.prompt(
			[
				'Mode: intake_decision.',
				'Every user-initiated message reaches this role first.',
				'This is preflight intake only. Do not judge station output and do not write the final answer.',
				'Resolve the latest user message against the current conversation context, then decide the next action. Do not answer the user from this step.',
				'Use resolvedTask for the complete task the next worker should receive when the latest message depends on prior context, answers a previous follow-up question, changes direction, or is too terse on its own.',
				'For a follow-up answer like "Ontario and California", resolvedTask must restate the full task implied by the prior waiter session context.',
				'For a natural continuation, resolvedTask may refine the task, but the station will also see the latest user message.',
				'If useful prior work exists, set priorWorkSummary to a compact factual summary of what was already attempted, found, created, or blocked. Keep it separate from resolvedTask.',
				'Choose continue_station only when all are true:',
				'- this is a mainline turn',
				'- an active station route exists',
				'- the message is a natural continuation that the active station can answer from its session and tools',
				'- no new source selection, preflight research, re-routing, user clarification, or postflight gate is needed',
				'Choose run_preflight for side questions, rework, topic switches, ambiguous source-of-truth questions, route changes, or anything requiring new research before a station should work.',
				'Choose ask_user only when the next useful step cannot be chosen without user input.',
				'Choose reject only when the request cannot be sent to any available station even after reasonable interpretation.',
				'The question is not whether one specific term looks unfamiliar. The question is whether you understand the request well enough to choose the next useful step.',
				'When action is run_preflight, also fill explorationBrief as a bounded retrieval brief for explorer.',
				'explorationBrief must include objective, searchMode, unresolvedTerms, allowedSources, entityHints, candidateKeywords, evidenceNeeded, and stopWhen.',
				'searchMode must be one of: definition_lookup, artifact_lookup, entity_lookup, source_of_truth_lookup, metric_mapping, workflow_lookup, documentation_lookup.',
				'Choose allowedSources because they are plausible places to resolve the actual uncertainty, not because nearby business words vaguely resemble a source.',
				'Explorer is not a decision-maker. It will search only within the brief you provide and report evidence, misses, and gaps.',
				'Available stations are analytics, knowledge, workflow, and documentation.',
				'Do not choose reject when a clarification could make the request routable; choose ask_user instead.',
				'For reject, write userMessage as a concise user-facing explanation of the available AGI scope.',
				input.turn.isRework ? reworkPromptAddendum(input.priorAnswer) : '',
				`Turn context:\n${JSON.stringify(input.turn, null, 2)}`,
				`Active route: ${input.activeRoute || 'none'}.`,
				`Active stream: ${input.streamName}.`,
				`Known station session: ${input.stationSessionName || 'derived from session plan when needed'}.`,
				input.priorWorkSummary ? `Prior work summary supplied by app:\n${input.priorWorkSummary}` : '',
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
	return {
		action: 'run_preflight',
		route: input.activeRoute,
		rationale: 'Fallback: intake decision failed, so run preflight instead of assuming station continuation.',
	};
}

async function runStationContinuation(input: {
	init: FlueContext['init'];
	policy: ReturnType<typeof createToolPolicy>;
	kitchenModel: string;
	route: Route;
	sessionName: string;
	message: string;
	resolvedTask: string;
	priorWorkSummary?: string;
	decision: WaiterDecision;
	maxGb: number;
	allowMetabaseCreate: boolean;
}): Promise<{ data: KitchenResult; usage?: unknown; session: FlueSession }> {
	const harness = await input.init({
		name: `station-${input.route}`,
		sandbox: stationSandboxForRoute(input.route),
		model: input.kitchenModel,
		role: input.route,
		tools: stationToolsForRoute(input.route, input.policy),
	});
	const session = await harness.session(input.sessionName);
	const result = await session.prompt(
		[
			'Mode: station_continuation.',
			'Continue the active user thread without broad re-triage.',
			'Return a schema-valid station result for postflight review. This is not the user-facing message.',
			'Use this station session history for continuity.',
			'Use tools only when needed for an accurate answer.',
			`Active route: ${input.route}.`,
			`Default BigQuery dry-run limit: ${input.maxGb} GB.`,
			`Metabase creation enabled: ${input.allowMetabaseCreate ? 'yes' : 'no'}.`,
			`Waiter pass-through rationale:\n${input.decision.rationale}`,
			input.priorWorkSummary ? `Prior work context:\n${input.priorWorkSummary}` : '',
			input.resolvedTask === input.message ? '' : `Resolved task:\n${input.resolvedTask}`,
			`Latest user message:\n${input.message}`,
		].filter(Boolean).join('\n\n'),
		{ result: KitchenResultSchema },
	);
	return { data: result.data, usage: result.usage, session };
}

function resolveTaskForHandoff(message: string, decision: WaiterDecision): string {
	const resolved = decision.resolvedTask?.trim();
	return resolved || message;
}

function resolvePriorWorkSummary(input: {
	payloadPriorWorkSummary?: string;
	priorAnswer?: string;
	decision: WaiterDecision;
}): string | undefined {
	const parts = [
		input.payloadPriorWorkSummary?.trim(),
		input.decision.priorWorkSummary?.trim(),
		input.priorAnswer?.trim() ? `Prior rejected answer: ${input.priorAnswer.trim()}` : undefined,
	].filter((part): part is string => Boolean(part));
	return parts.length > 0 ? parts.join('\n\n') : undefined;
}

function withPriorWorkSummary(order: KitchenOrder, priorWorkSummary?: string): KitchenOrder {
	if (!priorWorkSummary?.trim() || order.priorWorkSummary?.trim()) return order;
	return { ...order, priorWorkSummary: priorWorkSummary.trim() };
}

function createContinuationOrder(message: string, route: Route, decision: WaiterDecision, priorWorkSummary?: string): KitchenOrder {
	return {
		route,
		intent: message,
		rewrittenTask: message,
		sources: [],
		constraints: ['Continue the active station thread; do not broaden scope unless the user asked for it.'],
		acceptanceCriteria: [
			'Answer the user request directly.',
			'Use the active station session and tools as needed.',
			'Surface concrete blockers instead of guessing.',
		],
		allowedActions: ['Continue the active station session and use route-appropriate tools.'],
		requestedOutput: 'Schema-valid station result for postflight review.',
		...(priorWorkSummary?.trim() ? { priorWorkSummary: priorWorkSummary.trim() } : {}),
	};
}

function createContinuationExplorer(route: Route, decision: WaiterDecision): ExplorerPreflight {
	return {
		summary: `Continuation approved by intake. ${decision.rationale}`,
		searchedSources: [],
		queryVariantsTried: [],
		findings: [],
		candidateModels: [],
		gaps: [],
	};
}

function createKitchenOrderFromPreflight(
	message: string,
	rework = false,
	priorAnswer?: string,
	preflight?: ExplorerPreflight,
	forcedSkillId?: string,
	forcedRoute?: Route,
	priorWorkSummary?: string,
): KitchenOrder {
	const route = forcedRoute ?? inferFallbackOrderRoute(message, forcedSkillId, preflight);
	const sources = deriveFallbackOrderSources({
		message,
		route,
		forcedSkillId,
		preflight,
	});
	if (forcedSkillId && !sources.includes('project_skill')) sources.unshift('project_skill');
	const reworkPrefix = rework ? 'Rework request after rejected answer. ' : '';
	const skillPrefix = forcedSkillId ? `Deterministic project skill /${forcedSkillId}. ` : '';
	const priorContext = priorAnswer ? ` Prior rejected answer: ${priorAnswer}` : '';
	const rethinkContext = rework
		? ' Complete rethink required: reconsider intent, source choice, route, assumptions, and validation from first principles.'
		: '';
	const preflightContext = preflight ? ` Explorer evidence summary: ${preflight.summary}` : '';

	return {
		route,
		skillId: forcedSkillId,
		intent: `${skillPrefix}${reworkPrefix}${message || 'Run the requested project skill.'}`,
		rewrittenTask: `${skillPrefix}${message || 'Run the requested project skill.'}${priorContext}${rethinkContext}${preflightContext}`,
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
		...(priorWorkSummary?.trim() ? { priorWorkSummary: priorWorkSummary.trim() } : {}),
	};
}

async function draftKitchenOrder(input: {
	waiterSession: FlueSession;
	message: string;
	rework?: boolean;
	priorAnswer?: string;
	priorWorkSummary?: string;
	turn: TurnContext;
	explorerData: ExplorerPreflight;
	sourceCatalog: string;
	forcedSkillId?: string;
	forcedRoute?: Route;
}): Promise<{ order: KitchenOrder; usage?: unknown }> {
	try {
		const result = await input.waiterSession.prompt(
			[
				'Mode: draft_work_order.',
				'This is the second waiter judgment after explorer evidence was gathered.',
				'First decide whether you have enough to write a coherent domain work order.',
				'If yes, create the work order and leave both clarifyingQuestion and blockerMessage empty.',
				'If no because the user must resolve missing meaning, scope, definition, success criteria, or intended output, set clarifyingQuestion.',
				'If no because access, policy, or missing sources prevent useful work right now, set blockerMessage.',
				'Create a domain work order, not a final answer.',
				'Use explorer evidence to route and frame the work; leave domain execution and validation to the station.',
				'Use the explorer preflight as supporting context. Do not answer the user directly from this step.',
				'Choose route:',
				'- analytics: metrics, SQL, dbt, BigQuery, dashboards, distributions.',
				'- knowledge: product/internal explanation from KB, Slack, Drive, Jira history, or repo context.',
				'- workflow: specialized execution such as event creation, ticket/PR automation, or cross-system action.',
				'- documentation: writing/updating project or user context.',
				input.forcedSkillId
					? `Deterministic project skill command: /${input.forcedSkillId}. Set skillId to "${input.forcedSkillId}", include "project_skill" in sources, and route to ${input.forcedRoute || 'workflow'} unless policy requires clarification. Do not reinterpret whether the skill should run.`
					: '',
				'If the user request is too ambiguous, set clarifyingQuestion.',
				'If the request cannot proceed because required evidence is inaccessible or missing in the available sources, set blockerMessage instead of pretending a station can resolve it.',
				'The question is whether you understand the request well enough to write a coherent station order, not whether one narrow phrase can be patched with nearby evidence.',
				'Be skeptical when first-pass exploration and your own context do not produce enough evidence to understand the user request. Use your judgment: if the missing context changes what work should be done, what definition applies, what scope is valid, or what success means, set clarifyingQuestion instead of drafting a proxy work order.',
				'Do not invent missing meaning just because nearby data exists. Nearby evidence is not enough when the user intent itself remains underdefined.',
				'For rework, explicitly address why the prior answer may have failed and create a fresh work order from first principles.',
				input.rework ? reworkPromptAddendum(input.priorAnswer) : '',
				'For side_question, produce a bounded branch work order that does not rely on station memory from the current mainline unless the user explicitly asks for it.',
				'For topic_switch, treat the request as a fresh stream under the same user conversation.',
				`Turn context:\n${JSON.stringify(input.turn, null, 2)}`,
				`Rework: ${input.rework ? 'yes' : 'no'}`,
				input.priorWorkSummary ? `Prior work context:\n${input.priorWorkSummary}` : '',
				input.priorAnswer ? `Prior rejected answer:\n${input.priorAnswer}` : '',
				input.sourceCatalog ? `Source catalog:\n${input.sourceCatalog}` : '',
				`Explorer summary:\n${formatExplorerPreflightForWaiter(input.explorerData)}`,
				`User request:\n${input.message}`,
			].filter(Boolean).join('\n\n'),
			{ result: KitchenOrderSchema },
		);
		return { order: result.data, usage: result.usage };
	} catch {
		return {
			order: createKitchenOrder(
				input.message,
				input.rework,
				input.priorAnswer,
				input.explorerData,
				input.forcedSkillId,
				input.forcedRoute,
				input.priorWorkSummary,
			),
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
	explorerData: ExplorerPreflight;
}): Promise<{ data: KitchenResult; usage?: unknown; session: FlueSession }> {
	if (!input.sessionPlan.stationSessionName) {
		throw new Error('Station session name is required after routing.');
	}

	if (input.order.route === 'analytics') {
		const kitchenHarness = await input.init({
			name: 'kitchen-analytics',
			sandbox: stationSandboxForRoute('analytics'),
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
			sandbox: stationSandboxForRoute('knowledge'),
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
		sandbox: stationSandboxForRoute(input.order.route),
		model: input.kitchenModel,
		role: input.order.route,
		tools: stationToolsForRoute(input.order.route, input.policy),
	});
	const kitchenSession = await kitchenHarness.session(input.sessionPlan.stationSessionName);
	const result = await kitchenSession.prompt(
		[
			`Mode: ${input.order.route}_station.`,
			'Return a schema-valid station result for orchestrator review.',
			projectSkillStationInstruction(input.order),
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
	explorerData: ExplorerPreflight;
	kitchenResult: KitchenResult;
	attempt: number;
}): Promise<{ review: PostflightReview; usage?: unknown }> {
	try {
		const result = await input.waiterSession.prompt(
			[
				'Mode: postflight_gate.',
				'Review the station delivery and produce the only user-facing assistant message unless the station must revise.',
				'Compare the delivery to the original request, work order, evidence, and acceptance criteria.',
				'Return accept only when the station result is ready to present to the user.',
				'Return revise when the station should correct incomplete work, weak evidence, wrong source choice, missing artifacts, or unsupported claims.',
				'Return ask_user when the user must answer a question before further station work can be useful.',
				'Return block when policy, access, or tool failure prevents completion.',
				'For accept, ask_user, and block, write userMessage as the final user-facing message.',
				'For revise, write feedbackToStation and do not write userMessage.',
				'For analytics, failed BigQuery or Metabase auth is a blocker when validation, query execution, or card creation is part of the requested deliverable.',
				'Do not accept claims that filters, SQL, date ranges, or cards were validated when the station only inferred them after a tool failure.',
				'On attempt 2, prefer block over accept if the same auth/tool failure still prevents a requested persistent action or required validation.',
				'Do not run a new preflight loop. If more research or validation is needed, send concrete feedback back to the station.',
				'The loop is bounded: attempt 1 may send work back; attempt 2 should usually accept, ask_user, or block.',
				'The userMessage must not expose routing, station names, work orders, preflight, or orchestration details.',
				`Postflight attempt: ${input.attempt}`,
				`Original user request:\n${input.message}`,
				`Turn context:\n${JSON.stringify(input.turn, null, 2)}`,
				`Session plan:\n${JSON.stringify(input.sessionPlan, null, 2)}`,
				`Work order:\n${JSON.stringify(input.order, null, 2)}`,
				`Explorer summary:\n${formatExplorerPreflightForWaiter(input.explorerData)}`,
				`Station result:\n${formatKitchenResultForWaiter(input.kitchenResult)}`,
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
		userMessage: buildSafeStationFallbackReply(kitchenResult),
	};
}

async function reviseKitchenStation(input: {
	session: FlueSession;
	turn: TurnContext;
	sessionPlan: SessionPlan;
	order: KitchenOrder;
	explorerData: ExplorerPreflight;
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
	explorerData: ExplorerPreflight,
	turn: TurnContext,
	sessionPlan: SessionPlan,
): string {
	return [
		'Mode: analytics_station.',
		'Follow the work order exactly and return a schema-valid station result for orchestrator review.',
		'Use explorer preflight as planning evidence, not as ground truth.',
		projectSkillStationInstruction(order),
		`Turn context:\n${JSON.stringify(turn, null, 2)}`,
		`Session plan:\n${JSON.stringify(sessionPlan, null, 2)}`,
		`Kitchen order:\n${JSON.stringify(order, null, 2)}`,
		`Explorer preflight:\n${JSON.stringify(explorerData, null, 2)}`,
	].join('\n\n');
}

function buildKnowledgeKitchenPrompt(
	order: KitchenOrder,
	explorerData: ExplorerPreflight,
	turn: TurnContext,
	sessionPlan: SessionPlan,
): string {
	return [
		'Mode: knowledge_station.',
		'Follow the work order exactly and return a schema-valid station result for orchestrator review.',
		projectSkillStationInstruction(order),
		`Turn context:\n${JSON.stringify(turn, null, 2)}`,
		`Session plan:\n${JSON.stringify(sessionPlan, null, 2)}`,
		`Kitchen order:\n${JSON.stringify(order, null, 2)}`,
		`Explorer preflight:\n${JSON.stringify(explorerData, null, 2)}`,
	].join('\n\n');
}

function projectSkillStationInstruction(order: KitchenOrder): string {
	if (!order.skillId) return '';
	return [
		`Deterministic project skill command: /${order.skillId}.`,
		'Before doing substantive work, call project_skill_read for this exact skillId and path "SKILL.md".',
		'Then progressively read only referenced files needed for this request.',
		'Do not fuzzy-match or substitute a different skill.',
	].join(' ');
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
			...createWorkflowTemplateTools(),
			...createProjectSkillTools(),
			...createJiraAutomationTools({
				allowWorkflowMutation: policy.permissions.allowWorkflowMutation,
			}),
			...explorerToolset(policy),
			...createLocalWorkspaceTools(policy),
			...createWorkflowPersistenceTools(policy),
			...createArtifactPersistenceTools(policy),
		]);
	}
	return dedupeToolsByName([...explorerToolset(policy), ...createArtifactPersistenceTools(policy)]);
}

function stationSandboxForRoute(route: v.InferOutput<typeof RouteSchema>) {
	if (route === 'workflow') {
		return local({
			env: {
				SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK,
				GH_TOKEN: process.env.GH_TOKEN || process.env.GITHUB_PAT,
				GITHUB_TOKEN: process.env.GITHUB_TOKEN || process.env.GITHUB_PAT,
			},
		});
	}
	return localWithoutBuiltinTools();
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
	explorationRequest: ExplorationRequest;
	sourceCatalog: string;
	selectedKbArticles: Array<{ path: string; title: string; description: string }>;
	forcedSkillId?: string;
	forcedRoute?: Route;
	priorAnswer?: string;
	priorWorkSummary?: string;
}) {
	const explorerHarness = await input.init({
		name: 'explorer-tasker',
		sandbox: localWithoutBuiltinTools({ disableTaskTool: true }),
		model: process.env.EXPLORER_MODEL || 'openai/gpt-5.4-nano',
		role: 'explorer',
		tools: explorerToolset(input.policy),
	});
	const explorerSession = await explorerHarness.session(input.sessionName);
	return explorerSession.prompt(
		[
			'Mode: preflight.',
			'Every waiter-mediated request starts with this preflight. Execute the caller-directed exploration brief below.',
			'Act like a bounded retrieval worker, not a planner.',
			'The caller already chose the uncertainty to resolve and the allowed sources. Search only within that boundary.',
			'Generate a small set of query variants from unresolvedTerms, entityHints, and candidateKeywords in the brief. Return the variants you actually tried.',
			'If the brief is insufficient, report the gap plainly. Do not broaden the agenda silently.',
			'Do not solve the full domain task. Stop at evidence, candidate sources/models, and unresolved gaps.',
			'You are not a decision-maker. Do not decide whether the system should proceed, ask the user, block, route to a station, or recommend a next step.',
			'Identify searched sources, query variants tried, findings, candidate sources/models, and uncertainty only.',
			'If no direct evidence is found, say so plainly and keep the concept unresolved instead of backfilling meaning from adjacent data or plausible proxies.',
			'This is a detached per-run research session. Do not assume continuity from prior explorer runs.',
			input.turn.isRework ? reworkPromptAddendum(input.priorAnswer) : '',
			input.priorWorkSummary ? `Prior work context:\n${input.priorWorkSummary}` : '',
			'For side_question, gather only the evidence needed for the branch question without polluting the mainline station context.',
			'For topic_switch, treat this as a fresh topic stream under the same user conversation.',
			input.forcedSkillId
				? `Deterministic project skill command: /${input.forcedSkillId}. Use project_skill as a source and read that skill by id when requested.`
				: '',
			`Turn context:\n${JSON.stringify(input.turn, null, 2)}`,
			`Session plan:\n${JSON.stringify(input.sessionPlan, null, 2)}`,
			`Caller-directed exploration brief:\n${formatExplorationRequest(input.explorationRequest)}`,
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
	preflight: ExplorerPreflight,
): ExplorerPreflight {
	return preflight;
}

export function shouldReturnBeforeStation(
	preflight: ExplorerPreflight,
	order: KitchenOrder,
): boolean {
	void preflight;
	return Boolean(order.clarifyingQuestion || order.blockerMessage);
}

export function buildPreStationFollowup(
	preflight: ExplorerPreflight,
	order: KitchenOrder,
): string {
	void preflight;
	if (order.clarifyingQuestion?.trim()) return order.clarifyingQuestion.trim();
	if (order.blockerMessage?.trim()) return order.blockerMessage.trim();
	return 'I need one clarification before I can continue.';
}

export function buildFinalUserReply(candidate: string, kitchenResult: KitchenResult): string {
	return userVisibleOrFallback(candidate, buildUnsafeFinalFallback(kitchenResult));
}

export function buildSafeStationFallbackReply(kitchenResult: KitchenResult): string {
	return userVisibleOrFallback(
		kitchenResult.answer,
		userVisibleOrFallback(
			kitchenResult.kitchenSummary,
			'I could not complete this yet. The domain work returned, but it was not safe to present directly.',
		),
	);
}

export function buildPostflightUserReply(
	review: PostflightReview,
	kitchenResult: KitchenResult,
): { reply: string; replyType: UserReplyType } {
	if (review.verdict === 'ask_user') {
		return {
			reply: userVisibleOrFallback(
				review.userMessage || kitchenResult.followupQuestions[0],
				'I need one clarification before I can continue.',
			),
			replyType: 'followup_question',
		};
	}
	return {
		reply: userVisibleOrFallback(review.userMessage, buildSafeStationFallbackReply(kitchenResult)),
		replyType: 'final',
	};
}

function replyTypeForPreStation(preflight: ExplorerPreflight, order: KitchenOrder): UserReplyType {
	void preflight;
	return Boolean(order.clarifyingQuestion)
		? 'followup_question'
		: 'final';
}

function buildUnsafeFinalFallback(kitchenResult: KitchenResult): string {
	const safeAnswer = userSafeParagraph(kitchenResult.answer);
	if (safeAnswer && kitchenResult.confidence !== 'low' && !kitchenResult.needsReview) return safeAnswer;
	const safeSummary = userSafeParagraph(kitchenResult.kitchenSummary);
	if (safeSummary && kitchenResult.confidence !== 'low' && !kitchenResult.needsReview) return safeSummary;
	return 'I could not complete this yet. This run did not produce verified completed actions or a concrete blocker.';
}

function userVisibleOrFallback(candidate: string | undefined, fallback: string): string {
	const clean = candidate?.trim();
	if (clean && isUserVisibleReplySafe(clean)) return clean;
	return fallback;
}

export function isUserVisibleReplySafe(reply: string): boolean {
	const clean = reply.trim();
	if (!clean) return false;
	return !/\b(headless|waiter|kitchen|station|workflow station|analytics station|knowledge station|orchestrator|explorer|preflight|work\s*order|routing|dispatch|source research queue|re-run orchestration|should attempt|should run|should inspect|proceeding without user clarification)\b/i.test(clean);
}

function userSafeSentence(value?: string): string | undefined {
	const clean = value?.replace(/\s+/g, ' ').trim().replace(/[.。]+$/, '');
	if (!clean) return undefined;
	if (/\b(waiter|kitchen|station|explorer|preflight|work\s*order|routing|dispatch|orchestration|source research queue|re-run)\b/i.test(clean)) {
		return undefined;
	}
	if (clean.length > 220) return `${clean.slice(0, 217).trim()}...`;
	return clean;
}

function userSafeParagraph(value?: string): string | undefined {
	const clean = value?.replace(/\s+/g, ' ').trim();
	if (!clean) return undefined;
	if (!isUserVisibleReplySafe(clean)) return undefined;
	if (clean.length > 1200) return `${clean.slice(0, 1197).trim()}...`;
	return clean;
}

async function readOptionalSourceCatalog(): Promise<string> {
	try {
		return await readSourceCatalogText();
	} catch {
		return '';
	}
}

function inferFallbackOrderRoute(message: string, forcedSkillId?: string, preflight?: ExplorerPreflight): Route {
	if (forcedSkillId) return 'workflow';
	if ((preflight?.candidateModels.length ?? 0) > 0) return 'analytics';
	const lower = message.toLowerCase();
	if (/\b(sql|dbt|bigquery|metabase|metric|dashboard|chart|count|how many|trend|distribution|field|flag|model)\b/.test(lower)) {
		return 'analytics';
	}
	if (/\b(create ticket|open pr|clone|branch|workflow|skill|automation)\b/.test(lower)) return 'workflow';
	if (/\b(write|document|add context|update docs|note)\b/.test(lower)) return 'documentation';
	return 'knowledge';
}

function deriveFallbackOrderSources(input: {
	message: string;
	route: Route;
	forcedSkillId?: string;
	preflight?: ExplorerPreflight;
}): Array<v.InferOutput<typeof SourceSchema>> {
	const sources = new Set<v.InferOutput<typeof SourceSchema>>();
	for (const source of defaultOrderSourcesForRoute(input.route, input.forcedSkillId)) sources.add(source);
	for (const source of input.preflight?.searchedSources ?? []) sources.add(source);
	for (const source of explicitSourceMentions(input.message, input.forcedSkillId)) sources.add(source);
	return [...sources];
}

function defaultOrderSourcesForRoute(
	route: Route,
	forcedSkillId?: string,
): Array<v.InferOutput<typeof SourceSchema>> {
	if (forcedSkillId || route === 'workflow') return ['project_skill', 'kb'];
	if (route === 'analytics') return ['manifest', 'bigquery'];
	if (route === 'documentation') return ['kb', 'project_skill'];
	return ['kb'];
}

function explicitSourceMentions(
	message: string,
	forcedSkillId?: string,
): ExplorationSource[] {
	const lower = message.toLowerCase();
	const sources = new Set<ExplorationSource>();
	if (/\bslack\b/.test(lower)) sources.add('slack');
	if (/\b(drive|gdrive)\b/.test(lower)) sources.add('drive');
	if (/\bjira\b/.test(lower)) sources.add('jira');
	if (/\b(repo|github|git)\b/.test(lower)) sources.add('repo');
	if (/\bmetabase\b/.test(lower)) sources.add('metabase');
	if (/\bbigquery\b/.test(lower)) sources.add('bigquery');
	if (/\b(dbt|manifest)\b/.test(lower)) sources.add('manifest');
	if (forcedSkillId) sources.add('project_skill');
	return [...sources];
}
