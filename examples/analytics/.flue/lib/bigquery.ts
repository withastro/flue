import { BigQuery } from '@google-cloud/bigquery';
import { OAuth2Client } from 'google-auth-library';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface BigQueryRunInput {
	sql: string;
	maxGb: number;
	maxRows?: number;
	projectId?: string;
	credentialMode?: 'service_account' | 'user_oauth';
	userAccessToken?: string;
	outputDir?: string;
	now?: Date;
	client?: BigQueryLike;
}

export interface BigQueryRunResult {
	ok: true;
	rows: number;
	bytes_processed: number;
	bytes_billed: string;
	columns: string[];
	result_path: string;
	truncated: boolean;
	max_rows: number;
	auth_mode: 'service_account' | 'user_oauth';
	project_id: string;
}

export interface BigQueryDistinctValuesInput {
	relation: string;
	column: string;
	maxGb: number;
	limit?: number;
	whereSql?: string;
	caseInsensitiveLike?: string;
	projectId?: string;
	credentialMode?: 'service_account' | 'user_oauth';
	userAccessToken?: string;
	client?: BigQueryLike;
}

export interface BigQueryDistinctValuesResult {
	ok: true;
	relation: string;
	column: string;
	values: Array<{ value: string; row_count: number }>;
	bytes_processed: number;
	bytes_billed: string;
	limit: number;
	auth_mode: 'service_account' | 'user_oauth';
	project_id: string;
	sql: string;
}

export interface BigQueryValidationInput {
	sql: string;
	maxGb: number;
	projectId?: string;
	credentialMode?: 'service_account' | 'user_oauth';
	userAccessToken?: string;
	client?: BigQueryLike;
}

export interface BigQueryValidationResult {
	ok: true;
	bytes_processed: number;
	bytes_billed: string;
	columns: string[];
	auth_mode: 'service_account' | 'user_oauth';
	project_id: string;
	sql: string;
}

export interface BigQueryAggregateInput {
	relation: string;
	maxGb: number;
	whereSql?: string;
	projectId?: string;
	credentialMode?: 'service_account' | 'user_oauth';
	userAccessToken?: string;
	client?: BigQueryLike;
}

export interface BigQueryDateRangeInput extends BigQueryAggregateInput {
	column: string;
}

export interface BigQueryLike {
	createQueryJob(options: Record<string, unknown>): Promise<any[]>;
}

interface BigQueryJobLike {
	metadata?: any;
	getMetadata(): Promise<any[]>;
	getQueryResults(options: Record<string, unknown>): Promise<any[]>;
}

const forbiddenSql = [
	'alter',
	'create',
	'delete',
	'drop',
	'insert',
	'merge',
	'truncate',
	'update',
	'grant',
	'revoke',
	'call',
	'export',
	'load',
];

export async function runBigQuery(input: BigQueryRunInput): Promise<BigQueryRunResult> {
	const sql = normalizeReadOnlySql(input.sql);
	const maxRows = input.maxRows ?? 10_000;
	const maxBytes = Math.floor(input.maxGb * 1024 ** 3);
	const projectId = input.projectId || process.env.GOOGLE_CLOUD_PROJECT || 'evenup-bi';
	const credentialMode = input.credentialMode ?? 'service_account';
	const client =
		input.client ??
		(createBigQueryClient({ projectId, credentialMode, userAccessToken: input.userAccessToken }) as BigQueryLike);

	const bytesProcessed = await dryRunQuery(client, sql);
	if (bytesProcessed > maxBytes) {
		throw new Error(
			`QUERY TOO LARGE: estimated ${formatBytes(bytesProcessed)} exceeds ${input.maxGb.toFixed(2)} GB limit. ` +
				'Add a more restrictive WHERE clause or increase maxGb after review.',
		);
	}

	const job = await createExecutableQueryJob(client, sql, maxBytes);
	const [metadata] = await job.getMetadata();
	const rows = await readRows(job, maxRows + 1);
	const truncated = rows.length > maxRows;
	const boundedRows = truncated ? rows.slice(0, maxRows) : rows;
	const columns = columnsFromMetadata(metadata, boundedRows);
	const resultPath = await writeBigQueryCsv({
		rows: boundedRows,
		columns,
		outputDir: input.outputDir ?? '/tmp',
		now: input.now ?? new Date(),
	});

	return {
		ok: true,
		rows: boundedRows.length,
		bytes_processed: bytesProcessed,
		bytes_billed: formatBytes(bytesProcessed),
		columns,
		result_path: resultPath,
		truncated,
		max_rows: maxRows,
		auth_mode: credentialMode,
		project_id: projectId,
	};
}

