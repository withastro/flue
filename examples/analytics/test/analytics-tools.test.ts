import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
	formatBytes,
	getDateRange,
	getDistinctValues,
	getRowCount,
	normalizeReadOnlyCondition,
	normalizeReadOnlySql,
	runBigQuery,
	validateBigQuery,
	writeBigQueryCsv,
} from '../.flue/lib/bigquery.ts';
import { readDriveFile, searchDrive } from '../.flue/lib/gdrive.ts';
import { getModelDetails, loadManifest, modelLineage, searchManifest } from '../.flue/lib/manifest.ts';
import {
	buildMetabaseCardPayload,
	createMetabaseCard,
	getMetabaseHelp,
	researchMetabase,
} from '../.flue/lib/metabase.ts';
import { readDocument, writeDocument } from '../.flue/lib/persistence/firestore.ts';
import { artifactLink, readObjectMetadata, writeObject } from '../.flue/lib/persistence/gcs.ts';
import {
	artifactObjectName,
	DEV_DBT_EXPLORER_BUCKET,
	DEV_DBT_EXPLORER_NAMESPACE,
	EVENUP_INTERNAL_TOOLS_PROJECT,
	getPersistenceConfig,
	reportObjectName,
} from '../.flue/lib/persistence/namespaces.ts';
import {
	createJiraPr,
	createJiraTicket,
	getJiraScope,
	getJiraTaxonomy,
	queryJiraHistory,
} from '../.flue/lib/jira.ts';
import { readSlackThread, searchSlack } from '../.flue/lib/slack.ts';
import { parseBigQueryOutput, previewBigQueryCsv } from '../.flue/lib/tools.ts';
import { createWaiterExplorationRequest } from '../.flue/lib/exploration.ts';
import { buildConversationLedger } from '../.flue/lib/conversation-ledger.ts';
import { analyticsToolset } from '../.flue/toolsets/analytics.ts';
import { dbtExplorerToolset } from '../.flue/toolsets/dbt-explorer.ts';
import { explorerToolset } from '../.flue/toolsets/explorer.ts';
import { createToolPolicy } from '../.flue/tools/policy.ts';
import { createArtifactPersistenceTools, createContextPersistenceTools } from '../.flue/tools/persistence.ts';
import {
	default as waiterAgent,
	buildFinalUserReply,
	buildPostflightUserReply,
	buildPreStationFollowup,
	createKitchenOrder,
	isUserVisibleReplySafe,
	shouldReturnBeforeStation,
	summarizeExplorerPreflightForWaiter,
} from '../.flue/agents/waiter.ts';
import { createSessionPlan, resolveTurnContext, shouldInvokeWaiter } from '../.flue/lib/session-plan.ts';
import { createKbTools, selectKbArticles } from '../.flue/tools/kb.ts';
import { createSourceCatalogTools } from '../.flue/tools/source-catalog.ts';
import { createWorkflowTemplateTools } from '../.flue/tools/workflow-templates.ts';
import { createProjectSkillTools } from '../.flue/tools/project-skills.ts';
import { evaluateLiveEvalResult, LIVE_EVAL_CASES } from '../scripts/live-evals.ts';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const manifestPath = path.join(testDir, 'fixtures/manifest.json');

type FakePromptCall = {
	harnessName: string;
	sessionName: string;
	prompt: string;
};

function createFakeFlueInit(
	responder: (call: FakePromptCall) => unknown,
): { init: any; calls: FakePromptCall[]; harnessNames: string[]; harnessOptions: Array<{ name: string; sandbox?: { disableTaskTool?: boolean } }> } {
	const calls: FakePromptCall[] = [];
	const harnessNames: string[] = [];
	const harnessOptions: Array<{ name: string; sandbox?: { disableTaskTool?: boolean } }> = [];
	const init = async (options: { name: string; sandbox?: { disableTaskTool?: boolean } }) => {
		harnessNames.push(options.name);
		harnessOptions.push(options);
		return {
			session: async (sessionName: string) => ({
				prompt: async (prompt: string) => {
					const call = { harnessName: options.name, sessionName, prompt };
					calls.push(call);
					return {
						data: responder(call),
						usage: { fake: true, harnessName: options.name },
					};
				},
			}),
		};
	};
	return { init, calls, harnessNames, harnessOptions };
}

describe('manifest search', () => {
	it('finds models by column and returns compact relation metadata', async () => {
		const result = await searchManifest({
			manifestPath,
			keywords: ['case count'],
			searchType: 'column',
		});

		expect(result).toEqual([
			expect.objectContaining({
				name: 'fct_case_volume',
				relation_name: 'evenup-bi.dbt_prod.fct_case_volume',
				matched_columns: [{ column: 'case_count', description: 'Number of cases.' }],
				matched_fields: ['column_name'],
				match_reason: 'keyword "case count" matched 1 column(s)',
			}),
		]);
	});

	it('falls back from AND to OR when multi-keyword search is empty', async () => {
		const result = await searchManifest({
			manifestPath,
			keywords: ['firm', 'attorney'],
		});

		expect(result).toEqual(
			expect.objectContaining({
				logic_used: 'or (and returned 0 results)',
			}),
		);
	});

	it('normalizes space-separated identifiers for model names', async () => {
		const result = await searchManifest({
			manifestPath,
			keywords: ['case volume'],
			searchType: 'name',
		});

		expect(result).toEqual([
			expect.objectContaining({
				name: 'fct_case_volume',
				matched_fields: ['name'],
			}),
		]);
	});

	it('truncates broad search results with match reasons', async () => {
		const tmpPath = path.join('/tmp', `manifest_many_${process.pid}.json`);
		const nodes = Object.fromEntries(
			Array.from({ length: 11 }, (_, index) => [
				`model.test.fct_case_${index}`,
				{
					resource_type: 'model',
					name: `fct_case_${index}`,
					description: 'Case model',
					database: 'db',
					schema: 'schema',
					alias: `fct_case_${index}`,
					original_file_path: `models/fct_case_${index}.sql`,
					columns: {},
				},
			]),
		);
		await fs.writeFile(tmpPath, JSON.stringify({ nodes }));

		const result = await searchManifest({ manifestPath: tmpPath, keywords: ['case'] });

		expect(result).toEqual(
			expect.objectContaining({
				truncated: true,
				total_matches: 11,
				top_10: expect.arrayContaining([
					expect.objectContaining({
						name: 'fct_case_0',
						matched_fields: ['name'],
						match_reason: 'keyword "case" matched model name',
					}),
				]),
			}),
		);
	});

	it('reloads manifest cache when the file changes', async () => {
		const tmpPath = path.join('/tmp', `manifest_cache_${process.pid}.json`);
		await fs.writeFile(
			tmpPath,
			JSON.stringify({
				nodes: {
					'model.test.first_model': {
						resource_type: 'model',
						name: 'first_model',
						description: 'First',
						columns: {},
					},
				},
			}),
		);
		expect(Object.keys((await loadManifest(tmpPath)).nodes ?? {})).toEqual(['model.test.first_model']);

		await new Promise((resolve) => setTimeout(resolve, 5));
		await fs.writeFile(
			tmpPath,
			JSON.stringify({
				nodes: {
					'model.test.second_model': {
						resource_type: 'model',
						name: 'second_model',
						description: 'Second model with longer content',
						columns: {},
					},
				},
			}),
		);

		expect(Object.keys((await loadManifest(tmpPath)).nodes ?? {})).toEqual(['model.test.second_model']);
	});

	it('loads already-normalized EvenUp manifest schemas as dbt_prod', async () => {
		const tmpPath = path.join('/tmp', `manifest_dev_schema_${process.pid}.json`);
		const outPath = path.join('/tmp', `manifest_dev_schema_${process.pid}.dbt_prod.json`);
		await fs.writeFile(
			tmpPath,
			JSON.stringify({
				nodes: {
					'model.test.dim_plaas_case': {
						resource_type: 'model',
						name: 'dim_plaas_case',
						description: 'PLAAS case dimension.',
						database: 'evenup-bi',
						schema: 'dbt_bgu',
						alias: 'dim_plaas_case',
						raw_code: 'select * from `evenup-bi.dbt_bgu.dim_plaas_case`',
						columns: {},
					},
				},
			}),
		);

		const preprocess = spawnSync('node', [
			path.join(testDir, '../scripts/preprocess-manifest.mjs'),
			'--input',
			tmpPath,
			'--output',
			outPath,
		], { encoding: 'utf8' });
		expect(preprocess.status).toBe(0);

		const manifest = await loadManifest(outPath);
		expect(manifest.nodes?.['model.test.dim_plaas_case']?.schema).toBe('dbt_prod');
		expect(manifest.nodes?.['model.test.dim_plaas_case']?.raw_code).toBe(
			'select * from `evenup-bi.dbt_prod.dim_plaas_case`',
		);

		const result = await searchManifest({
			manifestPath: outPath,
			keywords: ['plaas'],
			searchType: 'name',
		});

		expect(result).toEqual([
			expect.objectContaining({
				name: 'dim_plaas_case',
				relation_name: 'evenup-bi.dbt_prod.dim_plaas_case',
			}),
		]);
	});

});

describe('dbt lineage', () => {
	it('returns upstream models, root model, and depths', async () => {
		const result = await modelLineage({
			manifestPath,
			modelName: 'fct_case_volume',
			direction: 'upstream',
			depth: 1,
		});

		expect(result).toEqual([
			expect.objectContaining({ name: 'dim_firms', depth: -1 }),
			expect.objectContaining({ name: 'stg_cases', depth: -1 }),
			expect.objectContaining({ name: 'fct_case_volume', depth: 0 }),
		]);
	});
});

describe('dbt model details', () => {
	it('returns exact model columns and immediate lineage', async () => {
		const result = await getModelDetails({
			manifestPath,
			modelName: 'fct_case_volume',
			columnLimit: 2,
		});

		expect(result).toEqual(
			expect.objectContaining({
				name: 'fct_case_volume',
				relation_name: 'evenup-bi.dbt_prod.fct_case_volume',
				column_count: 3,
				columns_truncated: true,
				upstream_models: ['dim_firms', 'stg_cases'],
				downstream_models: [],
				columns: [
					{ name: 'month', description: 'Month of case creation.', type: undefined },
					{ name: 'firm_id', description: 'Firm identifier.', type: undefined },
				],
			}),
		);
	});

	it('returns a typed error for unknown model details', async () => {
		await expect(getModelDetails({ manifestPath, modelName: 'missing_model' })).resolves.toEqual({
			error: "Model 'missing_model' not found in manifest.",
		});
	});
});

