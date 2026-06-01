import { BigQuery } from '@google-cloud/bigquery';
import { OAuth2Client } from 'google-auth-library';
import { randomUUID } from 'node:crypto';

import { normalizeReadOnlySql } from './bigquery.ts';
import { readJsonResponse, requireEnvToken, type FetchLike } from './http.ts';

export type MetabaseVizType = 'table' | 'bar' | 'line' | 'area' | 'stacked-bar' | 'stacked-area' | 'stacked-line';
export type MetabaseRefType = 'bookmarked_card' | 'frequently_run_card';
export type MetabaseHelpTopic = 'overview' | 'viz_type' | 'field_filters' | 'examples';

export interface MetabaseResearchInput {
	model?: string;
	card?: string;
	top?: number;
	includeSql?: boolean;
	refType?: MetabaseRefType;
	projectId?: string;
	dataset?: string;
	credentialMode?: 'service_account' | 'user_oauth';
	userAccessToken?: string;
	client?: BigQueryLike;
}

export interface MetabaseCreateCardInput {
	vizType: MetabaseVizType;
	name: string;
	query: string;
	description?: string;
	collectionId?: number;
	databaseId?: number;
	dashboardId?: number;
	cacheTtl?: number;
	vizSettings?: Record<string, unknown>;
	fieldFilters?: Record<string, FieldFilterSpec>;
	apiKey?: string;
	metabaseUrl?: string;
	fetchImpl?: FetchLike;
}

export type FieldFilterSpec =
	| number
	| {
			field_id: number;
			alias?: string;
			widget_type?: string;
	  };

export interface BigQueryLike {
	query(options: Record<string, unknown>): Promise<any[]>;
}

const DEFAULT_PROJECT = 'evenup-bi';
const DEFAULT_DATASET = 'dbt_prod';
const DEFAULT_COLLECTION_ID = 2260;
const DEFAULT_DATABASE_ID = 13371338;
const DEFAULT_METABASE_URL = 'https://metabase.evenup.law';

const DISPLAY_MAP: Record<MetabaseVizType, string> = {
	table: 'table',
	bar: 'bar',
	line: 'line',
	area: 'area',
	'stacked-bar': 'bar',
	'stacked-area': 'area',
	'stacked-line': 'line',
};

const VIZ_HELP: Record<MetabaseVizType, Record<string, unknown>> = {
	table: {
		when_to_use: 'Tabular results, audit/detail lists, or any query where row-level values matter.',
		display: 'table',
		common_viz_settings: {
			'table.columns': 'Array like [{ name: "col", enabled: true }]. Use to show/hide/reorder columns.',
			'table.pivot_column': 'Column to pivot rows into columns.',
			'table.cell_column': 'Column used as cell values when pivoting.',
		},
	},
	bar: {
		when_to_use: 'Categorical comparisons, ranked bars, or monthly counts with one or more categories.',
		display: 'bar',
		common_viz_settings: graphVizSettings(),
	},
	line: {
		when_to_use: 'Time trends where the slope/change over time matters.',
		display: 'line',
		common_viz_settings: graphVizSettings(),
	},
	area: {
		when_to_use: 'Time trends where cumulative visual weight matters; good for volume over time.',
		display: 'area',
		common_viz_settings: graphVizSettings(),
	},
	'stacked-bar': {
		when_to_use: 'Composition across categories, especially monthly counts split by status/type.',
		display: 'bar',
		auto_applied: { 'stackable.stack_type': 'stacked' },
		common_viz_settings: graphVizSettings(),
	},
	'stacked-area': {
		when_to_use: 'Composition over time where total magnitude and mix both matter.',
		display: 'area',
		auto_applied: { 'stackable.stack_type': 'stacked' },
		common_viz_settings: graphVizSettings(),
	},
	'stacked-line': {
		when_to_use: 'Rarely preferred; use when multiple trend lines should stack cumulatively.',
		display: 'line',
		auto_applied: { 'stackable.stack_type': 'stacked' },
		common_viz_settings: graphVizSettings(),
	},
};