export async function getDistinctValues(
	input: BigQueryDistinctValuesInput,
): Promise<BigQueryDistinctValuesResult> {
	const limit = input.limit ?? 50;
	const column = quoteColumnPath(input.column);
	const relation = quoteRelation(input.relation);
	const whereSql = input.whereSql ? `AND (${normalizeReadOnlyCondition(input.whereSql)})` : '';
	const caseInsensitiveLike = input.caseInsensitiveLike?.trim();
	if (caseInsensitiveLike === '') {
		throw new Error('caseInsensitiveLike must be non-empty when provided.');
	}
	const likeSql = caseInsensitiveLike
		? `AND LOWER(CAST(${column} AS STRING)) LIKE @case_insensitive_like`
		: '';
	const params = caseInsensitiveLike ? { case_insensitive_like: caseInsensitiveLike.toLowerCase() } : undefined;
	const sql = [
		`SELECT CAST(${column} AS STRING) AS value, COUNT(*) AS row_count`,
		`FROM ${relation}`,
		`WHERE ${column} IS NOT NULL`,
		whereSql,
		likeSql,
		'GROUP BY 1',
		'ORDER BY row_count DESC, value',
		`LIMIT ${limit}`,
	].filter(Boolean).join('\n');

	const maxBytes = Math.floor(input.maxGb * 1024 ** 3);
	const projectId = input.projectId || process.env.GOOGLE_CLOUD_PROJECT || 'evenup-bi';
	const credentialMode = input.credentialMode ?? 'service_account';
	const client =
		input.client ??
		(createBigQueryClient({ projectId, credentialMode, userAccessToken: input.userAccessToken }) as BigQueryLike);
	const bytesProcessed = await dryRunQuery(client, sql, params);
	if (bytesProcessed > maxBytes) {
		throw new Error(
			`QUERY TOO LARGE: estimated ${formatBytes(bytesProcessed)} exceeds ${input.maxGb.toFixed(2)} GB limit. ` +
				'Add a narrower whereSql filter or increase maxGb after review.',
		);
	}

	const job = await createExecutableQueryJob(client, sql, maxBytes, params);
	const rows = await readRows(job, limit);
	return {
		ok: true,
		relation: input.relation,
		column: input.column,
		values: rows.map((row) => ({
			value: row.value === null || row.value === undefined ? '' : String(row.value),
			row_count: Number(row.row_count) || 0,
		})),
		bytes_processed: bytesProcessed,
		bytes_billed: formatBytes(bytesProcessed),
		limit,
		auth_mode: credentialMode,
		project_id: projectId,
		sql,
	};
}

export async function validateBigQuery(input: BigQueryValidationInput): Promise<BigQueryValidationResult> {
	const sql = normalizeReadOnlySql(input.sql);
	const maxBytes = Math.floor(input.maxGb * 1024 ** 3);
	const projectId = input.projectId || process.env.GOOGLE_CLOUD_PROJECT || 'evenup-bi';
	const credentialMode = input.credentialMode ?? 'service_account';
	const client =
		input.client ??
		(createBigQueryClient({ projectId, credentialMode, userAccessToken: input.userAccessToken }) as BigQueryLike);
	const { bytesProcessed, metadata } = await dryRunQueryWithMetadata(client, sql);
	if (bytesProcessed > maxBytes) {
		throw new Error(
			`QUERY TOO LARGE: estimated ${formatBytes(bytesProcessed)} exceeds ${input.maxGb.toFixed(2)} GB limit. ` +
				'Add a narrower WHERE clause or increase maxGb after review.',
		);
	}
	return {
		ok: true,
		bytes_processed: bytesProcessed,
		bytes_billed: formatBytes(bytesProcessed),
		columns: columnsFromMetadata(metadata, []),
		auth_mode: credentialMode,
		project_id: projectId,
		sql,
	};
}