describe('bigquery helpers', () => {
	it('accepts SELECT/WITH queries and strips a final semicolon', () => {
		expect(normalizeReadOnlySql('SELECT 1;')).toBe('SELECT 1');
		expect(normalizeReadOnlySql('WITH x AS (SELECT 1) SELECT * FROM x')).toBe(
			'WITH x AS (SELECT 1) SELECT * FROM x',
		);
	});

	it('rejects non-read-only and multi-statement SQL', () => {
		expect(() => normalizeReadOnlySql('DELETE FROM dataset.table')).toThrow('QUERY REJECTED');
		expect(() => normalizeReadOnlySql('SELECT 1; DROP TABLE dataset.table')).toThrow('multiple SQL statements');
		expect(() => normalizeReadOnlySql("SELECT 'DROP TABLE is just text'")).not.toThrow();
	});

	it('validates distinct-value where conditions separately from full SQL', () => {
		expect(normalizeReadOnlyCondition("status = 'DROP TABLE is just text'")).toBe(
			"status = 'DROP TABLE is just text'",
		);
		expect(() => normalizeReadOnlyCondition('SELECT 1')).toThrow('boolean condition');
		expect(() => normalizeReadOnlyCondition('status = 1; DROP TABLE x')).toThrow('multiple SQL statements');
	});

	it('formats bytes like the Python harness', () => {
		expect(formatBytes(500)).toBe('500.0 B');
		expect(formatBytes(1024 ** 2)).toBe('1.0 MB');
		expect(formatBytes(3 * 1024 ** 3)).toBe('3.0 GB');
	});

	it('writes bounded BigQuery CSV output with escaping', async () => {
		const csvPath = await writeBigQueryCsv({
			outputDir: '/tmp',
			now: new Date('2026-05-21T15:30:05Z'),
			columns: ['id', 'name', 'payload'],
			rows: [{ id: 1, name: 'Ada, Esq.', payload: { ok: true } }],
		});

		expect(csvPath).toMatch(/^\/tmp\/bq_result_\d{8}_\d{6}_\d+_\d{6}\.csv$/);
		await expect(fs.readFile(csvPath, 'utf8')).resolves.toContain('1,"Ada, Esq.","{""ok"":true}"');
	});

	it('does not overwrite same-second BigQuery CSV outputs', async () => {
		const now = new Date('2026-05-21T15:30:05Z');
		const firstPath = await writeBigQueryCsv({
			outputDir: '/tmp',
			now,
			columns: ['value'],
			rows: [{ value: 'first' }],
		});
		const secondPath = await writeBigQueryCsv({
			outputDir: '/tmp',
			now,
			columns: ['value'],
			rows: [{ value: 'second' }],
		});

		expect(firstPath).not.toBe(secondPath);
		await expect(fs.readFile(firstPath, 'utf8')).resolves.toContain('first');
		await expect(fs.readFile(secondPath, 'utf8')).resolves.toContain('second');
	});

	it('runs BigQuery through dry-run, byte guard, execution, and CSV writing with a fake client', async () => {
		const fakeClient = {
			async createQueryJob(options: Record<string, unknown>) {
				if (options.dryRun) {
					return [
						{
							metadata: { statistics: { totalBytesProcessed: 1024 } },
							async getMetadata() {
								return [this.metadata];
							},
							async getQueryResults() {
								return [[]];
							},
						},
					];
				}
				return [
					{
						metadata: { statistics: { query: { schema: { fields: [{ name: 'row_count' }] } } } },
						async getMetadata() {
							return [this.metadata];
						},
						async getQueryResults() {
							return [[{ row_count: 42 }]];
						},
					},
				];
			},
		};

		const result = await runBigQuery({
			sql: 'SELECT 42 AS row_count',
			maxGb: 1,
			maxRows: 10,
			projectId: 'test-project',
			outputDir: '/tmp',
			now: new Date('2026-05-21T15:30:05Z'),
			client: fakeClient,
		});

		expect(result).toEqual(
			expect.objectContaining({
				ok: true,
				rows: 1,
				bytes_processed: 1024,
				columns: ['row_count'],
				truncated: false,
				auth_mode: 'service_account',
				project_id: 'test-project',
			}),
		);
		await expect(fs.readFile(result.result_path, 'utf8')).resolves.toContain('42');
	});

	it('falls back from service account to user OAuth only on permission errors', async () => {
		const authModes: string[] = [];
		const makeClient = (mode: 'service_account' | 'user_oauth') => ({
			async createQueryJob(options: Record<string, unknown>) {
				authModes.push(mode);
				if (mode === 'service_account') {
					throw new Error('Access Denied: Project test-project: User does not have bigquery.jobs.create permission.');
				}
				if (options.dryRun) {
					return [
						{
							metadata: { statistics: { totalBytesProcessed: 512 } },
							async getMetadata() {
								return [this.metadata];
							},
							async getQueryResults() {
								return [[]];
							},
						},
					];
				}
				return [
					{
						metadata: { statistics: { query: { schema: { fields: [{ name: 'ok' }] } } } },
						async getMetadata() {
							return [this.metadata];
						},
						async getQueryResults() {
							return [[{ ok: true }]];
						},
					},
				];
			},
		});

		const result = await runBigQuery({
			sql: 'SELECT TRUE AS ok',
			maxGb: 1,
			projectId: 'test-project',
			outputDir: '/tmp',
			credentialMode: 'service_account_then_user_oauth',
			clientFactory: makeClient,
		});

		expect(authModes).toEqual(['service_account', 'user_oauth', 'user_oauth']);
		expect(result.auth_mode).toBe('user_oauth');
	});

	it('does not fall back to user OAuth on non-permission BigQuery errors', async () => {
		const authModes: string[] = [];
		const makeClient = (mode: 'service_account' | 'user_oauth') => ({
			async createQueryJob() {
				authModes.push(mode);
				throw new Error('Syntax error: Unexpected identifier');
			},
		});

		await expect(
			validateBigQuery({
				sql: 'SELECT bad FROM `evenup-bi.dbt_prod.table`',
				maxGb: 1,
				projectId: 'test-project',
				credentialMode: 'service_account_then_user_oauth',
				clientFactory: makeClient,
			}),
		).rejects.toThrow('Syntax error');
		expect(authModes).toEqual(['service_account']);
	});

	it('rejects BigQuery queries over maxGb before execution', async () => {
		const fakeClient = {
			async createQueryJob(options: Record<string, unknown>) {
				if (!options.dryRun) throw new Error('execution should not run');
				return [
					{
						metadata: { statistics: { totalBytesProcessed: 2 * 1024 ** 3 } },
						async getMetadata() {
							return [this.metadata];
						},
						async getQueryResults() {
							return [[]];
						},
					},
				];
			},
		};

		await expect(
			runBigQuery({
				sql: 'SELECT * FROM huge_table',
				maxGb: 1,
				projectId: 'test-project',
				client: fakeClient,
			}),
		).rejects.toThrow('QUERY TOO LARGE');
	});

	it('discovers distinct values with a generated grouped query', async () => {
		const issuedQueries: Array<Record<string, unknown>> = [];
		const fakeClient = {
			async createQueryJob(options: Record<string, unknown>) {
				issuedQueries.push(options);
				if (options.dryRun) {
					return [
						{
							metadata: { statistics: { totalBytesProcessed: 2048 } },
							async getMetadata() {
								return [this.metadata];
							},
							async getQueryResults() {
								return [[]];
							},
						},
					];
				}
				return [
					{
						metadata: {},
						async getMetadata() {
							return [this.metadata];
						},
						async getQueryResults() {
							return [[{ value: 'settled', row_count: 12 }, { value: 'open', row_count: 4 }]];
						},
					},
				];
			},
		};

		const result = await getDistinctValues({
			relation: 'evenup-bi.dbt_prod.dim_matters',
			column: 'status',
			whereSql: 'created_at >= DATE("2026-01-01")',
			caseInsensitiveLike: '%SETT%',
			maxGb: 1,
			limit: 25,
			projectId: 'test-project',
			client: fakeClient,
		});

		expect(issuedQueries[0]?.query).toContain('SELECT CAST(`status` AS STRING) AS value');
		expect(issuedQueries[0]?.query).toContain('FROM `evenup-bi.dbt_prod.dim_matters`');
		expect(issuedQueries[0]?.query).toContain('AND (created_at >= DATE("2026-01-01"))');
		expect(issuedQueries[0]?.query).toContain('AND LOWER(CAST(`status` AS STRING)) LIKE @case_insensitive_like');
		expect(issuedQueries[0]?.params).toEqual({ case_insensitive_like: '%sett%' });
		expect(issuedQueries[1]?.params).toEqual({ case_insensitive_like: '%sett%' });
		expect(result).toEqual(
			expect.objectContaining({
				ok: true,
				values: [
					{ value: 'settled', row_count: 12 },
					{ value: 'open', row_count: 4 },
				],
				bytes_processed: 2048,
				limit: 25,
				sql: expect.stringContaining('LOWER(CAST(`status` AS STRING)) LIKE @case_insensitive_like'),
			}),
		);
	});

	it('dry-runs BigQuery validation without executing rows', async () => {
		const issuedQueries: Array<Record<string, unknown>> = [];
		const fakeClient = {
			async createQueryJob(options: Record<string, unknown>) {
				issuedQueries.push(options);
				if (!options.dryRun) throw new Error('execution should not run');
				return [
					{
						metadata: {
							statistics: {
								query: {
									totalBytesProcessed: 4096,
									schema: { fields: [{ name: 'case_id' }, { name: 'created_at' }] },
								},
							},
						},
						async getMetadata() {
							return [this.metadata];
						},
						async getQueryResults() {
							return [[]];
						},
					},
				];
			},
		};

		const result = await validateBigQuery({
			sql: 'SELECT case_id, created_at FROM `evenup-bi.dbt_prod.dim_cases`',
			maxGb: 1,
			projectId: 'test-project',
			client: fakeClient,
		});

		expect(issuedQueries).toHaveLength(1);
		expect(issuedQueries[0]).toEqual(
			expect.objectContaining({
				dryRun: true,
				useQueryCache: false,
			}),
		);
		expect(result).toEqual(
			expect.objectContaining({
				ok: true,
				bytes_processed: 4096,
				columns: ['case_id', 'created_at'],
				project_id: 'test-project',
			}),
		);
	});

	it('runs bounded BigQuery row count and date range helpers', async () => {
		const issuedQueries: Array<Record<string, unknown>> = [];
		const fakeClient = {
			async createQueryJob(options: Record<string, unknown>) {
				issuedQueries.push(options);
				if (options.dryRun) {
					return [
						{
							metadata: { statistics: { totalBytesProcessed: 8192 } },
							async getMetadata() {
								return [this.metadata];
							},
							async getQueryResults() {
								return [[]];
							},
						},
					];
				}
				const query = String(options.query);
				return [
					{
						metadata: {},
						async getMetadata() {
							return [this.metadata];
						},
						async getQueryResults() {
							if (query.includes('MIN(`created_at`)')) {
								return [[{ min_value: '2026-01-01', max_value: '2026-05-01', non_null_count: 9, row_count: 10 }]];
							}
							return [[{ row_count: 10 }]];
						},
					},
				];
			},
		};

		const rowCount = await getRowCount({
			relation: 'evenup-bi.dbt_prod.dim_cases',
			whereSql: 'created_at >= DATE("2026-01-01")',
			maxGb: 1,
			projectId: 'test-project',
			client: fakeClient,
		});
		const dateRange = await getDateRange({
			relation: 'evenup-bi.dbt_prod.dim_cases',
			column: 'created_at',
			whereSql: 'status = "active"',
			maxGb: 1,
			projectId: 'test-project',
			client: fakeClient,
		});

		expect(issuedQueries[0]?.query).toContain('SELECT COUNT(*) AS row_count');
		expect(issuedQueries[0]?.query).toContain('WHERE created_at >= DATE("2026-01-01")');
		expect(rowCount).toEqual(expect.objectContaining({ row_count: 10, bytes_processed: 8192 }));
		expect(issuedQueries[2]?.query).toContain('MIN(`created_at`) AS min_value');
		expect(issuedQueries[2]?.query).toContain('AND (status = "active")');
		expect(dateRange).toEqual(
			expect.objectContaining({
				min_value: '2026-01-01',
				max_value: '2026-05-01',
				non_null_count: 9,
				row_count: 10,
			}),
		);
	});

	it('rejects unsafe distinct-value identifiers', async () => {
		await expect(
			getDistinctValues({
				relation: 'dataset.table;DROP',
				column: 'status',
				maxGb: 1,
				client: { async createQueryJob() { return []; } },
			}),
		).rejects.toThrow('relation');
		await expect(
			getDistinctValues({
				relation: 'dataset.table',
				column: 'status); DROP TABLE x',
				maxGb: 1,
				client: { async createQueryJob() { return []; } },
			}),
		).rejects.toThrow('column');
	});

	it('parses bq_explore summary output', () => {
		expect(
			parseBigQueryOutput(
				[
					'Query completed',
					'Rows: 1,234',
					'Bytes billed: 45.2 MB',
					'Columns: case_id, matter_id',
					'Results written to: /tmp/bq_result_20240226_143022.csv',
				].join('\n'),
			),
		).toEqual({
			ok: true,
			summary: expect.stringContaining('Query completed'),
			rows: '1,234',
			bytes_billed: '45.2 MB',
			columns: ['case_id', 'matter_id'],
			result_path: '/tmp/bq_result_20240226_143022.csv',
		});
	});

	it('previews only generated BigQuery result CSV files', async () => {
		const csvPath = `/tmp/bq_result_test_${process.pid}.csv`;
		await fs.writeFile(csvPath, 'id,name\n1,Ada\n2,Grace\n3,Katherine\n');

		await expect(previewBigQueryCsv({ csvPath, offset: 1, limit: 1 })).resolves.toEqual({
			path: csvPath,
			header: 'id,name',
			offset: 1,
			limit: 1,
			returned_rows: 1,
			rows: ['2,Grace'],
		});

		await expect(
			previewBigQueryCsv({ csvPath: `/tmp/not_bq_${process.pid}.csv`, offset: 0, limit: 1 }),
		).rejects.toThrow('/tmp/bq_result_*.csv');
	});

	it('searches Slack with a user token and returns compact message results', async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
			calls.push({ url: String(url), init });
			return new Response(
				JSON.stringify({
					ok: true,
					results: {
						messages: [
							{
								channel_name: 'product',
								author_name: 'Ada',
								content: 'CLP launch decision',
								permalink: 'https://slack.test/archives/C1/p1',
								reply_count: 2,
							},
						],
					},
				}),
			);
		};

		const result = await searchSlack({
			query: 'clp launch',
			limit: 5,
			after: '2026-01-01',
			token: 'xoxp-test',
			fetchImpl: fetchImpl as any,
		});

		expect(calls[0]?.url).toBe('https://slack.com/api/assistant.search.context');
		expect(calls[0]?.init?.headers).toEqual(
			expect.objectContaining({ Authorization: 'Bearer xoxp-test' }),
		);
		expect(JSON.parse(String(calls[0]?.init?.body))).toEqual(
			expect.objectContaining({ query: 'clp launch', limit: 5, after: 1767225600 }),
		);
		expect(result.results).toEqual([
			{
				channel: 'product',
				author: 'Ada',
				text: 'CLP launch decision',
				permalink: 'https://slack.test/archives/C1/p1',
				reply_count: 2,
			},
		]);
	});

	it('reads Slack threads and resolves human display names', async () => {
		const fetchImpl = async (url: string | URL | Request) => {
			const text = String(url);
			if (text.includes('conversations.replies')) {
				return new Response(
					JSON.stringify({
						ok: true,
						messages: [
							{ user: 'U1', text: 'First', ts: '1.0' },
							{ bot_id: 'B1', text: 'skip bot' },
						],
					}),
				);
			}
			return new Response(JSON.stringify({ ok: true, user: { display_name: 'Grace' } }));
		};

		const result = await readSlackThread({
			channel: 'C1',
			threadTs: '1.0',
			token: 'xoxb-test',
			fetchImpl: fetchImpl as any,
		});

		expect(result.messages).toEqual([{ author: 'Grace', user_id: 'U1', text: 'First', ts: '1.0' }]);
	});

	it('searches Google Drive with escaped query clauses', async () => {
		const calls: string[] = [];
		const fetchImpl = async (url: string | URL | Request) => {
			calls.push(String(url));
			return new Response(
				JSON.stringify({
					files: [
						{
							id: 'file-1',
							name: "PM's spec",
							mimeType: 'application/vnd.google-apps.document',
							modifiedTime: '2026-01-02T00:00:00Z',
						},
					],
				}),
			);
		};

		const result = await searchDrive({
			text: "PM's spec",
			name: 'CLP',
			limit: 3,
			token: 'google-token',
			fetchImpl: fetchImpl as any,
		});

		const url = new URL(calls[0]!);
		expect(url.searchParams.get('pageSize')).toBe('3');
		expect(url.searchParams.get('q')).toContain("fullText contains 'PM\\'s spec'");
		expect(url.searchParams.get('q')).toContain("name contains 'CLP'");
		expect(result.files[0]).toEqual(
			expect.objectContaining({
				id: 'file-1',
				name: "PM's spec",
				mimeType: 'application/vnd.google-apps.document',
			}),
		);
	});

	it('reads Google Docs by exporting to text', async () => {
		const fetchImpl = async (url: string | URL | Request) => {
			const text = String(url);
			if (text.includes('/export?')) return new Response('hello doc');
			return new Response(
				JSON.stringify({
					id: 'doc-1',
					name: 'Decision doc',
					mimeType: 'application/vnd.google-apps.document',
				}),
			);
		};

		const result = await readDriveFile({
			fileId: 'doc-1',
			token: 'google-token',
			fetchImpl: fetchImpl as any,
		});

		expect(result).toEqual(
			expect.objectContaining({
				ok: true,
				exported_as: 'text/plain',
				content: 'hello doc',
				truncated: false,
			}),
		);
	});

	it('researches Metabase model usage with a parameterized BigQuery query', async () => {
		const issuedQueries: Array<Record<string, unknown>> = [];
		const fakeClient = {
			async query(options: Record<string, unknown>) {
				issuedQueries.push(options);
				return [
					[
						{
							card_id: 42,
							card_name: 'Case Volume',
							card_url: 'https://metabase.test/question/42',
							ref_type: 'bookmarked_card',
						},
					],
				];
			},
		};

		const result = await researchMetabase({
			model: 'dim_matters',
			top: 3,
			includeSql: true,
			refType: 'bookmarked_card',
			projectId: 'test-project',
			dataset: 'dbt_prod',
			client: fakeClient,
		});

		expect(issuedQueries[0]?.query).toContain('mart_dbt_model_metabase_usage');
		expect(issuedQueries[0]?.query).toContain('native_query_sql');
		expect(issuedQueries[0]?.query).toContain('LIMIT 3');
		expect(issuedQueries[0]?.params).toEqual({
			model_name: 'dim_matters',
			ref_type: 'bookmarked_card',
		});
		expect(result).toEqual(
			expect.objectContaining({
				ok: true,
				mode: 'model',
				rows: [expect.objectContaining({ card_id: 42, card_name: 'Case Volume' })],
			}),
		);
	});

	it('builds Metabase card payloads with stacked settings and template tags', () => {
		const payload = buildMetabaseCardPayload({
			vizType: 'stacked-bar',
			name: 'Firm Volume',
			query: 'SELECT month, firm_name, case_count FROM table WHERE [[AND {{firm_name}}]]',
			vizSettings: { 'graph.dimensions': ['month', 'firm_name'], 'graph.metrics': ['case_count'] },
			fieldFilters: { firm_name: { field_id: 123, alias: 'm.firm_name', widget_type: 'string/contains' } },
		});

		expect(payload).toEqual(
			expect.objectContaining({
				name: 'Firm Volume',
				collection_id: 2260,
				display: 'bar',
				visualization_settings: expect.objectContaining({
					'stackable.stack_type': 'stacked',
					'graph.metrics': ['case_count'],
				}),
			}),
		);
		expect(payload.dataset_query.native['template-tags'].firm_name).toEqual(
			expect.objectContaining({
				name: 'firm_name',
				type: 'dimension',
				'widget-type': 'string/contains',
				dimension: ['field', 123, null],
				alias: 'm.firm_name',
			}),
		);
	});

	it('progressively discloses Metabase help by topic', () => {
		const overview = getMetabaseHelp({ topic: 'overview' });
		expect(overview).toEqual(
			expect.objectContaining({
				ok: true,
				topic: 'overview',
				viz_types: expect.arrayContaining([
					expect.objectContaining({ vizType: 'table' }),
					expect.objectContaining({ vizType: 'stacked-bar' }),
				]),
			}),
		);
		expect(JSON.stringify(overview)).not.toContain('field_filter_shapes');

		const bar = getMetabaseHelp({ topic: 'viz_type', vizType: 'bar' });
		expect(bar).toEqual(
			expect.objectContaining({
				ok: true,
				topic: 'viz_type',
				vizType: 'bar',
				display: 'bar',
				example_viz_settings: expect.objectContaining({
					'graph.dimensions': ['month'],
					'graph.metrics': ['case_count'],
				}),
			}),
		);

		const fieldFilters = getMetabaseHelp({ topic: 'field_filters' });
		expect(fieldFilters).toEqual(
			expect.objectContaining({
				topic: 'field_filters',
				field_filter_shapes: expect.objectContaining({
					with_alias_and_widget: expect.any(Object),
				}),
			}),
		);
	});

	it('creates Metabase cards through the API without exposing the API key', async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
			calls.push({ url: String(url), init });
			return new Response(JSON.stringify({ id: 99, name: 'Created Card' }));
		};

		const result = await createMetabaseCard({
			vizType: 'table',
			name: 'Created Card',
			query: 'SELECT 1 AS ok',
			apiKey: 'mb-test',
			metabaseUrl: 'https://metabase.test',
			fetchImpl: fetchImpl as any,
		});

		expect(calls[0]?.url).toBe('https://metabase.test/api/card');
		expect(calls[0]?.init?.headers).toEqual(
			expect.objectContaining({
				'x-api-key': 'mb-test',
				'Content-Type': 'application/json',
			}),
		);
		expect(JSON.parse(String(calls[0]?.init?.body))).toEqual(
			expect.objectContaining({
				name: 'Created Card',
				display: 'table',
			}),
		);
		expect(result).toEqual(
			expect.objectContaining({
				ok: true,
				card_id: 99,
				url: 'https://metabase.test/question/99',
			}),
		);
	});

	it('calls jira-automation-api read-only endpoints', async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
			calls.push({ url: String(url), init });
			return new Response(JSON.stringify({ ok: true, url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null }));
		};

		await getJiraTaxonomy({ baseUrl: 'https://jira.test', fetchImpl: fetchImpl as any });
		await getJiraScope({ product: 'mdc', baseUrl: 'https://jira.test', fetchImpl: fetchImpl as any });
		const query = await queryJiraHistory({
			question: 'what changed in CLP?',
			source: 'both',
			repo: 'evenup-ai/lops-frontend',
			limit: 10,
			baseUrl: 'https://jira.test',
			fetchImpl: fetchImpl as any,
		});

		expect(calls[0]?.url).toBe('https://jira.test/knowledge/taxonomy');
		expect(calls[1]?.url).toBe('https://jira.test/knowledge/product-scope?product=mdc');
		expect(calls[2]?.url).toBe('https://jira.test/query');
		expect(calls[2]?.init?.method).toBe('POST');
		expect(query.body).toEqual(
			expect.objectContaining({
				question: 'what changed in CLP?',
				source: 'both',
				repo: 'evenup-ai/lops-frontend',
				limit: 10,
			}),
		);
	});

	it('calls jira-automation-api workflow mutation endpoints', async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
			calls.push({ url: String(url), init });
			return new Response(JSON.stringify({ ok: true, body: JSON.parse(String(init?.body)) }));
		};

		const ticket = await createJiraTicket({
			summary: '[Amplitude] Test event',
			description: 'Event brief',
			baseUrl: 'https://jira.test',
			fetchImpl: fetchImpl as any,
		});
		const pr = await createJiraPr({
			repo: 'evenup-ai/lops-frontend',
			title: 'DA-123: Test event',
			head: 'bill/amplitude-test',
			body: 'Event brief',
			baseUrl: 'https://jira.test',
			fetchImpl: fetchImpl as any,
		});

		expect(calls[0]?.url).toBe('https://jira.test/create-ticket');
		expect(ticket.body).toEqual(
			expect.objectContaining({
				summary: '[Amplitude] Test event',
				project: 'DA',
				issue_type: 'Task',
				confirmed: true,
			}),
		);
		expect(calls[1]?.url).toBe('https://jira.test/create-pr');
		expect(pr.body).toEqual(
			expect.objectContaining({
				repo: 'evenup-ai/lops-frontend',
				title: 'DA-123: Test event',
				head: 'bill/amplitude-test',
			}),
		);
	});
});