export function getMetabaseHelp(input: { topic?: MetabaseHelpTopic; vizType?: MetabaseVizType } = {}) {
	const topic = input.topic ?? 'overview';
	if (topic === 'overview') {
		return {
			ok: true,
			topic,
			defaults: {
				collection_id: DEFAULT_COLLECTION_ID,
				database_id: DEFAULT_DATABASE_ID,
			},
			viz_types: Object.entries(DISPLAY_MAP).map(([vizType, display]) => ({
				vizType,
				display,
				when_to_use: VIZ_HELP[vizType as MetabaseVizType].when_to_use,
			})),
			next_steps: [
				'Call metabase_help with topic="viz_type" and a vizType before building non-table chart settings.',
				'Call metabase_help with topic="field_filters" before using {{variables}} or fieldFilters.',
				'Simple table cards usually do not need additional help.',
			],
		};
	}
	if (topic === 'viz_type') {
		if (!input.vizType) throw new Error('vizType is required when topic is viz_type.');
		return {
			ok: true,
			topic,
			vizType: input.vizType,
			...VIZ_HELP[input.vizType],
			example_viz_settings: exampleVizSettings(input.vizType),
		};
	}
	if (topic === 'field_filters') {
		return {
			ok: true,
			topic,
			rules: [
				'SQL text variables use {{var}} and become plain text inputs by default.',
				'Dimension filters require fieldFilters[var] with a Metabase field id.',
				'For dimension filters, SQL should use [[AND {{var}}]], not col = {{var}}.',
				'If the SQL uses table aliases, pass alias like "m.firm_name"; do not use project-qualified paths as aliases.',
			],
			field_filter_shapes: {
				field_id_only: { firm_name: 485405 },
				with_alias_and_widget: {
					firm_name: { field_id: 485405, alias: 'm.firm_name', widget_type: 'string/=' },
				},
			},
			widget_types: [
				'string/=',
				'string/contains',
				'number/=',
				'number/between',
				'date/single',
				'date/range',
				'date/relative',
				'date/all-options',
				'category',
			],
		};
	}
	return {
		ok: true,
		topic,
		examples: [
			{
				name: 'Simple table',
				vizType: 'table',
				query: 'SELECT firm_name, COUNT(*) AS case_count FROM `evenup-bi.dbt_prod.dim_matters` GROUP BY 1',
			},
			{
				name: 'Monthly bar chart',
				vizType: 'bar',
				vizSettings: {
					'graph.dimensions': ['month'],
					'graph.metrics': ['case_count'],
					'graph.x_axis.scale': 'timeseries',
				},
			},
			{
				name: 'Field filter',
				query: 'SELECT * FROM `evenup-bi.dbt_prod.dim_matters` AS m WHERE TRUE [[AND {{firm_name}}]]',
				fieldFilters: { firm_name: { field_id: 485405, alias: 'm.firm_name', widget_type: 'string/=' } },
			},
		],
	};
}

export async function researchMetabase(input: MetabaseResearchInput) {
	if ((!input.model && !input.card) || (input.model && input.card)) {
		throw new Error('Provide exactly one of model or card.');
	}
	const projectId = input.projectId || process.env.GOOGLE_CLOUD_PROJECT || DEFAULT_PROJECT;
	const dataset = input.dataset || DEFAULT_DATASET;
	const credentialMode = input.credentialMode ?? (input.userAccessToken || process.env.GOOGLE_USER_ACCESS_TOKEN
		? 'user_oauth'
		: 'service_account');
	const client = input.client ?? createBigQueryClient({
		projectId,
		credentialMode,
		userAccessToken: input.userAccessToken,
	});
	const rows = input.model
		? await researchModel(client, {
				projectId,
				dataset,
				modelName: input.model,
				top: input.top,
				includeSql: Boolean(input.includeSql),
				refType: input.refType,
			})
		: await researchCard(client, {
				projectId,
				dataset,
				card: input.card!,
				includeSql: Boolean(input.includeSql),
			});
	return {
		ok: true,
		mode: input.model ? 'model' : 'card',
		rows,
	};
}