export async function getRowCount(input: BigQueryAggregateInput) {
	const relation = quoteRelation(input.relation);
	const whereSql = input.whereSql ? `WHERE ${normalizeReadOnlyCondition(input.whereSql)}` : '';
	const sql = [`SELECT COUNT(*) AS row_count`, `FROM ${relation}`, whereSql].filter(Boolean).join('\n');
	const result = await runSingleRowQuery(input, sql);
	return {
		ok: true,
		relation: input.relation,
		row_count: Number(result.row.row_count) || 0,
		bytes_processed: result.bytesProcessed,
		bytes_billed: formatBytes(result.bytesProcessed),
		auth_mode: result.credentialMode,
		project_id: result.projectId,
		sql,
	};
}

export async function getDateRange(input: BigQueryDateRangeInput) {
	const column = quoteColumnPath(input.column);
	const relation = quoteRelation(input.relation);
	const whereSql = input.whereSql ? `AND (${normalizeReadOnlyCondition(input.whereSql)})` : '';
	const sql = [
		`SELECT`,
		`  MIN(${column}) AS min_value,`,
		`  MAX(${column}) AS max_value,`,
		`  COUNTIF(${column} IS NOT NULL) AS non_null_count,`,
		`  COUNT(*) AS row_count`,
		`FROM ${relation}`,
		`WHERE TRUE`,
		whereSql,
	].filter(Boolean).join('\n');
	const result = await runSingleRowQuery(input, sql);
	return {
		ok: true,
		relation: input.relation,
		column: input.column,
		min_value: serializeCell(result.row.min_value),
		max_value: serializeCell(result.row.max_value),
		non_null_count: Number(result.row.non_null_count) || 0,
		row_count: Number(result.row.row_count) || 0,
		bytes_processed: result.bytesProcessed,
		bytes_billed: formatBytes(result.bytesProcessed),
		auth_mode: result.credentialMode,
		project_id: result.projectId,
		sql,
	};
}

export function normalizeReadOnlySql(sql: string): string {
	const trimmed = sql.trim();
	if (!trimmed) throw new Error('SQL must be non-empty.');
	const masked = maskCommentsAndLiterals(trimmed).trim();
	if (!/^(select|with)\b/i.test(masked)) {
		throw new Error('QUERY REJECTED: only SELECT or WITH queries are permitted.');
	}
	if (hasMultipleStatements(masked)) {
		throw new Error('QUERY REJECTED: multiple SQL statements are not permitted.');
	}
	for (const keyword of forbiddenSql) {
		if (new RegExp(`\\b${keyword}\\b`, 'i').test(masked)) {
			throw new Error(`QUERY REJECTED: ${keyword.toUpperCase()} operations are not allowed.`);
		}
	}
	return trimmed.replace(/;\s*$/, '');
}

export function normalizeReadOnlyCondition(condition: string): string {
	const trimmed = condition.trim();
	if (!trimmed) throw new Error('whereSql must be non-empty when provided.');
	const masked = maskCommentsAndLiterals(trimmed).trim();
	if (hasMultipleStatements(masked)) {
		throw new Error('QUERY REJECTED: multiple SQL statements are not permitted in whereSql.');
	}
	if (/^(select|with)\b/i.test(masked)) {
		throw new Error('QUERY REJECTED: whereSql must be a boolean condition, not a query.');
	}
	for (const keyword of forbiddenSql) {
		if (new RegExp(`\\b${keyword}\\b`, 'i').test(masked)) {
			throw new Error(`QUERY REJECTED: ${keyword.toUpperCase()} operations are not allowed in whereSql.`);
		}
	}
	return trimmed.replace(/;\s*$/, '');
}

