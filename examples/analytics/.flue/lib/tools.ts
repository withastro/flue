import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';

import { Type, type ToolDef } from '@flue/runtime';

import { getDateRange, getDistinctValues, getRowCount, runBigQuery, validateBigQuery } from './bigquery.ts';
import {
	createDriveFile,
	downloadDriveFile,
	listDriveFolder,
	readDriveFile,
	searchDrive,
	uploadDriveFile,
} from './gdrive.ts';
import {
	DEFAULT_MANIFEST_PATH,
	getModelDetails,
	modelLineage,
	searchManifest,
	type LineageDirection,
	type ManifestSearchLogic,
	type ManifestSearchType,
} from './manifest.ts';
import {
	createJiraPr,
	createJiraTicket,
	getJiraScope,
	getJiraTaxonomy,
	queryJiraHistory,
} from './jira.ts';
import {
	createMetabaseCard,
	getMetabaseHelp,
	researchMetabase,
	type MetabaseHelpTopic,
	type MetabaseVizType,
} from './metabase.ts';
import { readSlackThread, searchSlack } from './slack.ts';

const execFileAsync = promisify(execFile);

export const DEFAULT_BQ_EXPLORE_SCRIPT =
	'resources/scripts/bq_explore/bq_explore.py';
export const DEFAULT_METABASE_CLI_SCRIPT =
	'resources/scripts/metabase/metabase-cli.py';

export interface AnalyticsToolConfig {
	manifestPath?: string;
	bqExploreScript?: string;
	metabaseCliScript?: string;
	metabaseHarness?: 'native' | 'python';
	maxGb?: number;
	allowMetabaseCreate?: boolean;
	allowGoogleDriveWrite?: boolean;
	allowWorkflowMutation?: boolean;
	bigQueryHarness?: 'native' | 'python';
	credentials?: {
		bigQueryMode?: 'service_account' | 'user_oauth';
		googleDriveMode?: 'service_account' | 'user_oauth';
	};
	limits?: {
		maxSearchResults?: number;
	};
}

export function createManifestTools(config: AnalyticsToolConfig = {}): ToolDef[] {
	const manifestPath = resolveRuntimePath(config.manifestPath || process.env.DBT_MANIFEST_PATH || DEFAULT_MANIFEST_PATH);

	const searchManifestTool: ToolDef = {
		name: 'search_manifest',
		description:
			'Search the dbt manifest for available models and columns. Use this before writing analytics SQL.',
		parameters: Type.Object({
			keywords: Type.Array(Type.String({ description: 'Keyword to search for.' }), {
				description: 'One or more search keywords.',
			}),
			searchType: Type.Optional(
				Type.String({
					description: 'Where to search: name, column, description, or all. Defaults to all.',
				}),
			),
			logic: Type.Optional(
				Type.String({ description: 'Combine multiple keywords with and/or. Defaults to and.' }),
			),
			includeSql: Type.Optional(Type.Boolean({ description: 'Include raw dbt SQL. Defaults to false.' })),
		}),
		execute: async (args) =>
			json(
				await searchManifest({
					manifestPath,
					keywords: asStringArray(args.keywords, 'keywords'),
					searchType: enumValue(args.searchType, ['name', 'column', 'description', 'all'], 'searchType'),
					logic: enumValue(args.logic, ['and', 'or'], 'logic'),
					includeSql: Boolean(args.includeSql),
				}),
			),
	};

	const lineageTool: ToolDef = {
		name: 'dbt_lineage',
		description: 'Trace upstream and downstream dbt model lineage for an exact model name.',
		parameters: Type.Object({
			modelName: Type.String({ description: 'Exact dbt model name, for example dim_firms.' }),
			direction: Type.Optional(
				Type.String({ description: 'Lineage direction: upstream, downstream, or both. Defaults to both.' }),
			),
			depth: Type.Optional(Type.Number({ description: 'Maximum lineage depth. Defaults to 2.' })),
			includeSql: Type.Optional(Type.Boolean({ description: 'Include raw dbt SQL. Defaults to false.' })),
		}),
		execute: async (args) =>
			json(
				await modelLineage({
					manifestPath,
					modelName: asString(args.modelName, 'modelName'),
					direction: enumValue(args.direction, ['upstream', 'downstream', 'both'], 'direction'),
					depth: boundedInteger(args.depth, 'depth', 1, 5, 2),
					includeSql: Boolean(args.includeSql),
				}),
			),
	};

	const modelDetailsTool: ToolDef = {
		name: 'get_model_details',
		description:
			'Fetch exact dbt model details, including relation name, columns, immediate lineage, and optional SQL.',
		parameters: Type.Object({
			modelName: Type.String({ description: 'Exact dbt model name, for example fct_case_volume.' }),
			includeSql: Type.Optional(Type.Boolean({ description: 'Include raw dbt SQL. Defaults to false.' })),
			columnLimit: Type.Optional(Type.Number({ description: 'Maximum columns to return. Defaults to 80, max 300.' })),
		}),
		execute: async (args) =>
			json(
				await getModelDetails({
					manifestPath,
					modelName: asString(args.modelName, 'modelName'),
					includeSql: Boolean(args.includeSql),
					columnLimit: boundedInteger(args.columnLimit, 'columnLimit', 1, 300, 80),
				}),
			),
	};

	return [searchManifestTool, lineageTool, modelDetailsTool];
}