export async function createMetabaseCard(input: MetabaseCreateCardInput) {
	const apiKey = input.apiKey || requireEnvToken('METABASE_API_KEY', 'Metabase card creation requires an API key.');
	const metabaseUrl = (input.metabaseUrl || process.env.METABASE_URL || DEFAULT_METABASE_URL).replace(/\/+$/, '');
	const payload = buildMetabaseCardPayload(input);
	const fetcher = input.fetchImpl ?? fetch;
	const response = await fetcher(`${metabaseUrl}/api/card`, {
		method: 'POST',
		headers: {
			'x-api-key': apiKey,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(payload),
	});
	const data = await readJsonResponse(response, 'Metabase card creation');
	if (!response.ok) {
		throw new Error(`Metabase card creation failed: ${JSON.stringify(data).slice(0, 1000)}`);
	}
	const cardId = Number(data.id);
	return {
		ok: true,
		card_id: Number.isFinite(cardId) ? cardId : data.id,
		url: data.id ? `${metabaseUrl}/question/${data.id}` : undefined,
		payload,
		response: data,
	};
}

export function buildMetabaseCardPayload(input: MetabaseCreateCardInput) {
	const query = normalizeReadOnlySql(input.query);
	const vizSettings = buildVizSettings(input.vizType, input.vizSettings);
	return {
		name: input.name,
		collection_id: input.collectionId ?? DEFAULT_COLLECTION_ID,
		display: DISPLAY_MAP[input.vizType],
		dataset_query: {
			database: input.databaseId ?? DEFAULT_DATABASE_ID,
			type: 'native',
			native: {
				query,
				'template-tags': extractTemplateTags(query, input.fieldFilters),
			},
		},
		visualization_settings: vizSettings,
		...(input.description ? { description: input.description } : {}),
		...(input.dashboardId ? { dashboard_id: input.dashboardId } : {}),
		...(input.cacheTtl ? { cache_ttl: input.cacheTtl } : {}),
	};
}

function buildVizSettings(vizType: MetabaseVizType, vizSettings?: Record<string, unknown>) {
	return {
		...(vizType.startsWith('stacked-') ? { 'stackable.stack_type': 'stacked' } : {}),
		...(vizSettings ?? {}),
	};
}

function graphVizSettings() {
	return {
		'graph.dimensions': 'Array of x-axis/grouping columns, for example ["month"] or ["month", "status"].',
		'graph.metrics': 'Array of y-axis metric columns, for example ["case_count"].',
		'stackable.stack_type': '"stacked" or "normalized" for 100% stacked charts.',
		'graph.x_axis.scale': '"timeseries" for dates/months, otherwise "ordinal".',
		'graph.y_axis.min': 'Number. Commonly 0 for count charts.',
		'graph.show_values': 'Boolean. Show values on marks.',
		'line.missing_value_replacement': '"zero", "nothing", or "interpolate".',
		series_settings: 'Per-series overrides like { "Closed": { color: "#2A9D8F", title: "Closed" } }.',
		'goal.value': 'Number. Optional horizontal goal line.',
	};
}

function exampleVizSettings(vizType: MetabaseVizType) {
	if (vizType === 'table') {
		return {
			'table.columns': [
				{ name: 'firm_name', enabled: true },
				{ name: 'case_count', enabled: true },
			],
		};
	}
	if (vizType === 'stacked-bar' || vizType === 'stacked-area' || vizType === 'stacked-line') {
		return {
			'graph.dimensions': ['month', 'status'],
			'graph.metrics': ['case_count'],
			'graph.x_axis.scale': 'timeseries',
		};
	}
	return {
		'graph.dimensions': ['month'],
		'graph.metrics': ['case_count'],
		'graph.x_axis.scale': 'timeseries',
		'graph.y_axis.min': 0,
	};
}

function extractTemplateTags(query: string, fieldFilters: Record<string, FieldFilterSpec> = {}) {
	const variableNames = new Set([...query.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]!));
	const tags: Record<string, unknown> = {};
	for (const name of variableNames) {
		const displayName = name.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
		const filter = fieldFilters[name];
		if (filter !== undefined) {
			const spec = typeof filter === 'number' ? { field_id: filter } : filter;
			tags[name] = {
				id: randomUUID(),
				name,
				'display-name': displayName,
				type: 'dimension',
				'widget-type': spec.widget_type || 'string/=',
				dimension: ['field', spec.field_id, null],
				...(spec.alias ? { alias: spec.alias } : {}),
			};
		} else {
			tags[name] = {
				id: randomUUID(),
				name,
				'display-name': displayName,
				type: 'text',
				required: false,
				default: null,
			};
		}
	}
	return tags;
}

