import * as v from 'valibot';

import { type StationRoute, type TurnContext } from './session-plan.ts';

export const ExplorationSourceSchema = v.picklist([
	'kb',
	'manifest',
	'bigquery',
	'metabase',
	'slack',
	'drive',
	'repo',
	'jira',
	'project_skill',
]);

export const ExplorationSearchModeSchema = v.picklist([
	'definition_lookup',
	'artifact_lookup',
	'entity_lookup',
	'source_of_truth_lookup',
	'metric_mapping',
	'workflow_lookup',
	'documentation_lookup',
]);

export const ExplorationBriefSchema = v.object({
	objective: v.string(),
	searchMode: ExplorationSearchModeSchema,
	unresolvedTerms: v.array(v.string()),
	allowedSources: v.array(ExplorationSourceSchema),
	entityHints: v.optional(v.array(v.string()), []),
	candidateKeywords: v.array(v.string()),
	evidenceNeeded: v.array(v.string()),
	stopWhen: v.string(),
});

export const ExplorationRequestSchema = v.object({
	requestedBy: v.picklist(['waiter', 'station']),
	brief: ExplorationBriefSchema,
});

export type ExplorationSource = v.InferOutput<typeof ExplorationSourceSchema>;
export type ExplorationSearchMode = v.InferOutput<typeof ExplorationSearchModeSchema>;
export type ExplorationBrief = v.InferOutput<typeof ExplorationBriefSchema>;
export type ExplorationRequest = v.InferOutput<typeof ExplorationRequestSchema>;

export function createWaiterExplorationRequest(input: {
	message: string;
	resolvedTask?: string;
	route?: StationRoute;
	turn: TurnContext;
	forcedSkillId?: string;
	selectedKbArticles?: Array<{ path: string; title: string; description: string }>;
	brief?: ExplorationBrief;
}): ExplorationRequest {
	const objective = (input.resolvedTask || input.message).trim() || 'Understand the user request well enough to route it.';
	const brief = input.brief
		? normalizeExplorationBrief(input.brief)
		: buildFallbackExplorationBrief({
				message: input.message,
				objective,
				route: input.route,
				turn: input.turn,
				forcedSkillId: input.forcedSkillId,
				selectedKbArticles: input.selectedKbArticles,
			});

	return {
		requestedBy: 'waiter',
		brief,
	};
}

export function formatExplorationRequest(request: ExplorationRequest): string {
	return JSON.stringify(request, null, 2);
}

function buildFallbackExplorationBrief(input: {
	message: string;
	objective: string;
	route?: StationRoute;
	turn: TurnContext;
	forcedSkillId?: string;
	selectedKbArticles?: Array<{ path: string; title: string; description: string }>;
}): ExplorationBrief {
	const route = resolveFallbackRoute(input.route, input.objective, input.forcedSkillId);
	const searchMode = fallbackSearchMode(route, input.forcedSkillId, input.objective);
	const unresolvedTerms = fallbackUnresolvedTerms(input.objective);
	const entityHints = fallbackEntityHints(input.objective);
	const allowedSources = [
		...defaultSourcesForRoute(route, input.forcedSkillId),
		...explicitSourceMentions(input.message, input.forcedSkillId),
	];
	const candidateKeywords = createCandidateKeywords({
		objective: input.objective,
		unresolvedTerms,
		entityHints,
		selectedKbArticles: input.selectedKbArticles,
	});

	return normalizeExplorationBrief({
		objective: input.objective,
		searchMode,
		unresolvedTerms,
		allowedSources,
		entityHints,
		candidateKeywords,
		evidenceNeeded: defaultEvidenceNeeded(searchMode, route, input.forcedSkillId),
		stopWhen: stopConditionForSearchMode(searchMode, input.turn.type, route),
	});
}

