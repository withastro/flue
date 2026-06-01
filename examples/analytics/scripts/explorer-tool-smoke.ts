import * as fs from 'node:fs';
import * as path from 'node:path';

import { explorerToolset } from '../.flue/toolsets/explorer.ts';
import { createToolPolicy } from '../.flue/tools/policy.ts';

type SmokeStatus = 'pass' | 'fail' | 'skip';

interface SmokeCase {
	name: string;
	args: Record<string, unknown>;
	expectBlocked?: boolean;
	skipIf?: () => string | undefined;
}

interface SmokeResult {
	name: string;
	status: SmokeStatus;
	ms: number;
	preview?: string;
	error?: string;
}

const root = path.resolve(import.meta.dirname, '..');
loadEnvFile(path.join(root, '.env.secrets'));

const policy = createToolPolicy({
	source: 'cli',
	conversationId: 'explorer-tool-smoke',
	runId: `smoke_${Date.now()}`,
	maxGb: 0.1,
});

const tools = new Map(explorerToolset(policy).map((tool) => [tool.name, tool]));
const dynamic = {
	driveFileId: undefined as string | undefined,
};

const cases: SmokeCase[] = [
	{ name: 'read_source_catalog', args: {} },
	{ name: 'read_kb_index', args: {} },
	{ name: 'read_kb_article', args: { path: 'knowledge_base/product_truth.md', pattern: 'Portal', limit: 5 } },
	{ name: 'search_manifest', args: { keywords: ['matter'], searchType: 'name', logic: 'and', includeSql: false } },
	{ name: 'get_model_details', args: { modelName: 'dim_matters', includeSql: false, columnLimit: 20 } },
	{ name: 'dbt_lineage', args: { modelName: 'dim_matters', direction: 'both', depth: 1, includeSql: false } },
	{ name: 'bq_validate_query', args: { sql: 'select 1 as smoke_test', maxGb: 0.1 } },
	{ name: 'bq_row_count', args: { relation: 'evenup-bi.dbt_prod.dim_matters', maxGb: 0.1 } },
	{ name: 'bq_date_range', args: { relation: 'evenup-bi.dbt_prod.dim_matters', column: 'created_at', maxGb: 0.1 } },
	{ name: 'bq_top_values', args: { relation: 'evenup-bi.dbt_prod.dim_matters', column: 'case_status', limit: 5, maxGb: 0.1 } },
	{ name: 'metabase_help', args: { topic: 'overview' } },
	{ name: 'metabase_research', args: { model: 'dim_matters', top: 1, includeSql: false } },
	{ name: 'slack_search', args: { query: 'mike morse', limit: 1 } },
	{
		name: 'slack_read_thread',
		args: {},
		skipIf: () =>
			process.env.SLACK_CHANNEL && process.env.SLACK_THREAD_TS
				? undefined
				: 'SLACK_CHANNEL and SLACK_THREAD_TS are required for a deterministic thread-read smoke test.',
	},
	{ name: 'gdrive_search', args: { text: 'mike morse', limit: 1 } },
	{ name: 'gdrive_list', args: { limit: 1 } },
	{
		name: 'gdrive_read',
		args: {},
		skipIf: () => dynamic.driveFileId ? undefined : 'gdrive_search did not return a file id to read.',
	},
	{
		name: 'gdrive_download',
		args: { outputPath: '/tmp/explorer-tool-smoke-download' },
		skipIf: () => dynamic.driveFileId ? undefined : 'gdrive_search did not return a file id to download.',
	},
	{
		name: 'gdrive_create',
		args: { name: 'flue-explorer-smoke.txt', content: 'smoke test' },
		expectBlocked: true,
	},
	{
		name: 'gdrive_upload',
		args: { path: '/tmp/explorer-tool-smoke-upload.txt', name: 'flue-explorer-smoke-upload.txt' },
		expectBlocked: true,
	},
	{ name: 'jira_taxonomy', args: {} },
	{ name: 'jira_scope', args: { product: 'mdc' } },
	{ name: 'jira_history_query', args: { question: 'What changed in MDC recently?', source: 'auto', limit: 1 } },
	{
		name: 'jira_create_ticket',
		args: { summary: 'Flue smoke test', description: 'This should be blocked by explorer policy.', confirmed: false },
		expectBlocked: true,
	},
	{
		name: 'jira_create_pr',
		args: {
			repo: 'evenup-ai/lops-frontend',
			title: 'Flue smoke test',
			head: 'flue-smoke-test',
			body: 'This should be blocked by explorer policy.',
		},
		expectBlocked: true,
	},
];

await fs.promises.writeFile('/tmp/explorer-tool-smoke-upload.txt', 'smoke test\n', 'utf8');

const results: SmokeResult[] = [];
for (const testCase of cases) {
	if (testCase.skipIf) {
		const reason = testCase.skipIf();
		if (reason) {
			results.push({ name: testCase.name, status: 'skip', ms: 0, error: reason });
			continue;
		}
	}

	const args = { ...testCase.args };
	if ((testCase.name === 'gdrive_read' || testCase.name === 'gdrive_download') && dynamic.driveFileId) {
		args.fileId = dynamic.driveFileId;
	}

	const started = Date.now();
	try {
		const tool = tools.get(testCase.name);
		if (!tool) throw new Error(`Tool is not registered in explorerToolset: ${testCase.name}`);
		const output = await tool.execute(args);
		const ms = Date.now() - started;
		if (testCase.expectBlocked) {
			results.push({
				name: testCase.name,
				status: 'fail',
				ms,
				preview: preview(output),
				error: 'Expected policy block, but tool executed successfully.',
			});
			continue;
		}
		if (testCase.name === 'gdrive_search') {
			dynamic.driveFileId = firstDriveFileId(output);
		}
		results.push({ name: testCase.name, status: 'pass', ms, preview: preview(output) });
	} catch (error) {
		const ms = Date.now() - started;
		const message = error instanceof Error ? error.message : String(error);
		if (testCase.expectBlocked && /disabled|not allowed|mutation/i.test(message)) {
			results.push({ name: testCase.name, status: 'pass', ms, error: message });
		} else {
			results.push({ name: testCase.name, status: 'fail', ms, error: message });
		}
	}
}

const summary = {
	toolset: 'explorer',
	total: results.length,
	pass: results.filter((result) => result.status === 'pass').length,
	fail: results.filter((result) => result.status === 'fail').length,
	skip: results.filter((result) => result.status === 'skip').length,
	results,
};

console.log(JSON.stringify(summary, null, 2));
if (summary.fail > 0) process.exitCode = 1;

function firstDriveFileId(output: string): string | undefined {
	try {
		const parsed = JSON.parse(output);
		const file = Array.isArray(parsed.files) ? parsed.files[0] : undefined;
		return typeof file?.id === 'string' ? file.id : undefined;
	} catch {
		return undefined;
	}
}

function preview(output: string): string {
	return output.length > 600 ? `${output.slice(0, 600)}...` : output;
}

function loadEnvFile(filePath: string) {
	if (!fs.existsSync(filePath)) return;
	const raw = fs.readFileSync(filePath, 'utf8');
	for (const line of raw.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;
		const index = trimmed.indexOf('=');
		if (index === -1) continue;
		const key = trimmed.slice(0, index).trim();
		let value = trimmed.slice(index + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		process.env[key] ??= value;
	}
}