export function createMetabaseReadTools(config: AnalyticsToolConfig = {}): ToolDef[] {
	const metabaseCliScript = resolveRuntimePath(
		config.metabaseCliScript || process.env.METABASE_CLI_SCRIPT || DEFAULT_METABASE_CLI_SCRIPT,
	);

	const metabaseResearchTool: ToolDef = {
		name: 'metabase_research',
		description: 'Research existing Metabase cards by dbt model name or card id/name. Returns JSON.',
		parameters: Type.Object({
			model: Type.Optional(Type.String({ description: 'dbt model name to find cards for.' })),
			card: Type.Optional(Type.String({ description: 'Metabase card ID or case-insensitive name.' })),
			top: Type.Optional(Type.Number({ description: 'Maximum number of model results to return.' })),
			includeSql: Type.Optional(Type.Boolean({ description: 'Include native SQL in results.' })),
			refType: Type.Optional(
				Type.String({ description: 'Optional filter: bookmarked_card or frequently_run_card.' }),
			),
		}),
		execute: async (args, signal) => {
			const model = optionalString(args.model, 'model');
			const card = optionalString(args.card, 'card');
			if ((!model && !card) || (model && card)) {
				throw new Error('Provide exactly one of model or card.');
			}
			const refType = enumValue(args.refType, ['bookmarked_card', 'frequently_run_card'], 'refType');

			if ((config.metabaseHarness || process.env.METABASE_HARNESS) === 'python') {
				const commandArgs = [metabaseCliScript, 'research'];
				if (model) commandArgs.push('--model', model);
				if (card) commandArgs.push('--card', card);
				if (args.top !== undefined) commandArgs.push('--top', String(boundedInteger(args.top, 'top', 1, 50, 10)));
				if (args.includeSql) commandArgs.push('--sql');
				if (refType) commandArgs.push('--ref-type', refType);
				const result = await runPythonScript('python3', commandArgs, { signal });
				return result.stdout.trim() || json({ ok: true });
			}

			return json(
				await researchMetabase({
					model,
					card,
					top: args.top === undefined ? undefined : boundedInteger(args.top, 'top', 1, 50, 10),
					includeSql: Boolean(args.includeSql),
					refType,
					credentialMode: config.credentials?.bigQueryMode ?? 'service_account',
					userAccessToken: process.env.GOOGLE_USER_ACCESS_TOKEN,
				}),
			);
		},
	};

	const metabaseHelpTool: ToolDef = {
		name: 'metabase_help',
		description:
			'Progressively disclose compact Metabase card creation help. Use before non-table charts, field filters, or unfamiliar vizSettings.',
		parameters: Type.Object({
			topic: Type.Optional(
				Type.String({ description: 'Help topic: overview, viz_type, field_filters, or examples. Defaults to overview.' }),
			),
			vizType: Type.Optional(
				Type.String({
					description: 'Visualization type for topic=viz_type: table, bar, line, area, stacked-bar, stacked-area, or stacked-line.',
				}),
			),
		}),
		execute: async (args) =>
			json(
				getMetabaseHelp({
					topic: enumValue(args.topic, ['overview', 'viz_type', 'field_filters', 'examples'], 'topic') as
						| MetabaseHelpTopic
						| undefined,
					vizType: enumValue(
						args.vizType,
						['table', 'bar', 'line', 'area', 'stacked-bar', 'stacked-area', 'stacked-line'],
						'vizType',
					) as MetabaseVizType | undefined,
				}),
			),
	};

	return [metabaseHelpTool, metabaseResearchTool];
}