function normalizeExplorationBrief(brief: ExplorationBrief): ExplorationBrief {
	const objective = brief.objective.trim() || 'Understand the user request well enough to route it.';
	const unresolvedTerms = dedupeStrings(brief.unresolvedTerms).slice(0, 6);
	const entityHints = dedupeStrings(brief.entityHints || []).slice(0, 4);
	const allowedSources = dedupeSources(brief.allowedSources);
	const candidateKeywords = dedupeStrings(brief.candidateKeywords).slice(0, 10);
	const evidenceNeeded = dedupeStrings(brief.evidenceNeeded).slice(0, 6);

	return {
		objective,
		searchMode: brief.searchMode,
		unresolvedTerms,
		allowedSources: allowedSources.length > 0 ? allowedSources : ['kb'],
		entityHints,
		candidateKeywords: candidateKeywords.length > 0 ? candidateKeywords : [objective],
		evidenceNeeded: evidenceNeeded.length > 0
			? evidenceNeeded
			: ['Evidence that resolves the missing context well enough for a work order.'],
		stopWhen: brief.stopWhen.trim() || 'Stop when the missing context is either resolved or clearly absent from the allowed sources.',
	};
}

function resolveFallbackRoute(
	route: StationRoute | undefined,
	objective: string,
	forcedSkillId?: string,
): StationRoute {
	if (forcedSkillId) return 'workflow';
	if (route === 'analytics' && isNamedArtifactLookup(objective) && !hasExplicitWarehouseIntent(objective)) {
		return 'knowledge';
	}
	return route || inferFallbackRoute(objective);
}

function inferFallbackRoute(message: string): StationRoute {
	const lower = message.toLowerCase();
	if (isNamedArtifactLookup(message)) return 'knowledge';
	if (/\b(sql|dbt|bigquery|metabase|metric|dashboard|chart|count|how many|trend|distribution|field|flag|model)\b/.test(lower)) {
		return 'analytics';
	}
	if (/\b(create ticket|open pr|clone|branch|workflow|skill|automation)\b/.test(lower)) return 'workflow';
	if (/\b(write|document|add context|update docs|note)\b/.test(lower)) return 'documentation';
	return 'knowledge';
}

function fallbackSearchMode(
	route: StationRoute,
	forcedSkillId: string | undefined,
	objective: string,
): ExplorationSearchMode {
	if (forcedSkillId || route === 'workflow') return 'workflow_lookup';
	if (route === 'documentation') return 'documentation_lookup';
	if (route === 'analytics') {
		return /\b(metric|definition|source of truth)\b/i.test(objective) ? 'metric_mapping' : 'source_of_truth_lookup';
	}
	if (isNamedArtifactLookup(objective)) return 'artifact_lookup';
	if (/\bwhat is\b|\bmeaning\b|\bdefinition\b|\bexplain\b/i.test(objective)) return 'definition_lookup';
	return 'definition_lookup';
}

function defaultSourcesForRoute(route: StationRoute, forcedSkillId?: string): ExplorationSource[] {
	if (forcedSkillId || route === 'workflow') return ['project_skill', 'kb'];
	if (route === 'analytics') return ['manifest', 'bigquery'];
	if (route === 'documentation') return ['kb', 'project_skill'];
	return ['kb'];
}