export function formatBytes(bytes: number): string {
	let value = bytes;
	for (const unit of ['B', 'KB', 'MB', 'GB']) {
		if (value < 1024) return `${value.toFixed(1)} ${unit}`;
		value /= 1024;
	}
	return `${value.toFixed(1)} TB`;
}

export async function writeBigQueryCsv(input: {
	rows: Record<string, unknown>[];
	columns: string[];
	outputDir: string;
	now: Date;
}): Promise<string> {
	const timestamp = toTimestamp(input.now);
	const outputPath = path.join(input.outputDir, `bq_result_${timestamp}.csv`);
	const lines = [
		input.columns.map(csvEscape).join(','),
		...input.rows.map((row) => input.columns.map((column) => csvEscape(serializeCell(row[column]))).join(',')),
	];
	await fs.writeFile(outputPath, `${lines.join('\n')}\n`, 'utf8');
	return outputPath;
}

function createBigQueryClient(input: {
	projectId: string;
	credentialMode: 'service_account' | 'user_oauth';
	userAccessToken?: string;
}): BigQuery {
	if (input.credentialMode === 'user_oauth') {
		const token = input.userAccessToken || process.env.GOOGLE_USER_ACCESS_TOKEN;
		if (!token) {
			throw new Error('GOOGLE_USER_ACCESS_TOKEN is required for user_oauth BigQuery mode.');
		}
		const authClient = new OAuth2Client();
		authClient.setCredentials({ access_token: token });
		return new BigQuery({ projectId: input.projectId, authClient });
	}
	return new BigQuery({ projectId: input.projectId });
}

async function dryRunQuery(client: BigQueryLike, sql: string, params?: Record<string, unknown>): Promise<number> {
	return (await dryRunQueryWithMetadata(client, sql, params)).bytesProcessed;
}

async function dryRunQueryWithMetadata(
	client: BigQueryLike,
	sql: string,
	params?: Record<string, unknown>,
): Promise<{ bytesProcessed: number; metadata: any }> {
	const [job] = await client.createQueryJob({
		query: sql,
		params,
		dryRun: true,
		useQueryCache: false,
	});
	if (!job) throw new Error('BigQuery dry-run did not return a job.');
	const metadata = job.metadata ?? (await job.getMetadata())[0];
	const raw = metadata?.statistics?.totalBytesProcessed ?? metadata?.statistics?.query?.totalBytesProcessed ?? 0;
	return { bytesProcessed: Number(raw) || 0, metadata };
}

async function createExecutableQueryJob(
	client: BigQueryLike,
	sql: string,
	maxBytes: number,
	params?: Record<string, unknown>,
): Promise<BigQueryJobLike> {
	const [job] = await client.createQueryJob({
		query: sql,
		params,
		useQueryCache: false,
		maximumBytesBilled: String(maxBytes),
	});
	if (!job) throw new Error('BigQuery execution did not return a job.');
	return job;
}

async function readRows(job: BigQueryJobLike, maxRows: number): Promise<Record<string, unknown>[]> {
	const [rows] = await job.getQueryResults({ maxResults: maxRows });
	return rows;
}