describe('tool policies and toolsets', () => {
	it('restricts Slack to service-account style access by default', () => {
		const policy = createToolPolicy({ source: 'slack' });

		expect(policy.credentials.bigQueryMode).toBe('service_account');
		expect(policy.permissions.allowSensitiveBigQuery).toBe(false);
		expect(policy.permissions.allowContextWrite).toBe(false);
	});

	it('uses service-account BigQuery access for web policy when no user token is present', () => {
		const policy = createToolPolicy({ source: 'web', allowMetabaseCreate: true, maxGb: 2 });

		expect(policy.credentials.bigQueryMode).toBe('service_account');
		expect(policy.permissions.allowSensitiveBigQuery).toBe(true);
		expect(policy.permissions.allowMetabaseCreate).toBe(true);
		expect(policy.limits.maxBigQueryGb).toBe(2);
	});

	it('tries service account before user BigQuery access for web policy when a user token is present', () => {
		const original = process.env.GOOGLE_USER_ACCESS_TOKEN;
		process.env.GOOGLE_USER_ACCESS_TOKEN = 'token';
		try {
			const policy = createToolPolicy({ source: 'web' });
			expect(policy.credentials.bigQueryMode).toBe('service_account_then_user_oauth');
		} finally {
			if (original === undefined) delete process.env.GOOGLE_USER_ACCESS_TOKEN;
			else process.env.GOOGLE_USER_ACCESS_TOKEN = original;
		}
	});

	it('allows explicit workflow mutation override for omni-style runs', () => {
		const policy = createToolPolicy({ source: 'slack', allowWorkflowMutation: true });

		expect(policy.permissions.allowWorkflowMutation).toBe(true);
		expect(policy.permissions.allowContextWrite).toBe(false);
	});

	it('keeps explorer read-only with manifest and KB docs tools', () => {
		const policy = createToolPolicy({ source: 'cli' });

		expect(explorerToolset(policy).map((tool) => tool.name)).toEqual([
			'search_manifest',
			'dbt_lineage',
			'get_model_details',
			'read_source_catalog',
			'read_kb_index',
			'read_kb_article',
			'project_skill_list',
			'project_skill_read',
			'bq_validate_query',
			'bq_row_count',
			'bq_date_range',
			'bq_top_values',
			'metabase_help',
			'metabase_research',
			'slack_search',
			'slack_read_thread',
			'gdrive_search',
			'gdrive_list',
			'gdrive_read',
			'gdrive_download',
			'gdrive_create',
			'gdrive_upload',
			'jira_taxonomy',
			'jira_scope',
			'jira_history_query',
			'jira_create_ticket',
			'jira_create_pr',
		]);
		expect(analyticsToolset(policy).map((tool) => tool.name)).toEqual([
			'search_manifest',
			'dbt_lineage',
			'get_model_details',
			'run_bigquery',
			'preview_bq_csv',
			'get_distinct_values',
			'metabase_help',
			'metabase_research',
			'create_metabase_card',
			'bq_validate_query',
			'bq_row_count',
			'bq_date_range',
			'bq_top_values',
			'local_list',
			'local_read',
			'local_write',
			'local_edit',
			'local_stat',
			'local_manifest',
			'report_local_write',
			'report_local_read',
			'report_local_edit',
			'artifact_write',
			'report_artifact_write',
			'report_artifact_upload',
			'artifact_read_metadata',
			'artifact_get_link',
		]);
		expect(dbtExplorerToolset(policy).map((tool) => tool.name)).toEqual([
			'search_manifest',
			'dbt_lineage',
			'get_model_details',
			'run_bigquery',
			'preview_bq_csv',
			'get_distinct_values',
			'metabase_help',
			'metabase_research',
			'create_metabase_card',
			'bq_validate_query',
			'bq_row_count',
			'bq_date_range',
			'bq_top_values',
			'local_list',
			'local_read',
			'local_write',
			'local_edit',
			'local_stat',
			'local_manifest',
			'report_local_write',
			'report_local_read',
			'report_local_edit',
			'artifact_write',
			'report_artifact_write',
			'report_artifact_upload',
			'artifact_read_metadata',
			'artifact_get_link',
			'read_source_catalog',
			'read_kb_index',
			'read_kb_article',
			'project_skill_list',
			'project_skill_read',
			'workflow_template_list',
			'workflow_template_read',
			'slack_search',
			'slack_read_thread',
			'gdrive_search',
			'gdrive_list',
			'gdrive_read',
			'gdrive_download',
			'gdrive_create',
			'gdrive_upload',
			'jira_taxonomy',
			'jira_scope',
			'jira_history_query',
			'jira_create_ticket',
			'jira_create_pr',
			'user_context_read',
			'user_context_upsert',
			'learnthis_save',
			'project_context_read',
			'project_context_propose_update',
			'personal_skill_list',
			'personal_skill_create',
			'personal_skill_update',
			'workflow_state_get',
			'workflow_state_put',
			'workflow_state_append_event',
			'trace_get',
		]);
	});
});