export function createAnalyticsTools(config: AnalyticsToolConfig = {}): ToolDef[] {
	const bqExploreScript = resolveRuntimePath(
		config.bqExploreScript || process.env.BQ_EXPLORE_SCRIPT || DEFAULT_BQ_EXPLORE_SCRIPT,
	);
	const metabaseCliScript = resolveRuntimePath(
		config.metabaseCliScript || process.env.METABASE_CLI_SCRIPT || DEFAULT_METABASE_CLI_SCRIPT,
	);
	const defaultMaxGb = config.maxGb ?? 1;

	const runBigQueryTool: ToolDef = {
		name: 'run_bigquery',
		description:
			'Run a SELECT or WITH BigQuery SQL query with dry-run cost guard. Returns structured metadata and a CSV result path, not row contents.',
		parameters: Type.Object({
			sql: Type.String({ description: 'SELECT or WITH SQL to execute.' }),
			maxGb: Type.Optional(
				Type.Number({
					description: `Maximum GB allowed by dry-run estimate. Defaults to ${defaultMaxGb}.`,
				}),
			),
			maxRows: Type.Optional(Type.Number({ description: 'Maximum rows to write to CSV. Defaults to 10000, max 100000.' })),
		}),
		execute: async (args, signal) => {
			const sql = asString(args.sql, 'sql');
			const maxGb = boundedNumber(args.maxGb, 'maxGb', 0.01, 100, defaultMaxGb);
			const maxRows = boundedInteger(args.maxRows, 'maxRows', 1, 100_000, 10_000);
			if ((config.bigQueryHarness || process.env.BIGQUERY_HARNESS) === 'python') {
				const result = await runPythonScript('python3', [bqExploreScript, sql, '--max-gb', String(maxGb)], {
					signal,
				});
				return json(parseBigQueryOutput(result.stdout, result.stderr));
			}

			const result = await runBigQuery({
				sql,
				maxGb,
				maxRows,
				credentialMode: config.credentials?.bigQueryMode ?? 'service_account',
				userAccessToken: process.env.GOOGLE_USER_ACCESS_TOKEN,
			});
			return json(result);
		},
	};

	const previewCsvTool: ToolDef = {
		name: 'preview_bq_csv',
		description: 'Read a bounded preview from a CSV file produced by run_bigquery.',
		parameters: Type.Object({
			path: Type.String({ description: 'CSV path returned by run_bigquery.' }),
			offset: Type.Optional(Type.Number({ description: 'Zero-based data-row offset. Defaults to 0.' })),
			limit: Type.Optional(Type.Number({ description: 'Maximum rows to return. Defaults to 25, max 100.' })),
		}),
		execute: async (args) =>
			json(
				await previewBigQueryCsv({
					csvPath: asString(args.path, 'path'),
					offset: boundedInteger(args.offset, 'offset', 0, 1_000_000, 0),
					limit: boundedInteger(args.limit, 'limit', 1, 100, 25),
				}),
			),
	};

	const distinctValuesTool: ToolDef = {
		name: 'get_distinct_values',
		description:
			'Discover common distinct values for a string/enum-like BigQuery column before writing filters or CASE logic.',
		parameters: Type.Object({
			relation: Type.String({
				description: 'BigQuery relation as dataset.table or project.dataset.table, usually from manifest relation_name.',
			}),
			column: Type.String({ description: 'Column name or safe nested field path.' }),
			whereSql: Type.Optional(Type.String({ description: 'Optional boolean SQL condition to narrow value discovery.' })),
			caseInsensitiveLike: Type.Optional(
				Type.String({
					description:
						"Optional case-insensitive LIKE pattern for the target column, for example '%mike morse%'. Implemented as LOWER(CAST(column AS STRING)) LIKE @pattern.",
				}),
			),
			limit: Type.Optional(Type.Number({ description: 'Maximum values to return. Defaults to 50, max 200.' })),
			maxGb: Type.Optional(
				Type.Number({
					description: `Maximum GB allowed by dry-run estimate. Defaults to ${defaultMaxGb}.`,
				}),
			),
		}),
		execute: async (args) =>
			json(
				await getDistinctValues({
					relation: asString(args.relation, 'relation'),
					column: asString(args.column, 'column'),
					whereSql: optionalString(args.whereSql, 'whereSql'),
					caseInsensitiveLike: optionalString(args.caseInsensitiveLike, 'caseInsensitiveLike'),
					limit: boundedInteger(args.limit, 'limit', 1, 200, 50),
					maxGb: boundedNumber(args.maxGb, 'maxGb', 0.01, 100, defaultMaxGb),
					credentialMode: config.credentials?.bigQueryMode ?? 'service_account',
					userAccessToken: process.env.GOOGLE_USER_ACCESS_TOKEN,
				}),
			),
	};

	const metabaseResearchTool: ToolDef = {
		name: 'metabase_research',
		description: 'Research existing Metabase cards by dbt model name or card id/name. Returns JSON.',
		parameters: Type.Object({
			model: Type.Optional(Type.String({ description: 'dbt model name to find cards for.' })),
			card: Type.Optional(Type.String({ description: 'Metabase card ID or case-insensitive name.' })),
			top: Type.Optional(Type.Number({ description: 'Maximum number of model results to return.' })),
			includeSql: Type.Optional(Type.Boolean({ description: 'Include native SQL in results.' })),
			refType: Type.Optional(
				Type.String({ description: 'Optional filter: bookmarked_card or frequently_run_card.' }),
			),
		}),
		execute: async (args, signal) => {
			const model = optionalString(args.model, 'model');
			const card = optionalString(args.card, 'card');
			if ((!model && !card) || (model && card)) {
				throw new Error('Provide exactly one of model or card.');
			}
			const refType = enumValue(args.refType, ['bookmarked_card', 'frequently_run_card'], 'refType');

			if ((config.metabaseHarness || process.env.METABASE_HARNESS) === 'python') {
				const commandArgs = [metabaseCliScript, 'research'];
				if (model) commandArgs.push('--model', model);
				if (card) commandArgs.push('--card', card);
				if (args.top !== undefined) commandArgs.push('--top', String(boundedInteger(args.top, 'top', 1, 50, 10)));
				if (args.includeSql) commandArgs.push('--sql');
				if (refType) commandArgs.push('--ref-type', refType);
				const result = await runPythonScript('python3', commandArgs, { signal });
				return result.stdout.trim() || json({ ok: true });
			}

			return json(
				await researchMetabase({
					model,
					card,
					top: args.top === undefined ? undefined : boundedInteger(args.top, 'top', 1, 50, 10),
					includeSql: Boolean(args.includeSql),
					refType,
					credentialMode: config.credentials?.bigQueryMode ?? 'service_account',
					userAccessToken: process.env.GOOGLE_USER_ACCESS_TOKEN,
				}),
			);
		},
	};

	const metabaseHelpTool: ToolDef = {
		name: 'metabase_help',
		description:
			'Progressively disclose compact Metabase card creation help. Use before non-table charts, field filters, or unfamiliar vizSettings.',
		parameters: Type.Object({
			topic: Type.Optional(
				Type.String({ description: 'Help topic: overview, viz_type, field_filters, or examples. Defaults to overview.' }),
			),
			vizType: Type.Optional(
				Type.String({
					description: 'Visualization type for topic=viz_type: table, bar, line, area, stacked-bar, stacked-area, or stacked-line.',
				}),
			),
		}),
		execute: async (args) =>
			json(
				getMetabaseHelp({
					topic: enumValue(args.topic, ['overview', 'viz_type', 'field_filters', 'examples'], 'topic') as
						| MetabaseHelpTopic
						| undefined,
					vizType: enumValue(
						args.vizType,
						['table', 'bar', 'line', 'area', 'stacked-bar', 'stacked-area', 'stacked-line'],
						'vizType',
					) as MetabaseVizType | undefined,
				}),
			),
	};

	const createMetabaseCardTool: ToolDef = {
		name: 'create_metabase_card',
		description:
			'Create a Metabase SQL card after the SQL has been validated. This tool is disabled unless allowMetabaseCreate is true.',
		parameters: Type.Object({
			vizType: Type.String({
				description: 'Visualization type: table, bar, line, area, stacked-bar, stacked-area, or stacked-line.',
			}),
			name: Type.String({ description: 'Card name.' }),
			query: Type.String({ description: 'Native SQL query for the card.' }),
			description: Type.Optional(Type.String({ description: 'Card description.' })),
			collectionId: Type.Optional(Type.Number({ description: 'Metabase collection ID.' })),
			databaseId: Type.Optional(Type.Number({ description: 'Metabase database ID.' })),
			dashboardId: Type.Optional(Type.Number({ description: 'Optional dashboard ID to pin the card to.' })),
			cacheTtl: Type.Optional(Type.Number({ description: 'Optional cache TTL in seconds.' })),
			vizSettings: Type.Optional(Type.String({ description: 'Visualization settings as a JSON string.' })),
			fieldFilters: Type.Optional(Type.String({ description: 'Field filters as a JSON string.' })),
		}),
		execute: async (args, signal) => {
			if (!config.allowMetabaseCreate) {
				throw new Error(
					'Metabase card creation is disabled for this run. Re-run with payload.allowMetabaseCreate=true after confirming the card should be created.',
				);
			}

			const vizType = enumValue(
				args.vizType,
				['table', 'bar', 'line', 'area', 'stacked-bar', 'stacked-area', 'stacked-line'],
				'vizType',
			);
			if (!vizType) throw new Error('vizType is required.');

			if ((config.metabaseHarness || process.env.METABASE_HARNESS) === 'python') {
				const commandArgs = [
					metabaseCliScript,
					'creation',
					vizType,
					'--name',
					asString(args.name, 'name'),
					'--query',
					asString(args.query, 'query'),
				];
				pushOptional(commandArgs, '--description', optionalString(args.description, 'description'));
				pushOptional(commandArgs, '--collection-id', optionalNumberString(args.collectionId, 'collectionId'));
				pushOptional(commandArgs, '--database-id', optionalNumberString(args.databaseId, 'databaseId'));
				pushOptional(commandArgs, '--dashboard-id', optionalNumberString(args.dashboardId, 'dashboardId'));
				pushOptional(commandArgs, '--cache-ttl', optionalNumberString(args.cacheTtl, 'cacheTtl'));
				pushOptional(commandArgs, '--viz-settings', optionalJsonString(args.vizSettings, 'vizSettings'));
				pushOptional(commandArgs, '--field-filters', optionalJsonString(args.fieldFilters, 'fieldFilters'));

				const result = await runPythonScript('python3', commandArgs, { signal });
				return result.stdout.trim() || json({ ok: true });
			}

			return json(
				await createMetabaseCard({
					vizType: vizType as MetabaseVizType,
					name: asString(args.name, 'name'),
					query: asString(args.query, 'query'),
					description: optionalString(args.description, 'description'),
					collectionId: optionalNumber(args.collectionId, 'collectionId'),
					databaseId: optionalNumber(args.databaseId, 'databaseId'),
					dashboardId: optionalNumber(args.dashboardId, 'dashboardId'),
					cacheTtl: optionalNumber(args.cacheTtl, 'cacheTtl'),
					vizSettings: optionalJsonObject(args.vizSettings, 'vizSettings'),
					fieldFilters: optionalJsonObject(args.fieldFilters, 'fieldFilters') as any,
					apiKey: process.env.METABASE_API_KEY,
				}),
			);
		},
	};

	return [
		...createManifestTools(config),
		runBigQueryTool,
		previewCsvTool,
		distinctValuesTool,
		metabaseHelpTool,
		metabaseResearchTool,
		createMetabaseCardTool,
	];
}