async function runSingleRowQuery(input: BigQueryAggregateInput, sql: string) {
	const maxBytes = Math.floor(input.maxGb * 1024 ** 3);
	const projectId = input.projectId || process.env.GOOGLE_CLOUD_PROJECT || 'evenup-bi';
	const credentialMode = input.credentialMode ?? 'service_account';
	const client =
		input.client ??
		(createBigQueryClient({ projectId, credentialMode, userAccessToken: input.userAccessToken }) as BigQueryLike);
	const bytesProcessed = await dryRunQuery(client, sql);
	if (bytesProcessed > maxBytes) {
		throw new Error(
			`QUERY TOO LARGE: estimated ${formatBytes(bytesProcessed)} exceeds ${input.maxGb.toFixed(2)} GB limit. ` +
				'Add a narrower whereSql filter or increase maxGb after review.',
		);
	}
	const job = await createExecutableQueryJob(client, sql, maxBytes);
	const rows = await readRows(job, 1);
	return {
		row: rows[0] ?? {},
		bytesProcessed,
		projectId,
		credentialMode,
	};
}

function columnsFromMetadata(metadata: any, rows: Record<string, unknown>[]): string[] {
	const fields = metadata?.statistics?.query?.schema?.fields ?? metadata?.schema?.fields ?? [];
	const metadataColumns = fields.map((field: any) => String(field.name)).filter(Boolean);
	if (metadataColumns.length > 0) return metadataColumns;
	return Object.keys(rows[0] ?? {});
}

function quoteRelation(relation: string): string {
	const parts = relation.replace(/^`|`$/g, '').split('.');
	if (parts.length < 2 || parts.length > 3) {
		throw new Error('relation must be a dataset.table or project.dataset.table name.');
	}
	for (const part of parts) {
		if (!/^[a-zA-Z0-9_-]+$/.test(part)) {
			throw new Error('relation contains an unsupported identifier segment.');
		}
	}
	return `\`${parts.join('.')}\``;
}

function quoteColumnPath(column: string): string {
	const parts = column.replace(/^`|`$/g, '').split('.');
	if (parts.length === 0) throw new Error('column must be non-empty.');
	for (const part of parts) {
		if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(part)) {
			throw new Error('column contains an unsupported identifier segment.');
		}
	}
	return parts.map((part) => `\`${part}\``).join('.');
}

function hasMultipleStatements(maskedSql: string): boolean {
	const withoutFinalSemicolon = maskedSql.replace(/;\s*$/, '');
	return withoutFinalSemicolon.includes(';');
}

function maskCommentsAndLiterals(sql: string): string {
	let output = '';
	let index = 0;
	while (index < sql.length) {
		const char = sql[index]!;
		const next = sql[index + 1];
		if (char === '-' && next === '-') {
			const end = sql.indexOf('\n', index + 2);
			const stop = end === -1 ? sql.length : end;
			output += ' '.repeat(stop - index);
			index = stop;
			continue;
		}
		if (char === '/' && next === '*') {
			const end = sql.indexOf('*/', index + 2);
			const stop = end === -1 ? sql.length : end + 2;
			output += ' '.repeat(stop - index);
			index = stop;
			continue;
		}
		if (char === '\'' || char === '"' || char === '`') {
			const quote = char;
			output += ' ';
			index++;
			while (index < sql.length) {
				const current = sql[index]!;
				output += ' ';
				if (current === '\\') {
					index += 2;
					output += ' ';
					continue;
				}
				if (current === quote) {
					index++;
					break;
				}
				index++;
			}
			continue;
		}
		output += char;
		index++;
	}
	return output;
}

function csvEscape(value: unknown): string {
	const text = value === undefined || value === null ? '' : String(value);
	if (!/[",\n\r]/.test(text)) return text;
	return `"${text.replaceAll('"', '""')}"`;
}

function serializeCell(value: unknown): string {
	if (value === undefined || value === null) return '';
	if (value instanceof Date) return value.toISOString();
	if (typeof value === 'object') return JSON.stringify(value);
	return String(value);
}

function toTimestamp(date: Date): string {
	const pad = (value: number) => String(value).padStart(2, '0');
	return [
		date.getFullYear(),
		pad(date.getMonth() + 1),
		pad(date.getDate()),
		'_',
		pad(date.getHours()),
		pad(date.getMinutes()),
		pad(date.getSeconds()),
	].join('');
}