describe('persistence helpers', () => {
	it('defaults to dbt-explorer-api dev resources in evenup-internal-tools', () => {
		const previous = {
			FIRESTORE_PROJECT_ID: process.env.FIRESTORE_PROJECT_ID,
			GCP_PROJECT: process.env.GCP_PROJECT,
			GOOGLE_CLOUD_PROJECT: process.env.GOOGLE_CLOUD_PROJECT,
			FIRESTORE_DATABASE: process.env.FIRESTORE_DATABASE,
			FLUE_ARTIFACT_BUCKET: process.env.FLUE_ARTIFACT_BUCKET,
			GCS_ARTIFACT_BUCKET: process.env.GCS_ARTIFACT_BUCKET,
			GCS_BUCKET: process.env.GCS_BUCKET,
		};
		for (const key of Object.keys(previous)) delete process.env[key];
		const config = getPersistenceConfig();
		Object.assign(process.env, Object.fromEntries(Object.entries(previous).filter(([, value]) => value !== undefined)));

		expect(config.projectId).toBe(EVENUP_INTERNAL_TOOLS_PROJECT);
		expect(config.firestoreDatabase).toBe(DEV_DBT_EXPLORER_NAMESPACE);
		expect(config.artifactBucket).toBe(DEV_DBT_EXPLORER_BUCKET);
	});

	it('generates existing dbt-explorer GCS path conventions', () => {
		expect(artifactObjectName({ conversationId: 'conv-1', kind: 'outputs', name: 'query.sql' })).toBe(
			'dbt-explorer/conv-1/outputs/query.sql',
		);
		expect(reportObjectName({ reportType: 'generated', date: '2026-05-27', name: 'report.html' })).toBe(
			'report-files/generated/2026-05-27/report.html',
		);
	});

	it('writes and reads local Firestore-compatible documents', async () => {
		const config = {
			firestoreDatabase: '(default)',
			localRoot: path.join(testDir, 'tmp/persistence-firestore'),
		};

		await fs.rm(config.localRoot, { recursive: true, force: true });
		const written = await writeDocument('users/test/context/preferred_style', { value: 'Use compact SQL.' }, config);
		const read = await readDocument('users/test/context/preferred_style', config);

		expect(written.path).toBe('users/test/context/preferred_style');
		expect(read?.data).toEqual(expect.objectContaining({ value: 'Use compact SQL.' }));
	});

	it('writes local artifact objects with metadata and generated links', async () => {
		const config = {
			firestoreDatabase: '(default)',
			localRoot: path.join(testDir, 'tmp/persistence-gcs'),
			publicArtifactBaseUrl: 'https://reports.example.test/files',
		};

		await fs.rm(config.localRoot, { recursive: true, force: true });
		const written = await writeObject(
			{ object: 'dbt-explorer/conversation/outputs/query.sql', content: 'select 1', contentType: 'text/sql' },
			config,
		);
		const metadata = await readObjectMetadata({ object: written.object, bucket: written.bucket }, config);
		const link = artifactLink({ object: written.object, bucket: written.bucket }, config);

		expect(written.uri).toBe('gs://local-artifacts/dbt-explorer/conversation/outputs/query.sql');
		expect(metadata).toEqual(expect.objectContaining({ sizeBytes: 8, contentType: 'text/sql' }));
		expect(link.publicUrl).toBe('https://reports.example.test/files/dbt-explorer/conversation/outputs/query.sql');
	});

	it('builds existing report viewer URLs for report-files objects', () => {
		const link = artifactLink({ object: 'report-files/generated/report.html', bucket: 'test-bucket' });

		expect(link.publicUrl).toBe('https://dbt-explorer-api.apps.evenup.law/reports/doc/generated/report');
	});

	it('writes local workspace files with a post-run sync manifest', async () => {
		const previous = {
			FLUE_LOCAL_WORKSPACE_DIR: process.env.FLUE_LOCAL_WORKSPACE_DIR,
		};
		const root = path.join(testDir, 'tmp/local-workspace-tools');
		process.env.FLUE_LOCAL_WORKSPACE_DIR = root;
		await fs.rm(root, { recursive: true, force: true });

		const tools = createArtifactPersistenceTools(createToolPolicy({
			source: 'web',
			email: 'alice@evenup.ai',
			conversationId: 'conversation-1',
			runId: 'run-1',
		}));
		const byName = new Map(tools.map((tool) => [tool.name, tool]));
		const written = JSON.parse(await byName.get('local_write')!.execute({
			scope: 'reports',
			path: 'weekly.md',
			content: '# Draft',
			title: 'Weekly Report',
		}));
		await byName.get('local_edit')!.execute({
			scope: 'reports',
			path: 'weekly.md',
			find: 'Draft',
			replace: 'Final',
		});
		const read = JSON.parse(await byName.get('local_read')!.execute({
			scope: 'reports',
			path: 'weekly.md',
		}));
		const manifest = JSON.parse(await byName.get('local_manifest')!.execute({}));

		expect(written.path).toBe('weekly.md');
		expect(written.sync).toBe('gcs');
		expect(written.target).toBe('report-files/generated');
		expect(read.content).toBe('# Final');
		expect(manifest).toEqual(
			expect.objectContaining({
				conversationId: 'conversation-1',
				runId: 'run-1',
				files: [
					expect.objectContaining({
						scope: 'reports',
						path: 'weekly.md',
						contentType: 'text/markdown; charset=utf-8',
						title: 'Weekly Report',
					}),
				],
			}),
		);
		Object.assign(process.env, Object.fromEntries(Object.entries(previous).filter(([, value]) => value !== undefined)));
		for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key];
	});

	it('writes, edits, and uploads a local report draft through tools', async () => {
		const previous = {
			FLUE_PERSISTENCE_MODE: process.env.FLUE_PERSISTENCE_MODE,
			FLUE_LOCAL_PERSISTENCE_DIR: process.env.FLUE_LOCAL_PERSISTENCE_DIR,
			FLUE_REPORT_WORK_DIR: process.env.FLUE_REPORT_WORK_DIR,
		};
		const root = path.join(testDir, 'tmp/report-tools');
		process.env.FLUE_PERSISTENCE_MODE = 'local';
		process.env.FLUE_LOCAL_PERSISTENCE_DIR = path.join(root, 'persistence');
		process.env.FLUE_REPORT_WORK_DIR = path.join(root, 'work');
		await fs.rm(root, { recursive: true, force: true });

		const tools = createArtifactPersistenceTools(createToolPolicy({ source: 'web', email: 'alice@evenup.ai' }));
		const byName = new Map(tools.map((tool) => [tool.name, tool]));
		const written = JSON.parse(await byName.get('report_local_write')!.execute({
			name: 'weekly.html',
			content: '<h1>Draft</h1>',
		}));
		await byName.get('report_local_edit')!.execute({
			path: written.path,
			find: 'Draft',
			replace: 'Final',
		});
		const uploaded = JSON.parse(await byName.get('report_artifact_upload')!.execute({
			path: written.path,
			reportType: 'generated',
		}));

		expect(uploaded.object).toBe('report-files/generated/weekly.html');
		expect(uploaded.publicUrl).toBe('https://dbt-explorer-api.apps.evenup.law/reports/doc/generated/weekly');
		Object.assign(process.env, Object.fromEntries(Object.entries(previous).filter(([, value]) => value !== undefined)));
		for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key];
	});

	it('creates and lists personal skills through Firestore-backed tools', async () => {
		const previous = {
			FLUE_PERSISTENCE_MODE: process.env.FLUE_PERSISTENCE_MODE,
			FLUE_LOCAL_PERSISTENCE_DIR: process.env.FLUE_LOCAL_PERSISTENCE_DIR,
		};
		const root = path.join(testDir, 'tmp/personal-skill-tools');
		process.env.FLUE_PERSISTENCE_MODE = 'local';
		process.env.FLUE_LOCAL_PERSISTENCE_DIR = root;
		await fs.rm(root, { recursive: true, force: true });

		const tools = createContextPersistenceTools(createToolPolicy({ source: 'web', email: 'alice@evenup.ai' }));
		const byName = new Map(tools.map((tool) => [tool.name, tool]));
		const created = JSON.parse(await byName.get('personal_skill_create')!.execute({
			name: 'Short answers',
			instruction: 'Prefer concise answers.',
			enabled: true,
		}));
		const listed = JSON.parse(await byName.get('personal_skill_list')!.execute({ enabledOnly: true }));

		expect(created.path).toContain('users/alice@evenup.ai/skills/');
		expect(listed).toHaveLength(1);
		expect(listed[0].data).toEqual(expect.objectContaining({ name: 'Short answers', enabled: true }));
		Object.assign(process.env, Object.fromEntries(Object.entries(previous).filter(([, value]) => value !== undefined)));
		for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key];
	});
});