export function createBigQueryValidationTools(config: AnalyticsToolConfig = {}): ToolDef[] {
	const defaultMaxGb = config.maxGb ?? 1;
	const credentials = {
		credentialMode: config.credentials?.bigQueryMode ?? 'service_account',
		userAccessToken: process.env.GOOGLE_USER_ACCESS_TOKEN,
	};

	const validateQueryTool: ToolDef = {
		name: 'bq_validate_query',
		description:
			'Dry-run a SELECT/WITH BigQuery query to validate syntax, columns, and estimated bytes without returning rows.',
		parameters: Type.Object({
			sql: Type.String({ description: 'SELECT or WITH SQL to dry-run.' }),
			maxGb: Type.Optional(
				Type.Number({
					description: `Maximum GB allowed by dry-run estimate. Defaults to ${defaultMaxGb}.`,
				}),
			),
		}),
		execute: async (args) =>
			json(
				await validateBigQuery({
					sql: asString(args.sql, 'sql'),
					maxGb: boundedNumber(args.maxGb, 'maxGb', 0.01, 100, defaultMaxGb),
					...credentials,
				}),
			),
	};

	const rowCountTool: ToolDef = {
		name: 'bq_row_count',
		description:
			'Count rows in a BigQuery relation with an optional safe WHERE condition. Use for bounded validation, not broad discovery.',
		parameters: Type.Object({
			relation: Type.String({
				description: 'BigQuery relation as dataset.table or project.dataset.table, usually from manifest relation_name.',
			}),
			whereSql: Type.Optional(Type.String({ description: 'Optional boolean SQL condition.' })),
			maxGb: Type.Optional(
				Type.Number({
					description: `Maximum GB allowed by dry-run estimate. Defaults to ${defaultMaxGb}.`,
				}),
			),
		}),
		execute: async (args) =>
			json(
				await getRowCount({
					relation: asString(args.relation, 'relation'),
					whereSql: optionalString(args.whereSql, 'whereSql'),
					maxGb: boundedNumber(args.maxGb, 'maxGb', 0.01, 100, defaultMaxGb),
					...credentials,
				}),
			),
	};

	const dateRangeTool: ToolDef = {
		name: 'bq_date_range',
		description:
			'Get min/max and non-null counts for a date/timestamp-like BigQuery column with an optional WHERE condition.',
		parameters: Type.Object({
			relation: Type.String({
				description: 'BigQuery relation as dataset.table or project.dataset.table, usually from manifest relation_name.',
			}),
			column: Type.String({ description: 'Date/timestamp column name or safe nested field path.' }),
			whereSql: Type.Optional(Type.String({ description: 'Optional boolean SQL condition.' })),
			maxGb: Type.Optional(
				Type.Number({
					description: `Maximum GB allowed by dry-run estimate. Defaults to ${defaultMaxGb}.`,
				}),
			),
		}),
		execute: async (args) =>
			json(
				await getDateRange({
					relation: asString(args.relation, 'relation'),
					column: asString(args.column, 'column'),
					whereSql: optionalString(args.whereSql, 'whereSql'),
					maxGb: boundedNumber(args.maxGb, 'maxGb', 0.01, 100, defaultMaxGb),
					...credentials,
				}),
			),
	};

	const topValuesTool: ToolDef = {
		name: 'bq_top_values',
		description:
			'Find top distinct values and counts for a BigQuery column, optionally filtered with WHERE and case-insensitive LIKE.',
		parameters: Type.Object({
			relation: Type.String({
				description: 'BigQuery relation as dataset.table or project.dataset.table, usually from manifest relation_name.',
			}),
			column: Type.String({ description: 'Column name or safe nested field path.' }),
			whereSql: Type.Optional(Type.String({ description: 'Optional boolean SQL condition.' })),
			caseInsensitiveLike: Type.Optional(
				Type.String({
					description:
						"Optional case-insensitive LIKE pattern for the target column, for example '%mike morse%'.",
				}),
			),
			limit: Type.Optional(Type.Number({ description: 'Maximum values to return. Defaults to 50, max 200.' })),
			maxGb: Type.Optional(
				Type.Number({
					description: `Maximum GB allowed by dry-run estimate. Defaults to ${defaultMaxGb}.`,
				}),
			),
		}),
		execute: async (args) =>
			json(
				await getDistinctValues({
					relation: asString(args.relation, 'relation'),
					column: asString(args.column, 'column'),
					whereSql: optionalString(args.whereSql, 'whereSql'),
					caseInsensitiveLike: optionalString(args.caseInsensitiveLike, 'caseInsensitiveLike'),
					limit: boundedInteger(args.limit, 'limit', 1, 200, 50),
					maxGb: boundedNumber(args.maxGb, 'maxGb', 0.01, 100, defaultMaxGb),
					...credentials,
				}),
			),
	};

	return [validateQueryTool, rowCountTool, dateRangeTool, topValuesTool];
}