async function researchModel(
	client: BigQueryLike,
	input: {
		projectId: string;
		dataset: string;
		modelName: string;
		top?: number;
		includeSql: boolean;
		refType?: MetabaseRefType;
	},
) {
	const sqlCol = input.includeSql ? ',\n    native_query_sql' : '';
	const refTypeClause = input.refType ? 'AND ref_type = @ref_type' : '';
	const limitClause = input.top ? `LIMIT ${input.top}` : '';
	const query = `
SELECT
    card_id,
    card_name,
    card_url,
    ref_type,
    view_count,
    bookmark_count,
    creator_email,
    primary_dashboard_name,
    last_used_at${sqlCol}
FROM \`${input.projectId}.${input.dataset}.mart_dbt_model_metabase_usage\`
WHERE dbt_model_name = @model_name
  ${refTypeClause}
ORDER BY
    CASE ref_type WHEN 'bookmarked_card' THEN 1 ELSE 2 END,
    view_count DESC NULLS LAST
${limitClause}
`.trim();
	const params: Record<string, unknown> = { model_name: input.modelName };
	if (input.refType) params.ref_type = input.refType;
	return queryRows(client, query, params);
}

async function researchCard(
	client: BigQueryLike,
	input: {
		projectId: string;
		dataset: string;
		card: string;
		includeSql: boolean;
	},
) {
	const sqlCol = input.includeSql ? ',\n    c.native_query_sql' : '';
	const byId = /^-?\d+$/.test(input.card.trim());
	const whereClause = byId ? 'WHERE c.card_id = @card_ref_int' : 'WHERE LOWER(c.card_name) = LOWER(@card_ref_str)';
	const groupSqlCol = input.includeSql ? ', c.native_query_sql' : '';
	const query = `
SELECT
    c.card_id,
    c.card_name,
    c.card_description,
    c.card_display,
    c.card_url,
    c.creator_email,
    c.view_count,
    c.bookmark_count,
    c.primary_dashboard_name,
    c.last_used_at,
    c.created_at${sqlCol},
    ARRAY_AGG(
        IF(d.dbt_model_name IS NULL, NULL,
            STRUCT(d.dbt_model_name, d.raw_table_reference, d.reference_count)
        ) IGNORE NULLS
        ORDER BY d.dbt_model_name
    ) AS model_dependencies
FROM \`${input.projectId}.${input.dataset}.int_metabase_cards_context\` c
LEFT JOIN \`${input.projectId}.${input.dataset}.int_metabase_card_model_dependencies\` d
    ON d.card_id = c.card_id
${whereClause}
GROUP BY
    c.card_id,
    c.card_name,
    c.card_description,
    c.card_display,
    c.card_url,
    c.creator_email,
    c.view_count,
    c.bookmark_count,
    c.primary_dashboard_name,
    c.last_used_at,
    c.created_at${groupSqlCol}
`.trim();
	const params = byId ? { card_ref_int: Number(input.card) } : { card_ref_str: input.card };
	return queryRows(client, query, params);
}

async function queryRows(client: BigQueryLike, query: string, params: Record<string, unknown>) {
	const [rows] = await client.query({ query, params });
	return (Array.isArray(rows) ? rows : []).map(jsonSafeValue);
}

function createBigQueryClient(input: {
	projectId: string;
	credentialMode: 'service_account' | 'user_oauth';
	userAccessToken?: string;
}): BigQueryLike {
	if (input.credentialMode === 'user_oauth') {
		const token = input.userAccessToken || process.env.GOOGLE_USER_ACCESS_TOKEN;
		if (!token) throw new Error('GOOGLE_USER_ACCESS_TOKEN is required for user_oauth Metabase research mode.');
		const authClient = new OAuth2Client();
		authClient.setCredentials({ access_token: token });
		return new BigQuery({ projectId: input.projectId, authClient });
	}
	return new BigQuery({ projectId: input.projectId });
}

function jsonSafeValue(value: any): any {
	if (value === null || value === undefined) return value;
	if (value instanceof Date) return value.toISOString();
	if (Array.isArray(value)) return value.map(jsonSafeValue);
	if (typeof value === 'object') {
		const keys = Object.keys(value);
		if (keys.length === 1 && typeof value.value === 'string') return value.value;
		if (typeof value.valueOf === 'function') {
			const primitive = value.valueOf();
			if (primitive !== value && typeof primitive !== 'object') return primitive;
		}
		return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, jsonSafeValue(entry)]));
	}
	return value;
}