describe('directed exploration requests', () => {
	it('turns analytics intent into a bounded manifest and BigQuery brief', () => {
		const request = createWaiterExplorationRequest({
			message: 'For matters, is there a field indicating if it is a PLAAS case?',
			turn: resolveTurnContext({}),
			route: 'analytics',
		});

		expect(request.requestedBy).toBe('waiter');
		expect(request.brief.allowedSources).toEqual(expect.arrayContaining(['manifest', 'bigquery']));
		expect(request.brief.allowedSources).not.toEqual(expect.arrayContaining(['repo', 'jira']));
		expect(request.brief.searchMode).toBe('source_of_truth_lookup');
		expect(request.brief.stopWhen).toContain('source-of-truth models');
	});

	it('preserves exact deterministic skill requests as caller-directed exploration', () => {
		const request = createWaiterExplorationRequest({
			message: 'create tracking for task completion',
			turn: resolveTurnContext({ turnType: 'mainline' }),
			route: 'workflow',
			forcedSkillId: 'pm-amplitude-event-creation',
		});

		expect(request.brief.allowedSources).toEqual(expect.arrayContaining(['project_skill']));
		expect(request.brief.searchMode).toBe('workflow_lookup');
		expect(request.brief.evidenceNeeded.join(' ')).toContain('workflow');
	});

	it('keeps vague product questions scoped to knowledge evidence by default', () => {
		const request = createWaiterExplorationRequest({
			message: 'what evenup knowledge base do you have access to?',
			turn: resolveTurnContext({}),
		});

		expect(request.brief.searchMode).toBe('definition_lookup');
		expect(request.brief.allowedSources).toContain('kb');
	});

	it('treats named artifact discovery as context lookup before warehouse profiling', () => {
		const request = createWaiterExplorationRequest({
			message: 'can you give me a Pre-Day 1 Readiness Report for the firm Buckeye Law Group Inc.',
			turn: resolveTurnContext({}),
			route: 'analytics',
		});

		expect(request.brief.searchMode).toBe('artifact_lookup');
		expect(request.brief.allowedSources).toEqual(expect.arrayContaining(['kb']));
		expect(request.brief.allowedSources).not.toEqual(expect.arrayContaining(['manifest', 'bigquery']));
		expect(request.brief.unresolvedTerms).toEqual(expect.arrayContaining(['Pre-Day 1 Readiness Report']));
	});
});

describe('conversation ledger', () => {
	it('records the orchestration phases as an app-persistable object', () => {
		const turn = resolveTurnContext({});
		const sessionPlan = createSessionPlan({
			sessionName: 'conv-1',
			streamName: 'main',
			turnType: turn.type,
			runId: 'run-1',
			route: 'analytics',
		});
		const explorationRequest = createWaiterExplorationRequest({
			message: 'For matters, is there a field indicating if it is a PLAAS case?',
			turn,
			route: 'analytics',
		});
		const ledger = buildConversationLedger({
			rawUserMessage: 'PLAAS?',
			resolvedTask: 'For matters, is there a field indicating if it is a PLAAS case?',
			runId: 'run-1',
			turn,
			sessionPlan,
			decision: { action: 'run_preflight' },
			explorationRequest,
			order: { route: 'analytics' },
			kitchen: { confidence: 'medium' },
			postflight: [{ verdict: 'accept' }],
			reply: 'There is no direct PLAAS flag.',
			replyType: 'final',
			usage: { waiter: { tokens: 1 } },
		});

		expect(ledger).toEqual(
			expect.objectContaining({
				version: 1,
				conversationId: 'conv-1',
				streamName: 'main',
				runId: 'run-1',
				reply: { type: 'final', text: 'There is no direct PLAAS flag.' },
			}),
		);
		expect(ledger.events.map((event) => event.phase)).toEqual([
			'intake',
			'exploration',
			'order',
			'station',
			'postflight',
			'reply',
		]);
	});
});

describe('live eval definitions', () => {
	it('keeps live LLM evals separate from the normal test runner', () => {
		expect(LIVE_EVAL_CASES.map((testCase) => testCase.id)).toEqual([
			'plaas-matter-flag-caveat',
			'employee-growth-metabase-nonmutating',
			'buckeye-pre-day-1-readiness-followup',
			'irrelevant-out-of-scope-reject',
		]);
		expect(LIVE_EVAL_CASES.find((testCase) => testCase.id === 'employee-growth-metabase-nonmutating')?.payload)
			.toEqual(expect.objectContaining({ allowMetabaseCreate: false }));
		expect(LIVE_EVAL_CASES.every((testCase) => testCase.passCriteria.length > 0)).toBe(true);
		expect(LIVE_EVAL_CASES.every((testCase) => testCase.agentsInScope.length > 0)).toBe(true);
		expect(LIVE_EVAL_CASES.every((testCase) => testCase.runCommand.includes('node ../../packages/cli/bin/flue.mjs run'))).toBe(true);
		expect(LIVE_EVAL_CASES.find((testCase) => testCase.id === 'buckeye-pre-day-1-readiness-followup')).toEqual(
			expect.objectContaining({
				runAgent: 'waiter',
				agentsInScope: ['waiter'],
				runCommand: expect.stringContaining(' run waiter '),
			}),
		);
	});

	it('keeps deterministic live eval checks limited to hard guardrails', () => {
		const testCase = LIVE_EVAL_CASES.find((entry) => entry.id === 'plaas-matter-flag-caveat')!;

		expect(evaluateLiveEvalResult(testCase, {
			replyType: 'final',
			reply: 'Any semantically correct answer is fine here as long as it is user-visible and does not leak internals.',
		}).pass).toBe(true);
		expect(evaluateLiveEvalResult(testCase, {
			replyType: 'final',
			reply: 'The waiter should send this to the analytics station.',
		})).toEqual(expect.objectContaining({
			pass: false,
			reasons: expect.arrayContaining([
				expect.stringContaining('forbidden pattern'),
			]),
		}));
	});

	it('can require a follow-up reply type for uncertainty cases', () => {
		const testCase = LIVE_EVAL_CASES.find((entry) => entry.id === 'buckeye-pre-day-1-readiness-followup')!;

		expect(evaluateLiveEvalResult(testCase, {
			replyType: 'followup_question',
			reply: 'I found Buckeye Law Group, but I could not find a defined Pre-Day 1 Readiness Report. Could you clarify what this report should include?',
		}).pass).toBe(true);
		expect(evaluateLiveEvalResult(testCase, {
			replyType: 'final',
			reply: 'I found Buckeye Law Group, but I could not find a defined Pre-Day 1 Readiness Report. Could you clarify what this report should include?',
		})).toEqual(expect.objectContaining({
			pass: false,
			reasons: expect.arrayContaining([
				expect.stringContaining('Expected replyType followup_question'),
			]),
		}));
	});
});