export function createExternalKnowledgeTools(config: AnalyticsToolConfig = {}): ToolDef[] {
	const defaultLimit = config.limits?.maxSearchResults ?? 10;

	const slackSearchTool: ToolDef = {
		name: 'slack_search',
		description:
			'Search Slack messages using the connected user token. Use for decisions, discussions, launch context, and recent operational context that may not be in docs.',
		parameters: Type.Object({
			query: Type.String({ description: 'Semantic Slack search query.' }),
			limit: Type.Optional(Type.Number({ description: `Maximum results. Defaults to ${defaultLimit}, max 20.` })),
			after: Type.Optional(Type.String({ description: 'Only results after this date, as YYYY-MM-DD.' })),
		}),
		execute: async (args) =>
			json(
				await searchSlack({
					query: asString(args.query, 'query'),
					limit: boundedInteger(args.limit, 'limit', 1, 20, defaultLimit),
					after: optionalString(args.after, 'after'),
					token: process.env.SLACK_USER_TOKEN,
				}),
			),
	};

	const slackReadThreadTool: ToolDef = {
		name: 'slack_read_thread',
		description:
			'Read the current Slack thread when this run was invoked from Slack, or read a specific thread when channel and threadTs are provided.',
		parameters: Type.Object({
			channel: Type.Optional(Type.String({ description: 'Slack channel ID. Defaults to SLACK_CHANNEL.' })),
			threadTs: Type.Optional(Type.String({ description: 'Slack thread timestamp. Defaults to SLACK_THREAD_TS.' })),
		}),
		execute: async (args) =>
			json(
				await readSlackThread({
					channel: optionalString(args.channel, 'channel'),
					threadTs: optionalString(args.threadTs, 'threadTs'),
					token: process.env.SLACK_BOT_TOKEN,
				}),
			),
	};

	const driveSearchTool: ToolDef = {
		name: 'gdrive_search',
		description:
			'Search Google Drive files using connected Google credentials. Use for docs, specs, planning documents, sheets, and user-provided Drive context.',
		parameters: Type.Object({
			text: Type.Optional(Type.String({ description: 'Full-text search query.' })),
			name: Type.Optional(Type.String({ description: 'File name contains filter.' })),
			mimeType: Type.Optional(Type.String({ description: 'Exact MIME type filter.' })),
			folder: Type.Optional(Type.String({ description: 'Parent folder ID.' })),
			after: Type.Optional(Type.String({ description: 'Modified after this ISO date/time.' })),
			limit: Type.Optional(Type.Number({ description: `Maximum files. Defaults to ${defaultLimit}, max 100.` })),
		}),
		execute: async (args) => {
			const text = optionalString(args.text, 'text');
			const name = optionalString(args.name, 'name');
			if (!text && !name) throw new Error('Provide at least one of text or name.');
			return json(
				await searchDrive({
					text,
					name,
					mimeType: optionalString(args.mimeType, 'mimeType'),
					folder: optionalString(args.folder, 'folder'),
					after: optionalString(args.after, 'after'),
					limit: boundedInteger(args.limit, 'limit', 1, 100, defaultLimit),
					token: process.env.GOOGLE_USER_ACCESS_TOKEN,
				}),
			);
		},
	};

	const driveListTool: ToolDef = {
		name: 'gdrive_list',
		description: 'List files in a Google Drive folder. Defaults to the current user root folder.',
		parameters: Type.Object({
			folderId: Type.Optional(Type.String({ description: 'Folder ID. Defaults to root.' })),
			limit: Type.Optional(Type.Number({ description: `Maximum files. Defaults to ${defaultLimit}, max 100.` })),
		}),
		execute: async (args) =>
			json(
				await listDriveFolder({
					folderId: optionalString(args.folderId, 'folderId'),
					limit: boundedInteger(args.limit, 'limit', 1, 100, defaultLimit),
					token: process.env.GOOGLE_USER_ACCESS_TOKEN,
				}),
			),
	};

	const driveReadTool: ToolDef = {
		name: 'gdrive_read',
		description:
			'Read a Google Drive file by ID. Google Docs/Sheets/Slides are exported to text or CSV; text-like files are read directly; binary files return metadata.',
		parameters: Type.Object({
			fileId: Type.String({ description: 'Google Drive file ID.' }),
			maxBytes: Type.Optional(Type.Number({ description: 'Maximum content bytes to return. Defaults to 100000, max 500000.' })),
		}),
		execute: async (args) =>
			json(
				await readDriveFile({
					fileId: asString(args.fileId, 'fileId'),
					maxBytes: boundedInteger(args.maxBytes, 'maxBytes', 1, 500_000, 100_000),
					token: process.env.GOOGLE_USER_ACCESS_TOKEN,
				}),
			),
	};

	const driveDownloadTool: ToolDef = {
		name: 'gdrive_download',
		description: 'Download or export a Google Drive file to local /tmp for processing.',
		parameters: Type.Object({
			fileId: Type.String({ description: 'Google Drive file ID.' }),
			outputPath: Type.Optional(Type.String({ description: 'Optional output path. Defaults to /tmp/<file name>.' })),
		}),
		execute: async (args) =>
			json(
				await downloadDriveFile({
					fileId: asString(args.fileId, 'fileId'),
					outputPath: optionalString(args.outputPath, 'outputPath'),
					token: process.env.GOOGLE_USER_ACCESS_TOKEN,
				}),
			),
	};

	const driveCreateTool: ToolDef = {
		name: 'gdrive_create',
		description:
			'Create a small text-like file in Google Drive. Disabled unless the run policy allows Google Drive writes.',
		parameters: Type.Object({
			name: Type.String({ description: 'File name.' }),
			content: Type.Optional(Type.String({ description: 'File content. Defaults to empty.' })),
			mimeType: Type.Optional(Type.String({ description: 'MIME type. Defaults to text/plain.' })),
			folder: Type.Optional(Type.String({ description: 'Parent folder ID.' })),
		}),
		execute: async (args) => {
			if (!config.allowGoogleDriveWrite) throw new Error('Google Drive writes are disabled for this run.');
			return json(
				await createDriveFile({
					name: asString(args.name, 'name'),
					content: optionalString(args.content, 'content'),
					mimeType: optionalString(args.mimeType, 'mimeType'),
					folder: optionalString(args.folder, 'folder'),
					token: process.env.GOOGLE_USER_ACCESS_TOKEN,
				}),
			);
		},
	};

	const driveUploadTool: ToolDef = {
		name: 'gdrive_upload',
		description: 'Upload a local file to Google Drive. Disabled unless the run policy allows Google Drive writes.',
		parameters: Type.Object({
			path: Type.String({ description: 'Local file path to upload.' }),
			name: Type.Optional(Type.String({ description: 'Drive file name. Defaults to basename.' })),
			mimeType: Type.Optional(Type.String({ description: 'MIME type override.' })),
			folder: Type.Optional(Type.String({ description: 'Parent folder ID.' })),
		}),
		execute: async (args) => {
			if (!config.allowGoogleDriveWrite) throw new Error('Google Drive writes are disabled for this run.');
			return json(
				await uploadDriveFile({
					path: asString(args.path, 'path'),
					name: optionalString(args.name, 'name'),
					mimeType: optionalString(args.mimeType, 'mimeType'),
					folder: optionalString(args.folder, 'folder'),
					token: process.env.GOOGLE_USER_ACCESS_TOKEN,
				}),
			);
		},
	};

	return [
		slackSearchTool,
		slackReadThreadTool,
		driveSearchTool,
		driveListTool,
		driveReadTool,
		driveDownloadTool,
		driveCreateTool,
		driveUploadTool,
	];
}