function explicitSourceMentions(message: string, forcedSkillId?: string): ExplorationSource[] {
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

function fallbackUnresolvedTerms(objective: string): string[] {
	const terms = new Set<string>();
	for (const match of objective.matchAll(/["`](.+?)["`]/g)) {
		if (match[1]?.trim()) terms.add(match[1].trim());
	}
	const cleanedArtifact = cleanArtifactSubject(objective);
	if (isNamedArtifactLookup(objective) && cleanedArtifact) terms.add(cleanedArtifact);
	if (terms.size === 0 && /\bwhat is\b|\bexplain\b|\bdefine\b/i.test(objective)) {
		const cleaned = objective
			.replace(/^(what is|what's|explain|define)\s+/i, '')
			.replace(/[?]+$/g, '')
			.trim();
		if (cleaned) terms.add(cleaned);
	}
	return [...terms].slice(0, 4);
}

function fallbackEntityHints(objective: string): string[] {
	const entities = new Set<string>();
	const firmMatch = objective.match(/\bfor (?:the )?(?:firm|customer|client|law firm)\s+([^?.]+?)(?:\s+on\b|\s+using\b|$)/i);
	if (firmMatch?.[1]?.trim()) entities.add(firmMatch[1].trim());
	const quotedFirm = objective.match(/["`]([^"`]+?)["`]/g);
	for (const match of quotedFirm ?? []) {
		const value = match.slice(1, -1).trim();
		if (/\binc\.?\b|\bgroup\b|\blaw\b/i.test(value)) entities.add(value);
	}
	return [...entities].slice(0, 4);
}

function cleanArtifactSubject(objective: string): string | undefined {
	const beforeFor = objective.split(/\bfor\b/i)[0] || objective;
	const cleaned = beforeFor
		.replace(/^(can you|could you|would you|please)\s+/i, '')
		.replace(/^(give me|show me|find|look up)\s+/i, '')
		.replace(/^(a|an|the)\s+/i, '')
		.replace(/[?.]+$/g, '')
		.trim();
	return cleaned || undefined;
}

function createCandidateKeywords(input: {
	objective: string;
	unresolvedTerms: string[];
	entityHints: string[];
	selectedKbArticles?: Array<{ path: string; title: string; description: string }>;
}): string[] {
	const keywords = new Set<string>([input.objective]);
	for (const term of input.unresolvedTerms) {
		for (const variant of phraseVariants(term)) keywords.add(variant);
	}
	for (const entity of input.entityHints) keywords.add(entity);
	for (const article of input.selectedKbArticles ?? []) {
		keywords.add(article.title.trim());
	}
	return [...keywords].filter(Boolean).slice(0, 10);
}

function phraseVariants(value: string): string[] {
	const trimmed = value.trim();
	if (!trimmed) return [];
	const spaced = trimmed.replace(/[-_/]+/g, ' ').replace(/\s+/g, ' ').trim();
	const hyphenated = spaced.replace(/\s+/g, '-');
	return dedupeStrings([trimmed, spaced, hyphenated, trimmed.toLowerCase()]);
}

function defaultEvidenceNeeded(
	searchMode: ExplorationSearchMode,
	route: StationRoute,
	forcedSkillId?: string,
): string[] {
	if (forcedSkillId || searchMode === 'workflow_lookup') {
		return ['The exact workflow or skill definition, required inputs, and any referenced procedure files.'];
	}
	if (searchMode === 'artifact_lookup' || searchMode === 'definition_lookup') {
		return ['A direct definition, spec, checklist, report template, or internal reference that explains the named concept.'];
	}
	if (searchMode === 'documentation_lookup') {
		return ['The existing document or source material that should anchor the requested documentation work.'];
	}
	if (route === 'analytics') {
		return ['Candidate source-of-truth models, relevant caveats, and validation gaps grounded in warehouse context.'];
	}
	return ['Evidence that clarifies the user term or request well enough to draft a grounded work order.'];
}

function stopConditionForSearchMode(
	searchMode: ExplorationSearchMode,
	turnType: TurnContext['type'],
	route: StationRoute,
): string {
	const branchClause = turnType === 'side_question'
		? ' Keep the result scoped to the branch question.'
		: turnType === 'topic_switch'
			? ' Treat this as a fresh topic stream.'
			: '';
	if (searchMode === 'workflow_lookup') {
		return `Stop when the exact workflow/skill, required tools, and any unresolved permission gaps are identified.${branchClause}`;
	}
	if (searchMode === 'artifact_lookup' || searchMode === 'definition_lookup') {
		return `Stop when the named concept is either directly defined in the allowed sources or clearly absent from them.${branchClause}`;
	}
	if (route === 'analytics') {
		return `Stop when candidate source-of-truth models, material caveats, and validation gaps are concrete enough for analytics execution.${branchClause}`;
	}
	return `Stop when the missing context is either resolved or clearly absent from the allowed sources.${branchClause}`;
}

function isNamedArtifactLookup(message: string): boolean {
	const lower = message.toLowerCase();
	return /\b(report|readiness|scorecard|template|checklist|spec|artifact|workflow|playbook|brief)\b/.test(lower)
		&& !/\b(sql|dbt|bigquery|column|table|field|join|filter|group by|where clause|manifest)\b/.test(lower);
}

function hasExplicitWarehouseIntent(message: string): boolean {
	return /\b(sql|dbt|bigquery|column|table|warehouse|field|join|filter|group by|manifest|metric|count|trend|distribution|top values|date range|how many)\b/i.test(message);
}

function dedupeStrings(values: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const value of values) {
		const trimmed = value.trim();
		if (!trimmed) continue;
		const key = trimmed.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(trimmed);
	}
	return result;
}

function dedupeSources(values: ExplorationSource[]): ExplorationSource[] {
	return [...new Set(values)];
}