describe('waiter routing', () => {
	it('routes analytics-shaped questions to analytics', () => {
		expect(createKitchenOrder('Find the best dbt model for case volume by month')).toEqual(
			expect.objectContaining({
				route: 'analytics',
				sources: expect.arrayContaining(['manifest']),
			}),
		);
	});

	it('routes knowledge-shaped lookup questions to knowledge with KB source', () => {
		expect(createKitchenOrder('how do i find which files were part of a clp snapshot?')).toEqual(
			expect.objectContaining({
				route: 'knowledge',
				sources: expect.arrayContaining(['kb']),
			}),
		);
	});

	it('selects planned source domains even before every harness is implemented', () => {
		expect(createKitchenOrder('what did we decide in slack about the CLP launch spec?')).toEqual(
			expect.objectContaining({
				route: 'knowledge',
				sources: expect.arrayContaining(['kb', 'slack']),
			}),
		);
	});

	it('preserves deterministic project skill commands in the work order', () => {
		expect(
			createKitchenOrder(
				'create tracking for task completion',
				false,
				undefined,
				undefined,
				'pm-amplitude-event-creation',
				'workflow',
			),
		).toEqual(
			expect.objectContaining({
				route: 'workflow',
				skillId: 'pm-amplitude-event-creation',
				sources: expect.arrayContaining(['project_skill']),
			}),
		);
	});

	it('does not return needs-more-exploration preflight directly to the user', () => {
		const order = createKitchenOrder(
			'Clone the dbt repo, fix assert_model_call_cost_no_anomalies, create a Jira ticket, and open a PR',
			false,
			undefined,
			{
				summary: 'The workflow station should inspect the dbt test and apply the fix.',
				searchedSources: ['repo', 'jira'],
				queryVariantsTried: ['assert_model_call_cost_no_anomalies pricing anomaly'],
				findings: [],
				candidateModels: [],
				gaps: ['Exact failing pricing entries must be verified in the repo.'],
			},
		);

		expect(shouldReturnBeforeStation({
			summary: 'The workflow station should inspect the dbt test and apply the fix.',
			searchedSources: ['repo', 'jira'],
			queryVariantsTried: ['assert_model_call_cost_no_anomalies pricing anomaly'],
			findings: [],
			candidateModels: [],
			gaps: ['Exact failing pricing entries must be verified in the repo.'],
		}, order)).toBe(false);
	});

	it('returns before station only for user clarification or hard blockers', () => {
		const basePreflight: Parameters<typeof shouldReturnBeforeStation>[0] = {
			summary: 'Insufficient context.',
			searchedSources: ['kb'],
			queryVariantsTried: ['which dashboard should I update'],
			findings: [],
			candidateModels: [],
			gaps: ['The target dashboard is unclear.'],
		};
		const order = createKitchenOrder('Which dashboard should I update?');
		const clarifyOrder = { ...order, clarifyingQuestion: 'Which dashboard should I update?' };
		const blockerOrder = { ...order, blockerMessage: 'I cannot complete this yet because the required repository credentials are unavailable.' };

		expect(shouldReturnBeforeStation(basePreflight, clarifyOrder)).toBe(true);
		expect(shouldReturnBeforeStation(basePreflight, blockerOrder)).toBe(true);
		expect(shouldReturnBeforeStation(basePreflight, order)).toBe(false);
	});

	it('builds deterministic pre-station followups without orchestration leakage', () => {
		const blockedPreflight: Parameters<typeof buildPreStationFollowup>[0] = {
			summary: 'Required repository credentials are unavailable.',
			searchedSources: ['repo'],
			queryVariantsTried: ['fix the dbt warning'],
			findings: [],
			candidateModels: [],
			gaps: ['The required repository credentials are unavailable.'],
		};
		const blockerOrder = {
			...createKitchenOrder('Fix the dbt warning'),
			blockerMessage: 'I cannot complete this yet because The required repository credentials are unavailable.',
		};

		const reply = buildPreStationFollowup(blockedPreflight, blockerOrder);
		expect(reply).toBe('I cannot complete this yet because The required repository credentials are unavailable.');
		expect(reply).not.toMatch(/\b(explorer|work order|dispatch|station|preflight|orchestration)\b/i);

		const fallback = buildPreStationFollowup({ ...blockedPreflight, gaps: [] }, createKitchenOrder('Fix the dbt warning'));
		expect(fallback).toBe('I need one clarification before I can continue.');
	});

	it('rejects orchestration leakage in final user replies', () => {
		const leaked =
			'Proceeding without user clarification. The workflow station should attempt the work order as drafted.';
		expect(isUserVisibleReplySafe(leaked)).toBe(false);

		const reply = buildFinalUserReply(leaked, {
			answer: leaked,
			confidence: 'medium',
			artifacts: [],
			followupQuestions: [],
			kitchenSummary: 'The workflow station should inspect the repo.',
			needsReview: false,
		});

		expect(reply).toBe('I could not complete this yet. This run did not produce verified completed actions or a concrete blocker.');
		expect(reply).not.toMatch(/\b(station|work order|preflight|explorer|orchestrator)\b/i);
	});

	it('lets waiter reject requests that cannot be routed to any station', async () => {
		const { init, harnessNames } = createFakeFlueInit((call) => {
			if (call.prompt.includes('Mode: intake_decision.')) {
				return {
					action: 'reject',
					rationale: 'The request is outside analytics, knowledge, workflow, and documentation capabilities.',
					userMessage: 'I cannot help with that request. I can help with EvenUp analytics, internal knowledge, documentation, or approved workflows.',
				};
			}
			throw new Error(`Unexpected fake prompt:\n${call.prompt}`);
		});

		const result = await waiterAgent({
			init,
			payload: {
				message: 'what is the private medical diagnosis of a random person I saw on the subway yesterday?',
				sessionName: 'thread-private-reject',
				streamName: 'main',
			},
			id: 'thread-private-reject',
			runId: 'run_private_reject',
		} as any) as any;

		expect(result).toEqual(expect.objectContaining({
			replyType: 'final',
			reply: 'I cannot help with that request. I can help with EvenUp analytics, internal knowledge, documentation, or approved workflows.',
		}));
		expect(result.decision).toEqual(expect.objectContaining({ action: 'reject' }));
		expect(harnessNames).toEqual(['waiter']);
		expect(result.reply).not.toMatch(/\b(station|work order|preflight|explorer|orchestrator)\b/i);
	});

	it('uses reviewed station content when postflight lacks a user message', () => {
		const reply = buildPostflightUserReply({
			verdict: 'block',
			rationale: 'BigQuery access failed.',
			issues: ['Missing bigquery.jobs.create.'],
		}, {
			answer: 'Blocker: BigQuery execution failed because the service account is missing bigquery.jobs.create. I prepared SQL but could not return sampled rows.',
			confidence: 'low',
			artifacts: [],
			followupQuestions: [],
			kitchenSummary: 'Prepared SQL and found a BigQuery access blocker.',
			needsReview: true,
		});

		expect(reply.replyType).toBe('final');
		expect(reply.reply).toContain('BigQuery execution failed');
		expect(reply.reply).not.toMatch(/\b(station|work order|preflight|explorer|orchestrator|final review)\b/i);
	});

	it('classifies postflight user replies as either final or follow-up question', () => {
		const kitchenResult = {
			answer: 'The answer is 42.',
			confidence: 'high' as const,
			artifacts: [],
			followupQuestions: [],
			kitchenSummary: 'Computed the answer.',
			needsReview: false,
		};

		expect(
			buildPostflightUserReply({
				verdict: 'accept',
				rationale: 'Accepted.',
				issues: [],
				userMessage: 'The answer is 42.',
			}, kitchenResult),
		).toEqual({
			reply: 'The answer is 42.',
			replyType: 'final',
		});

		expect(
			buildPostflightUserReply({
				verdict: 'ask_user',
				rationale: 'Need a time window.',
				issues: [],
				userMessage: 'Which time window should I use?',
			}, kitchenResult),
		).toEqual({
			reply: 'Which time window should I use?',
			replyType: 'followup_question',
		});
	});

	it('routes forced analytics skills without relying on message heuristics', () => {
		expect(
			createKitchenOrder('', false, undefined, undefined, 'ai_drafts_kpi_report', 'analytics'),
		).toEqual(
			expect.objectContaining({
				route: 'analytics',
				skillId: 'ai_drafts_kpi_report',
				sources: expect.arrayContaining(['project_skill']),
				intent: expect.stringContaining('/ai_drafts_kpi_report'),
			}),
		);
	});

	it('keeps forced workflow evaluation shallow when mutation is disabled', async () => {
		const { init, harnessNames } = createFakeFlueInit((call) => {
			if (call.harnessName === 'explorer-tasker') {
				return {
					summary: 'The request matches a deterministic project skill.',
					searchedSources: ['project_skill'],
					queryVariantsTried: ['pm-amplitude-event-creation', 'task completion tracking'],
					findings: [],
					candidateModels: [],
					gaps: ['Mutation is disabled in this run.'],
				};
			}
			if (call.prompt.includes('Mode: draft_work_order.')) {
				return {
					route: 'workflow',
					skillId: 'pm-amplitude-event-creation',
					intent: 'Run the PM amplitude event creation workflow.',
					rewrittenTask: 'Add tracking for treatment check-in modal.',
					sources: ['project_skill'],
					constraints: ['Do not mutate systems unless workflow mutation is enabled.'],
					acceptanceCriteria: ['Return a concrete blocker when mutation is disabled.'],
					allowedActions: ['project skill read only'],
					requestedOutput: 'Workflow report or blocker.',
				};
			}
			throw new Error(`Unexpected fake prompt:\n${call.prompt}`);
		});

		const result = await waiterAgent({
			init,
			payload: {
				message: 'add tracking for treatment check-in modal',
				sessionName: 'thread-shallow-workflow',
				streamName: 'main',
				source: 'cli',
				forcedSkillId: 'pm-amplitude-event-creation',
				forcedRoute: 'workflow',
				allowWorkflowMutation: false,
			},
			id: 'thread-shallow-workflow',
			runId: 'run_shallow_workflow',
		} as any) as any;

		expect(result).toEqual(expect.objectContaining({
			replyType: 'final',
			reply: expect.stringContaining('workflow mutation is disabled'),
			postflight: [expect.objectContaining({ verdict: 'block' })],
		}));
		expect(result.order).toEqual(expect.objectContaining({
			route: 'workflow',
			skillId: 'pm-amplitude-event-creation',
		}));
		expect(harnessNames).toEqual(['waiter', 'explorer-tasker']);
		expect(harnessNames).not.toContain('kitchen-workflow');
		expect(result.reply).not.toMatch(/\b(station|work order|preflight|explorer|orchestrator)\b/i);
	});

	it('summarizes explorer preflight before sending it back to waiter phases', () => {
		const longEvidence = 'x'.repeat(600);
		const summary = summarizeExplorerPreflightForWaiter({
			summary: 'y'.repeat(1500),
			searchedSources: ['manifest', 'bigquery', 'kb'],
			queryVariantsTried: ['model_a', 'model_b'],
			findings: [],
			candidateModels: [
				{
					name: 'model_a',
					relationName: 'project.dataset.model_a',
					evidence: [longEvidence, 'short evidence', 'extra evidence'],
					concerns: ['concern 1', 'concern 2', 'concern 3'],
				},
				{ name: 'model_b', evidence: ['ok'], concerns: [] },
				{ name: 'model_c', evidence: ['ok'], concerns: [] },
				{ name: 'model_d', evidence: ['ok'], concerns: [] },
				{ name: 'model_e', evidence: ['ok'], concerns: [] },
				{ name: 'model_f', evidence: ['ok'], concerns: [] },
			],
			gaps: ['gap 1', 'gap 2', 'gap 3', 'gap 4', 'gap 5', 'gap 6', 'gap 7'],
		});

		expect(summary.summary).toHaveLength(1200);
		expect(summary.candidateModels).toHaveLength(5);
		const firstCandidate = summary.candidateModels[0];
		expect(firstCandidate).toBeDefined();
		expect(firstCandidate?.evidence).toHaveLength(2);
		expect(firstCandidate?.evidence[0]).toHaveLength(350);
		expect(firstCandidate?.omittedEvidenceCount).toBe(1);
		expect(summary.omittedCandidateCount).toBe(1);
		expect(summary.omittedGapCount).toBe(1);
	});

	it('uses explicit turn type instead of inferring side questions from message text', () => {
		expect(resolveTurnContext({ turnType: 'side_question' })).toEqual(
			expect.objectContaining({
				type: 'side_question',
				trigger: 'turnType',
				usesBranchStationSession: true,
			}),
		);

		expect(resolveTurnContext({ turnType: 'mainline' })).toEqual(
			expect.objectContaining({
				type: 'mainline',
				usesBranchStationSession: false,
			}),
		);
	});

	it('keeps legacy rework as a deterministic explicit trigger', () => {
		expect(resolveTurnContext({ rework: true })).toEqual(
			expect.objectContaining({
				type: 'rework',
				trigger: 'legacy_rework',
				isRework: true,
			}),
		);
	});

	it('creates detached preflight sessions per run', () => {
		const plan = createSessionPlan({
			sessionName: 'user-thread',
			streamName: 'main',
			turnType: 'mainline',
			runId: 'run_123',
			route: 'analytics',
		});

		expect(plan.waiterSessionName).toBe('user-thread');
		expect(plan.preflightSessionName).toBe('user-thread:s:main:pf:run_123');
		expect(plan.stationSessionName).toBe('user-thread:s:main:st:analytics');
		expect(plan.usesBranchStationSession).toBe(false);
	});

	it('branches side-question station sessions without changing the waiter session', () => {
		const plan = createSessionPlan({
			sessionName: 'user-thread',
			streamName: 'main',
			branchName: 'btw-morse',
			turnType: 'side_question',
			runId: 'run_456',
			route: 'knowledge',
		});

		expect(plan.waiterSessionName).toBe('user-thread');
		expect(plan.preflightSessionName).toBe('user-thread:s:main:pf:run_456');
		expect(plan.stationSessionName).toBe('user-thread:s:main:b:btw-morse:st:knowledge');
		expect(plan.usesBranchStationSession).toBe(true);
	});

	it('creates a fresh stream for topic switches when no stream name is supplied', () => {
		const plan = createSessionPlan({
			sessionName: 'user-thread',
			turnType: 'topic_switch',
			runId: 'run_789',
			route: 'analytics',
		});

		expect(plan.streamName).toBe('topic-run_789');
		expect(plan.stationSessionName).toBe('user-thread:s:topic-run_789:b:run_789:st:analytics');
	});

	it('keeps Slack-shaped session names short enough for local persistence filenames', () => {
		const plan = createSessionPlan({
			sessionName: 'slack_C0AS0JVBGS0_1780440030.167019',
			streamName: 'slack_C0AS0JVBGS0_1780440030.167019',
			turnType: 'mainline',
			runId: 'run_01KT57XVMTWW8NCAAA7SF1A6GQ',
			route: 'analytics',
		});

		expect(plan.waiterSessionName).toMatch(/^slack_C0AS0JVBGS0_[0-9a-f]{10}$/);
		expect(plan.preflightSessionName.length).toBeLessThanOrEqual(90);
		expect(plan.stationSessionName?.length).toBeLessThanOrEqual(90);
		expect(plan.preflightSessionName).not.toContain('1780440030.167019:s:slack_C0AS0JVBGS0_1780440030.167019');
	});

	it('routes every user-initiated message through waiter', () => {
		expect(shouldInvokeWaiter({ activeRoute: 'analytics' })).toBe(true);
		expect(shouldInvokeWaiter({})).toBe(true);
		expect(shouldInvokeWaiter({ activeRoute: 'analytics', turnType: 'side_question' })).toBe(true);
		expect(shouldInvokeWaiter({ activeRoute: 'analytics', turnType: 'topic_switch' })).toBe(true);
		expect(shouldInvokeWaiter({ activeRoute: 'analytics', rework: true })).toBe(true);
	});

	it('passes mainline continuations through to the active station with the original user message', async () => {
		const userMessage = 'show the same result by week';
		const { init, calls, harnessNames } = createFakeFlueInit((call) => {
			if (call.prompt.includes('Mode: intake_decision.')) {
				return {
					action: 'continue_station',
					route: 'analytics',
					rationale: 'The active analytics thread can answer this directly.',
					stationInstruction: 'Rewrite this into a different task.',
				};
			}
			if (call.prompt.includes('Mode: station_continuation.')) {
				return {
					answer: 'Weekly result ready.',
					confidence: 'high',
					artifacts: [],
					followupQuestions: [],
					kitchenSummary: 'Grouped the existing result by week.',
					needsReview: false,
				};
			}
			if (call.prompt.includes('Mode: postflight_gate.')) {
				return {
					verdict: 'accept',
					rationale: 'Ready for user.',
					issues: [],
					userMessage: 'Weekly result ready.',
				};
			}
			throw new Error(`Unexpected fake prompt:\n${call.prompt}`);
		});

		const result = await waiterAgent({
			init,
			payload: {
				message: userMessage,
				sessionName: 'thread-1',
				streamName: 'main',
				activeRoute: 'analytics',
				stationSessionName: 'thread-1:stream:main:station:analytics',
			},
			id: 'thread-1',
			runId: 'run_pass_through',
		} as any) as any;

		const stationPrompt = calls.find((call) => call.harnessName === 'station-analytics');
		expect(result).toEqual(expect.objectContaining({ reply: 'Weekly result ready.', replyType: 'final' }));
		expect(result.order).toEqual(expect.objectContaining({ rewrittenTask: userMessage }));
		expect(stationPrompt?.prompt).toContain(`Latest user message:\n${userMessage}`);
		expect(stationPrompt?.prompt).not.toContain('Waiter station instruction');
		expect(stationPrompt?.prompt).not.toContain('Rewrite this into a different task.');
		expect(harnessNames).toEqual(['waiter', 'station-analytics']);
		expect(harnessNames).not.toContain('explorer-tasker');
	});

	it('passes resolved continuation context to the active station without replacing the latest user message', async () => {
		const userMessage = 'by week';
		const resolvedTask = 'Show the previous employee growth result by week.';
		const priorWorkSummary = 'The prior station created an employee growth card with monthly Ontario and California filters.';
		const { init, calls } = createFakeFlueInit((call) => {
			if (call.prompt.includes('Mode: intake_decision.')) {
				return {
					action: 'continue_station',
					route: 'analytics',
					rationale: 'The active analytics thread has the prior employee growth context.',
					resolvedTask,
					priorWorkSummary,
				};
			}
			if (call.prompt.includes('Mode: station_continuation.')) {
				return {
					answer: 'Weekly result ready.',
					confidence: 'high',
					artifacts: [],
					followupQuestions: [],
					kitchenSummary: 'Grouped the prior result by week.',
					needsReview: false,
				};
			}
			if (call.prompt.includes('Mode: postflight_gate.')) {
				return {
					verdict: 'accept',
					rationale: 'Ready for user.',
					issues: [],
					userMessage: 'Weekly result ready.',
				};
			}
			throw new Error(`Unexpected fake prompt:\n${call.prompt}`);
		});

		const result = await waiterAgent({
			init,
			payload: {
				message: userMessage,
				sessionName: 'thread-resolved-continuation',
				streamName: 'main',
				activeRoute: 'analytics',
				stationSessionName: 'thread-resolved-continuation:s:main:st:analytics',
			},
			id: 'thread-resolved-continuation',
			runId: 'run_resolved_continuation',
		} as any) as any;

		const stationPrompt = calls.find((call) => call.harnessName === 'station-analytics');
		expect(result.order).toEqual(expect.objectContaining({
			intent: resolvedTask,
			rewrittenTask: resolvedTask,
			priorWorkSummary,
		}));
		expect(stationPrompt?.prompt).toContain(`Prior work context:\n${priorWorkSummary}`);
		expect(stationPrompt?.prompt).toContain(`Resolved task:\n${resolvedTask}`);
		expect(stationPrompt?.prompt).toContain(`Latest user message:\n${userMessage}`);
		expect(result.reply).toBe('Weekly result ready.');
	});

	it('resolves a terse follow-up answer before explorer and station work', async () => {
		const userMessage = 'Ontario and California';
		const resolvedTask = 'Make a Metabase card to track EvenUp employee growth of all time, filtered to Ontario, Canada and California, USA.';
		const priorWorkSummary = 'The waiter previously asked which regions should be included in the employee growth card.';
		const { init, calls } = createFakeFlueInit((call) => {
			if (call.prompt.includes('Mode: intake_decision.')) {
				return {
					action: 'run_preflight',
					route: 'analytics',
					rationale: 'The latest message answers the prior scope question.',
					resolvedTask,
				};
			}
			if (call.harnessName === 'explorer-tasker') {
				return {
					summary: 'Employee history analytics task with geographic filters.',
					searchedSources: ['manifest', 'bigquery', 'metabase'],
					queryVariantsTried: ['employee growth Ontario California'],
					findings: [
						{
							source: 'manifest',
							title: 'dim_employees_history',
							reference: 'manifest:model.dim_employees_history',
							evidence: ['Contains employee history and location fields.'],
						},
					],
					candidateModels: [
						{
							name: 'dim_employees_history',
							evidence: ['Contains employee history and location fields.'],
							concerns: [],
						},
					],
					gaps: [],
				};
			}
			if (call.prompt.includes('Mode: draft_work_order.')) {
				return {
					route: 'analytics',
					intent: resolvedTask,
					rewrittenTask: resolvedTask,
					sources: ['manifest', 'bigquery', 'metabase'],
					constraints: ['Validate Ontario/California values before card creation.'],
					acceptanceCriteria: ['Use the resolved geographic scope.'],
					allowedActions: ['manifest lookup', 'BigQuery validation/query', 'Metabase creation only if explicitly requested and enabled'],
					requestedOutput: 'Metabase card or concrete blocker.',
				};
			}
			if (call.prompt.includes('Mode: analytics_station.')) {
				return {
					answer: 'Created the employee growth card.',
					confidence: 'high',
					artifacts: [{ type: 'metabase_card', id: '123', url: 'https://metabase.test/card/123' }],
					followupQuestions: [],
					kitchenSummary: 'Validated geographic values and created the card.',
					needsReview: false,
				};
			}
			if (call.prompt.includes('Mode: postflight_gate.')) {
				return {
					verdict: 'accept',
					rationale: 'Ready.',
					issues: [],
					userMessage: 'Created the employee growth card.',
				};
			}
			throw new Error(`Unexpected fake prompt:\n${call.prompt}`);
		});

		const result = await waiterAgent({
			init,
			payload: {
				message: userMessage,
				sessionName: 'thread-followup-answer',
				streamName: 'main',
				source: 'cli',
				allowMetabaseCreate: true,
				priorWorkSummary,
			},
			id: 'thread-followup-answer',
			runId: 'run_followup_answer',
		} as any) as any;

		const explorerPrompt = calls.find((call) => call.harnessName === 'explorer-tasker')?.prompt;
		const stationPrompt = calls.find((call) => call.harnessName === 'kitchen-analytics')?.prompt;
		expect(explorerPrompt).toContain(`User request:\n${resolvedTask}`);
		expect(explorerPrompt).not.toContain(`User request:\n${userMessage}`);
		expect(explorerPrompt).toContain(`Prior work context:\n${priorWorkSummary}`);
		expect(stationPrompt).toContain(resolvedTask);
		expect(stationPrompt).toContain(priorWorkSummary);
		expect(result.decision).toEqual(expect.objectContaining({ resolvedTask }));
		expect(result.order).toEqual(expect.objectContaining({ rewrittenTask: resolvedTask, priorWorkSummary }));
		expect(result.reply).toBe('Created the employee growth card.');
	});

	it('returns a waiter follow-up question before preflight or station work when intake needs clarification', async () => {
		const { init, calls, harnessNames } = createFakeFlueInit((call) => {
			if (call.prompt.includes('Mode: intake_decision.')) {
				return {
					action: 'ask_user',
					rationale: 'The requested dashboard is ambiguous.',
					clarifyingQuestion: 'Which dashboard should I update?',
				};
			}
			throw new Error(`Unexpected fake prompt:\n${call.prompt}`);
		});

		const result = await waiterAgent({
			init,
			payload: {
				message: 'update the dashboard',
				sessionName: 'thread-2',
				streamName: 'main',
			},
			id: 'thread-2',
			runId: 'run_followup',
		} as any);

		expect(result).toEqual(expect.objectContaining({
			reply: 'Which dashboard should I update?',
			replyType: 'followup_question',
		}));
		expect(calls).toHaveLength(1);
		expect(harnessNames).toEqual(['waiter']);
	});

	it('disables the built-in task tool on the waiter harness', async () => {
		const { init, harnessOptions } = createFakeFlueInit((call) => {
			if (call.prompt.includes('Mode: intake_decision.')) {
				return {
					action: 'ask_user',
					rationale: 'The requested dashboard is ambiguous.',
					clarifyingQuestion: 'Which dashboard should I update?',
				};
			}
			throw new Error(`Unexpected fake prompt:\n${call.prompt}`);
		});

		await waiterAgent({
			init,
			payload: {
				message: 'update the dashboard',
				sessionName: 'thread-task-disabled',
				streamName: 'main',
			},
			id: 'thread-task-disabled',
			runId: 'run_task_disabled',
		} as any);

		expect(harnessOptions).toHaveLength(1);
		expect(harnessOptions[0]).toEqual(expect.objectContaining({
			name: 'waiter',
			sandbox: expect.objectContaining({ disableTaskTool: true }),
		}));
	});

	it('falls back to preflight when intake decision fails instead of assuming station continuation', async () => {
		const { init, harnessNames } = createFakeFlueInit((call) => {
			if (call.prompt.includes('Mode: intake_decision.')) {
				throw new Error('schema failed');
			}
			if (call.harnessName === 'explorer-tasker') {
				return {
					summary: 'Need analytics validation.',
					searchedSources: ['manifest', 'bigquery'],
					queryVariantsTried: ['answer the analytics question'],
					findings: [],
					candidateModels: [
						{
							name: 'fact_case_level_pipeline',
							evidence: ['Relevant model candidate.'],
							concerns: [],
						},
					],
					gaps: [],
				};
			}
			if (call.prompt.includes('Mode: draft_work_order.')) {
				return {
					route: 'analytics',
					intent: 'answer the analytics question',
					rewrittenTask: 'answer the analytics question',
					sources: ['manifest', 'bigquery'],
					constraints: [],
					acceptanceCriteria: ['Answer directly.'],
					allowedActions: ['BigQuery validation/query'],
					requestedOutput: 'Answer.',
				};
			}
			if (call.prompt.includes('Mode: analytics_station.')) {
				return {
					answer: 'Analytics answer.',
					confidence: 'high',
					artifacts: [],
					followupQuestions: [],
					kitchenSummary: 'Answered.',
					needsReview: false,
				};
			}
			if (call.prompt.includes('Mode: postflight_gate.')) {
				return {
					verdict: 'accept',
					rationale: 'Ready.',
					issues: [],
					userMessage: 'Analytics answer.',
				};
			}
			throw new Error(`Unexpected fake prompt:\n${call.prompt}`);
		});

		const result = await waiterAgent({
			init,
			payload: {
				message: 'new source-of-truth question',
				sessionName: 'thread-fallback',
				streamName: 'main',
				activeRoute: 'analytics',
				source: 'cli',
			},
			id: 'thread-fallback',
			runId: 'run-fallback',
		} as any) as any;

		expect(result.decision.action).toBe('run_preflight');
		expect(harnessNames).toContain('explorer-tasker');
		expect(harnessNames).toContain('kitchen-analytics');
		expect(harnessNames).not.toContain('station-analytics');
		expect(result.reply).toBe('Analytics answer.');
	});

	it('can force a user-facing follow-up through the test hook without any model calls', async () => {
		const previous = process.env.ANALYTICS_ENABLE_TEST_HOOKS;
		process.env.ANALYTICS_ENABLE_TEST_HOOKS = '1';
		try {
			const result = await waiterAgent({
				init: async () => {
					throw new Error('test follow-up hook should not initialize a harness');
				},
				payload: {
					message: 'anything',
					sessionName: 'thread-test-hook',
					streamName: 'main',
					waiterModel: 'anthropic/claude-haiku-4-5',
					kitchenModel: 'openai/gpt-5.4-nano',
					testFollowupQuestion: 'Which dashboard should I update?',
				},
				id: 'thread-test-hook',
				runId: 'run_forced_followup',
			} as any);

			expect(result).toEqual(expect.objectContaining({
				reply: 'Which dashboard should I update?',
				replyType: 'followup_question',
				waiterModel: 'anthropic/claude-haiku-4-5',
				kitchenModel: 'openai/gpt-5.4-nano',
			}));
			expect(result.reply).not.toMatch(/\b(station|work order|preflight|explorer|orchestrator)\b/i);
			expect(result.usage).toEqual({ waiter: { testHook: true } });
		} finally {
			if (previous === undefined) delete process.env.ANALYTICS_ENABLE_TEST_HOOKS;
			else process.env.ANALYTICS_ENABLE_TEST_HOOKS = previous;
		}
	});

	it('defaults waiter model to Sonnet, including rework when no escalation override is set', async () => {
		const previous = {
			ANALYTICS_ENABLE_TEST_HOOKS: process.env.ANALYTICS_ENABLE_TEST_HOOKS,
			WAITER_MODEL: process.env.WAITER_MODEL,
			WAITER_ESCALATION_MODEL: process.env.WAITER_ESCALATION_MODEL,
			REWORK_WAITER_MODEL: process.env.REWORK_WAITER_MODEL,
		};
		process.env.ANALYTICS_ENABLE_TEST_HOOKS = '1';
		delete process.env.WAITER_MODEL;
		delete process.env.WAITER_ESCALATION_MODEL;
		delete process.env.REWORK_WAITER_MODEL;
		try {
			const mainline = await waiterAgent({
				init: async () => {
					throw new Error('test scenario should not initialize a harness');
				},
				payload: {
					message: 'anything',
					sessionName: 'thread-default-model',
					testScenario: 'postflight_followup',
				},
				id: 'thread-default-model',
				runId: 'run_default_model',
			} as any);
			const rework = await waiterAgent({
				init: async () => {
					throw new Error('test scenario should not initialize a harness');
				},
				payload: {
					message: 'anything',
					sessionName: 'thread-default-rework-model',
					turnType: 'rework',
					testScenario: 'revise_then_block',
				},
				id: 'thread-default-rework-model',
				runId: 'run_default_rework_model',
			} as any);

			expect(mainline.waiterModel).toBe('anthropic/claude-sonnet-4-6');
			expect(rework.waiterModel).toBe('anthropic/claude-sonnet-4-6');
		} finally {
			for (const [key, value] of Object.entries(previous)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});

	it('forces pass-through, blocker, postflight follow-up, and revise-then-block paths without model calls', async () => {
		const previous = process.env.ANALYTICS_ENABLE_TEST_HOOKS;
		process.env.ANALYTICS_ENABLE_TEST_HOOKS = '1';
		try {
			const runForced = async (testScenario: string, extraPayload: Record<string, unknown> = {}) =>
				waiterAgent({
					init: async () => {
						throw new Error(`${testScenario} should not initialize a harness`);
					},
					payload: {
						message: 'test request',
						sessionName: `thread-${testScenario}`,
						streamName: 'main',
						waiterModel: 'anthropic/claude-haiku-4-5',
						kitchenModel: 'openai/gpt-5.4-nano',
						testScenario,
						...extraPayload,
					},
					id: `thread-${testScenario}`,
					runId: `run_${testScenario}`,
				} as any) as any;

			const passThrough = await runForced('pass_through', {
				message: 'show the same result by week',
				activeRoute: 'analytics',
			});
			expect(passThrough).toEqual(expect.objectContaining({
				reply: 'Handled continuation: show the same result by week',
				replyType: 'final',
			}));
			expect(passThrough.decision.action).toBe('continue_station');
			expect(passThrough.order.rewrittenTask).toBe('show the same result by week');
			expect(passThrough.reply).not.toMatch(/\b(station|work order|preflight|explorer|orchestrator)\b/i);

			const blocker = await runForced('preflight_blocker');
			expect(blocker.replyType).toBe('final');
			expect(blocker.reply).toContain('BigQuery job creation is not available');
			expect(blocker).toEqual(expect.objectContaining({
				explorer: expect.objectContaining({
					summary: 'Required warehouse access is unavailable.',
					gaps: expect.arrayContaining(['BigQuery job creation is not available for this test run.']),
				}),
				order: expect.objectContaining({
					blockerMessage: 'I cannot complete this yet because BigQuery job creation is not available for this test run.',
				}),
			}));
			expect(blocker.reply).not.toMatch(/\b(station|work order|preflight|explorer|orchestrator)\b/i);

			const followup = await runForced('postflight_followup');
			expect(followup).toEqual(expect.objectContaining({
				reply: 'Which time window should I use?',
				replyType: 'followup_question',
			}));
			expect(followup.postflight[0]).toEqual(expect.objectContaining({ verdict: 'ask_user' }));
			expect(followup.reply).not.toMatch(/\b(station|work order|preflight|explorer|orchestrator)\b/i);

			const reviseBlock = await runForced('revise_then_block', { turnType: 'rework' });
			expect(reviseBlock.replyType).toBe('final');
			expect(reviseBlock.reply).toBe('I could not complete this because Jira mutation is not enabled for this run.');
			expect(reviseBlock.postflight.map((review: { verdict: string }) => review.verdict)).toEqual(['revise', 'block']);
			expect(reviseBlock.turn).toEqual(expect.objectContaining({ type: 'rework', isRework: true }));
			expect(reviseBlock.reply).not.toMatch(/\b(station|work order|preflight|explorer|orchestrator)\b/i);
		} finally {
			if (previous === undefined) delete process.env.ANALYTICS_ENABLE_TEST_HOOKS;
			else process.env.ANALYTICS_ENABLE_TEST_HOOKS = previous;
		}
	});

	it('sends rejected postflight work back to the station, then returns the accepted postflight message', async () => {
		let postflightCount = 0;
		const priorAnswer = 'The prior answer leaked a work order and did not execute the task.';
		const { init, calls, harnessNames } = createFakeFlueInit((call) => {
			if (call.prompt.includes('Mode: intake_decision.')) {
				return {
					action: 'run_preflight',
					route: 'workflow',
					rationale: 'Explicit rework should be reconsidered from first principles.',
				};
			}
			if (call.harnessName === 'explorer-tasker') {
				return {
					summary: 'The workflow station should inspect repo and Jira evidence.',
					searchedSources: ['repo', 'jira'],
					queryVariantsTried: ['repo jira failed task'],
					findings: [],
					candidateModels: [],
					gaps: ['Exact files need station inspection.'],
				};
			}
			if (call.prompt.includes('Mode: draft_work_order.')) {
				return {
					route: 'workflow',
					intent: 'Rework the failed repo/Jira task.',
					rewrittenTask: 'Reconsider the repo/Jira task from scratch and complete it if possible.',
					sources: ['repo', 'jira'],
					constraints: ['Verify before claiming completion.'],
					acceptanceCriteria: ['Report concrete blockers or completed branch/ticket/PR.'],
					allowedActions: ['repo inspection', 'jira mutation when enabled'],
					requestedOutput: 'Completed workflow report or concrete blocker.',
				};
			}
			if (call.prompt.includes('Mode: workflow_station.')) {
				return {
					answer: 'Initial answer is incomplete.',
					confidence: 'low',
					artifacts: [],
					followupQuestions: [],
					kitchenSummary: 'Needs more repo verification.',
					needsReview: true,
				};
			}
			if (call.prompt.includes('Mode: postflight_gate.')) {
				postflightCount += 1;
				if (postflightCount === 1) {
					return {
						verdict: 'revise',
						rationale: 'The station did not verify repo evidence.',
						issues: ['Missing repo verification.'],
						feedbackToStation: 'Read the relevant repo files and return a concrete completed/blocker answer.',
					};
				}
				return {
					verdict: 'accept',
					rationale: 'The revised answer is user-ready.',
					issues: [],
					userMessage: 'I rechecked the repo evidence and found a concrete blocker: Jira mutation is not enabled for this run.',
				};
			}
			if (call.prompt.includes('Mode: station_revision.')) {
				return {
					answer: 'Blocker: Jira mutation is not enabled for this run after repo verification.',
					confidence: 'medium',
					artifacts: [],
					followupQuestions: [],
					kitchenSummary: 'Verified repo context and identified Jira mutation blocker.',
					needsReview: false,
				};
			}
			throw new Error(`Unexpected fake prompt:\n${call.prompt}`);
		});

		const result = await waiterAgent({
			init,
			payload: {
				message: 'try again, fix the dbt warning and open the PR',
				sessionName: 'thread-3',
				streamName: 'main',
				turnType: 'rework',
				priorAnswer,
			},
			id: 'thread-3',
			runId: 'run_rework',
		} as any) as any;

		expect(result).toEqual(expect.objectContaining({
			reply: 'I rechecked the repo evidence and found a concrete blocker: Jira mutation is not enabled for this run.',
			replyType: 'final',
		}));
		expect(result.turn).toEqual(expect.objectContaining({ type: 'rework', isRework: true }));
		expect(result.order.priorWorkSummary).toContain(`Prior rejected answer: ${priorAnswer}`);
		expect(result.postflight.map((review: { verdict: string }) => review.verdict)).toEqual(['revise', 'accept']);
		expect(calls.some((call) => call.prompt.includes('Mode: station_revision.'))).toBe(true);
		expect(calls.find((call) => call.harnessName === 'explorer-tasker')?.prompt).toContain(priorAnswer);
		expect(calls.find((call) => call.harnessName === 'kitchen-workflow')?.prompt).toContain(priorAnswer);
		expect(harnessNames).toContain('explorer-tasker');
		expect(harnessNames).toContain('kitchen-workflow');
	});

	it('uses the routed station name in station failure responses', async () => {
		const { init, calls } = createFakeFlueInit((call) => {
			if (call.prompt.includes('Mode: intake_decision.')) {
				return {
					action: 'run_preflight',
					route: 'workflow',
					rationale: 'Workflow request.',
				};
			}
			if (call.harnessName === 'explorer-tasker') {
				return {
					summary: 'Workflow evidence.',
					searchedSources: ['project_skill'],
					queryVariantsTried: ['workflow request'],
					findings: [],
					candidateModels: [],
					gaps: [],
				};
			}
			if (call.prompt.includes('Mode: draft_work_order.')) {
				return {
					route: 'workflow',
					intent: 'run workflow',
					rewrittenTask: 'run workflow',
					sources: ['project_skill'],
					constraints: [],
					acceptanceCriteria: ['Report concrete blocker.'],
					allowedActions: ['bounded workflow action'],
					requestedOutput: 'Workflow report.',
				};
			}
			if (call.prompt.includes('Mode: workflow_station.')) {
				throw new Error('workflow failed');
			}
			if (call.prompt.includes('Mode: station_failure_response.')) {
				return {
					finalResponse: 'I could not complete this because the workflow action failed.',
					needsUserClarification: false,
				};
			}
			throw new Error(`Unexpected fake prompt:\n${call.prompt}`);
		});

		const result = await waiterAgent({
			init,
			payload: {
				message: 'run a workflow',
				sessionName: 'thread-station-failure',
				source: 'cli',
			},
			id: 'thread-station-failure',
			runId: 'run-station-failure',
		} as any) as any;

		const failurePrompt = calls.find((call) => call.prompt.includes('Mode: station_failure_response.'));
		expect(failurePrompt?.prompt).toContain('The workflow station failed before returning a schema result.');
		expect(failurePrompt?.prompt).not.toContain('The analytics station failed before returning a schema result.');
		expect(result.reply).toBe('I could not complete this because the workflow action failed.');
	});
});

describe('source catalog and kb tools', () => {
	it('reads the source catalog and scoped KB markdown docs', async () => {
		const sourceTools = createSourceCatalogTools();
		const kbTools = createKbTools({
			docsRoot: path.join(testDir, 'fixtures/waiter-docs'),
		});
		const catalog = await sourceTools[0]!.execute({});
		expect(catalog).toContain('# Source Catalog');

		const list = await kbTools[0]!.execute({});
		expect(JSON.parse(list)).toEqual(
			expect.objectContaining({
				path: 'knowledge_base/INDEX.md',
				path_contract: expect.stringContaining('article.path'),
				valid_paths: ['knowledge_base/guide.md'],
				articles: [
					{
						path: 'knowledge_base/guide.md',
						title: 'guide.md',
						description: 'Snapshot files guide',
						aliases: expect.arrayContaining(['guide.md', 'kb/guide.md']),
					},
				],
			}),
		);

		const read = await kbTools[1]!.execute({ path: 'knowledge_base/guide.md', pattern: 'snapshot', limit: 5 });
		expect(JSON.parse(read)).toEqual(
			expect.objectContaining({
				path: 'knowledge_base/guide.md',
				resolved_via_index: true,
				pattern: 'snapshot',
				content: expect.stringContaining('snapshot files'),
			}),
		);
	});

	it('resolves common KB path aliases through the index', async () => {
		const tools = createKbTools({
			docsRoot: path.join(testDir, 'fixtures/waiter-docs'),
		});

		const read = await tools[1]!.execute({ path: 'kb/guide.md', limit: 2 });

		expect(JSON.parse(read)).toEqual(
			expect.objectContaining({
				path: 'knowledge_base/guide.md',
				requested_path: 'kb/guide.md',
				resolved_via_index: true,
				used_alias: true,
				valid_path: 'knowledge_base/guide.md',
			}),
		);
	});

	it('rejects unknown KB paths with valid index paths', async () => {
		const tools = createKbTools({
			docsRoot: path.join(testDir, 'fixtures/waiter-docs'),
		});

		await expect(tools[1]!.execute({ path: 'kb/missing.md' })).rejects.toThrow(
			'Valid paths: knowledge_base/guide.md',
		);
	});

	it('selects likely KB articles from the index', async () => {
		await expect(
			selectKbArticles('how do I find snapshot files?', {
				docsRoot: path.join(testDir, 'fixtures/waiter-docs'),
			}),
		).resolves.toEqual([{ path: 'knowledge_base/guide.md', title: 'guide.md', description: 'Snapshot files guide' }]);
	});
});

describe('workflow template tools', () => {
	it('lists and reads repo-defined workflow templates', async () => {
		const tools = createWorkflowTemplateTools({
			root: path.join(testDir, '..', 'resources', 'workflow_templates'),
		});

		const list = JSON.parse(await tools[0]!.execute({}));
		expect(list.templates).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: 'pm-amplitude-event-creation',
					trigger: 'pm-amplitude-event-creation',
					files: expect.arrayContaining(['SKILL.md', 'references/interview.md']),
				}),
			]),
		);

		const main = JSON.parse(
			await tools[1]!.execute({
				templateId: 'pm-amplitude-event-creation',
				path: 'SKILL.md',
				maxBytes: 2000,
			}),
		);
		expect(main.content).toContain('PM Amplitude Event Creation');
		expect(main.content).toContain('Only invoke this skill when the user types the exact phrase');
	});
});

describe('project skill tools', () => {
	it('lists and reads repo-defined project skills', async () => {
		const tools = createProjectSkillTools({
			root: path.join(testDir, '..', 'resources', 'skills'),
		});

		const list = JSON.parse(await tools[0]!.execute({}));
		expect(list.skills).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: 'dbt',
					alwaysLoaded: true,
					files: expect.arrayContaining(['SKILL.md', 'references/consultation.md']),
				}),
				expect.objectContaining({
					id: 'pm-amplitude-event-creation',
					name: 'pm-amplitude-event-creation',
					trigger: 'pm-amplitude-event-creation',
					files: expect.arrayContaining(['SKILL.md', 'references/interview.md']),
				}),
			]),
		);

		const main = JSON.parse(
			await tools[1]!.execute({
				skillId: 'pm-amplitude-event-creation',
				path: 'SKILL.md',
				maxBytes: 2000,
			}),
		);
		expect(main.content).toContain('PM Amplitude Event Creation');
		expect(main.content).toContain('Only invoke this skill when the user types the exact phrase');
	});
});