export function createJiraAutomationTools(config: AnalyticsToolConfig = {}): ToolDef[] {
	const jiraTaxonomyTool: ToolDef = {
		name: 'jira_taxonomy',
		description:
			'List known product tags, squad slugs, and Jira project keys from jira-automation-api.',
		parameters: Type.Object({}),
		execute: async () => json(await getJiraTaxonomy()),
	};

	const jiraScopeTool: ToolDef = {
		name: 'jira_scope',
		description:
			'Resolve a product tag or squad slug to related GitHub repos and Jira projects. Provide exactly one of product or squad.',
		parameters: Type.Object({
			product: Type.Optional(Type.String({ description: 'Product tag, for example mdc.' })),
			squad: Type.Optional(Type.String({ description: 'Squad slug, for example doc-gen.' })),
		}),
		execute: async (args) =>
			json(
				await getJiraScope({
					product: optionalString(args.product, 'product'),
					squad: optionalString(args.squad, 'squad'),
				}),
			),
	};

	const jiraQueryTool: ToolDef = {
		name: 'jira_history_query',
		description:
			'Ask jira-automation-api a natural-language engineering history question over GitHub PRs, Jira tickets, or both.',
		parameters: Type.Object({
			question: Type.String({ description: 'Question to answer from PR/Jira history.' }),
			source: Type.Optional(Type.String({ description: 'auto, pr, jira, or both. Defaults to auto.' })),
			repo: Type.Optional(Type.String({ description: 'Optional GitHub repo, for example evenup-ai/lops-frontend.' })),
			startDate: Type.Optional(Type.String({ description: 'Optional ISO start date YYYY-MM-DD.' })),
			endDate: Type.Optional(Type.String({ description: 'Optional ISO end date YYYY-MM-DD.' })),
			limit: Type.Optional(Type.Number({ description: 'Maximum source records to search. Defaults to 50, max 200.' })),
		}),
		execute: async (args) =>
			json(
				await queryJiraHistory({
					question: asString(args.question, 'question'),
					source: enumValue(args.source, ['auto', 'pr', 'jira', 'both'], 'source'),
					repo: optionalString(args.repo, 'repo'),
					startDate: optionalString(args.startDate, 'startDate'),
					endDate: optionalString(args.endDate, 'endDate'),
					limit: boundedInteger(args.limit, 'limit', 1, 200, 50),
				}),
			),
	};

	const jiraCreateTicketTool: ToolDef = {
		name: 'jira_create_ticket',
		description:
			'Create a Jira ticket through jira-automation-api. Disabled unless workflow mutation is allowed for this run.',
		parameters: Type.Object({
			summary: Type.String({ description: 'Ticket summary.' }),
			description: Type.String({ description: 'Ticket body/description.' }),
			project: Type.Optional(Type.String({ description: 'Jira project key. Defaults to DA.' })),
			issueType: Type.Optional(Type.String({ description: 'Jira issue type. Defaults to Task.' })),
			confirmed: Type.Optional(Type.Boolean({ description: 'Set true only after the user confirmed creation.' })),
		}),
		execute: async (args) => {
			if (!config.allowWorkflowMutation) throw new Error('Workflow mutation is disabled for this run.');
			return json(
				await createJiraTicket({
					summary: asString(args.summary, 'summary'),
					description: asString(args.description, 'description'),
					project: optionalString(args.project, 'project'),
					issueType: optionalString(args.issueType, 'issueType'),
					confirmed: args.confirmed === undefined ? true : Boolean(args.confirmed),
				}),
			);
		},
	};

	const jiraCreatePrTool: ToolDef = {
		name: 'jira_create_pr',
		description:
			'Create a GitHub PR through jira-automation-api. Disabled unless workflow mutation is allowed for this run.',
		parameters: Type.Object({
			repo: Type.String({ description: 'GitHub repo, for example evenup-ai/lops-frontend.' }),
			title: Type.String({ description: 'PR title.' }),
			head: Type.String({ description: 'Branch name to open as PR head.' }),
			body: Type.String({ description: 'PR body.' }),
		}),
		execute: async (args) => {
			if (!config.allowWorkflowMutation) throw new Error('Workflow mutation is disabled for this run.');
			return json(
				await createJiraPr({
					repo: asString(args.repo, 'repo'),
					title: asString(args.title, 'title'),
					head: asString(args.head, 'head'),
					body: asString(args.body, 'body'),
				}),
			);
		},
	};

	return [jiraTaxonomyTool, jiraScopeTool, jiraQueryTool, jiraCreateTicketTool, jiraCreatePrTool];
}

export async function previewBigQueryCsv(input: { csvPath: string; offset: number; limit: number }) {
	const resolved = path.resolve(input.csvPath);
	const parsed = path.parse(resolved);
	if (parsed.dir !== '/tmp' || !parsed.base.startsWith('bq_result_') || parsed.ext !== '.csv') {
		throw new Error('preview_bq_csv only reads /tmp/bq_result_*.csv files produced by run_bigquery.');
	}

	const raw = await fs.readFile(resolved, 'utf8');
	const lines = raw.split(/\r?\n/).filter((line) => line.length > 0);
	const header = lines[0] ?? '';
	const rows = lines.slice(1 + input.offset, 1 + input.offset + input.limit);
	return {
		path: resolved,
		header,
		offset: input.offset,
		limit: input.limit,
		returned_rows: rows.length,
		rows,
	};
}

export function parseBigQueryOutput(stdout: string, stderr = '') {
	if (stderr.trim()) {
		return { ok: true, warning: stderr.trim(), ...parseBigQuerySummary(stdout) };
	}
	return { ok: true, ...parseBigQuerySummary(stdout) };
}

function parseBigQuerySummary(stdout: string) {
	const rows = stdout.match(/^Rows:\s*(.+)$/m)?.[1]?.trim();
	const bytesBilled = stdout.match(/^Bytes billed:\s*(.+)$/m)?.[1]?.trim();
	const columns = stdout.match(/^Columns:\s*(.+)$/m)?.[1]?.split(',').map((column) => column.trim());
	const resultPath = stdout.match(/^Results written to:\s*(.+)$/m)?.[1]?.trim();
	return {
		summary: stdout.trim(),
		rows,
		bytes_billed: bytesBilled,
		columns,
		result_path: resultPath,
	};
}

async function runPythonScript(
	file: string,
	args: string[],
	options: { signal?: AbortSignal } = {},
): Promise<{ stdout: string; stderr: string }> {
	try {
		const { stdout, stderr } = await execFileAsync(file, args, {
			env: process.env,
			encoding: 'utf8',
			maxBuffer: 64 * 1024 * 1024,
			signal: options.signal,
		});
		return { stdout, stderr };
	} catch (error: any) {
		const stdout = typeof error?.stdout === 'string' ? error.stdout : '';
		const stderr = typeof error?.stderr === 'string' ? error.stderr : '';
		const detail = [stdout.trim(), stderr.trim(), error?.message].filter(Boolean).join('\n');
		throw new Error(detail || 'Script execution failed.');
	}
}

function asString(value: unknown, name: string): string {
	if (typeof value !== 'string' || value.trim() === '') {
		throw new Error(`${name} must be a non-empty string.`);
	}
	return value;
}

function optionalString(value: unknown, name: string): string | undefined {
	if (value === undefined || value === null || value === '') return undefined;
	return asString(value, name);
}

function asStringArray(value: unknown, name: string): string[] {
	if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
		throw new Error(`${name} must be an array of strings.`);
	}
	return value;
}

function boundedInteger(
	value: unknown,
	name: string,
	min: number,
	max: number,
	defaultValue: number,
): number {
	if (value === undefined || value === null) return defaultValue;
	const number = boundedNumber(value, name, min, max, defaultValue);
	if (!Number.isInteger(number)) throw new Error(`${name} must be an integer.`);
	return number;
}

function boundedNumber(value: unknown, name: string, min: number, max: number, defaultValue: number): number {
	if (value === undefined || value === null) return defaultValue;
	if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
		throw new Error(`${name} must be a number between ${min} and ${max}.`);
	}
	return value;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], name: string): T | undefined {
	if (value === undefined || value === null || value === '') return undefined;
	if (typeof value !== 'string' || !allowed.includes(value as T)) {
		throw new Error(`${name} must be one of: ${allowed.join(', ')}.`);
	}
	return value as T;
}

function optionalNumberString(value: unknown, name: string): string | undefined {
	if (value === undefined || value === null) return undefined;
	return String(boundedInteger(value, name, 1, Number.MAX_SAFE_INTEGER, 1));
}

function optionalNumber(value: unknown, name: string): number | undefined {
	if (value === undefined || value === null) return undefined;
	return boundedInteger(value, name, 1, Number.MAX_SAFE_INTEGER, 1);
}

function optionalJsonString(value: unknown, name: string): string | undefined {
	const text = optionalString(value, name);
	if (!text) return undefined;
	JSON.parse(text);
	return text;
}

function optionalJsonObject(value: unknown, name: string): Record<string, unknown> | undefined {
	const text = optionalJsonString(value, name);
	if (!text) return undefined;
	const parsed = JSON.parse(text);
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new Error(`${name} must be a JSON object.`);
	}
	return parsed as Record<string, unknown>;
}

function pushOptional(args: string[], flag: string, value: string | undefined) {
	if (value !== undefined) args.push(flag, value);
}

function json(value: unknown): string {
	return JSON.stringify(value, null, 2);
}

function resolveRuntimePath(value: string): string {
	return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
}

export type { LineageDirection, ManifestSearchLogic, ManifestSearchType };
