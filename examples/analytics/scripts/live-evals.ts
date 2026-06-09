import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { employeeGrowthFixture, plaasMattersFixture } from '../test/fixtures/e2e-cases.ts';

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptPath);

type LiveEvalAgent = 'waiter' | 'analytics' | 'explorer' | 'knowledge' | 'workflow' | 'documentation';

// Keep explorer pinned to the lowest tier in live evals. Explorer is a bounded
// retrieval/summarization role here; raising its intelligence should not change
// the behavior under test.
const PINNED_EXPLORER_MODEL = 'openai/gpt-5.4-nano';

export interface LiveEvalCase {
	id: string;
	query: string;
	description: string;
	runAgent: LiveEvalAgent;
	agentsInScope: LiveEvalAgent[];
	runCommand: string;
	payload: Record<string, unknown>;
	expectedReplyType?: 'final' | 'followup_question';
	passCriteria: string[];
	forbiddenReplyPatterns: RegExp[];
}

export interface LiveEvalJudgement {
	caseId: string;
	pass: boolean;
	reasons: string[];
}

// Run these elective live evals when making agent behavior change PRs. Codex is
// the semantic judge; this script only records the exact invocation, raw result,
// and hard guardrail checks.
export const LIVE_EVAL_CASES: LiveEvalCase[] = [
	defineLiveEvalCase({
		id: 'plaas-matter-flag-caveat',
		query: plaasMattersFixture.query,
		description: 'PLAAS matter field answer should include the dim_plaas_case join and GSheet caveat.',
		runAgent: 'waiter',
		agentsInScope: ['waiter', 'explorer', 'analytics'],
		payload: {
			message: plaasMattersFixture.query,
			sessionName: 'live_eval_plaas',
			streamName: 'main',
			source: 'cli',
			allowMetabaseCreate: false,
		},
		expectedReplyType: 'final',
		passCriteria: plaasMattersPassCriteria(),
		forbiddenReplyPatterns: [/waiter|kitchen|station|preflight|work\s*order/i],
	}),
	defineLiveEvalCase({
		id: 'employee-growth-metabase-nonmutating',
		query: employeeGrowthFixture.query,
		description: 'Employee growth card request should validate Ontario/California semantics and block card creation when disabled.',
		runAgent: 'waiter',
		agentsInScope: ['waiter', 'explorer', 'analytics'],
		payload: {
			message: employeeGrowthFixture.query,
			sessionName: 'live_eval_employee_growth',
			streamName: 'main',
			source: 'cli',
			allowMetabaseCreate: false,
		},
		expectedReplyType: 'final',
		passCriteria: employeeGrowthFixture.judgementRules,
		forbiddenReplyPatterns: [/waiter|kitchen|station|preflight|work\s*order/i],
	}),
	defineLiveEvalCase({
		id: 'buckeye-pre-day-1-readiness-followup',
		query: 'can you give me a Pre-Day 1 Readiness Report for the firm Buckeye Law Group Inc.',
		description:
			'Unknown business concept should trigger broad preflight exploration and then a user-facing follow-up instead of a proxy report.',
		runAgent: 'waiter',
		agentsInScope: ['waiter'],
		payload: {
			message: 'can you give me a Pre-Day 1 Readiness Report for the firm Buckeye Law Group Inc.',
			sessionName: 'live_eval_buckeye_pre_day_1',
			streamName: 'main',
			source: 'cli',
		},
		expectedReplyType: 'followup_question',
		passCriteria: [
			'Explorer broadens search across plausible sources and still fails to find a grounded definition for "Pre-Day 1 Readiness Report".',
			'Waiter concludes the request is still not understood well enough to write a station order.',
			'The final user-facing behavior is a follow-up question, not a proxy report.',
			'The follow-up makes clear that the missing issue is the meaning/scope of the request, and asks what the report should include or what template the user means.',
		],
		forbiddenReplyPatterns: [/waiter|kitchen|station|preflight|work\s*order/i],
	}),
	defineLiveEvalCase({
		id: 'irrelevant-out-of-scope-reject',
		query: 'write me a fantasy poem about a dashboard',
		description: 'Clearly irrelevant work should be rejected by intake instead of routed to a station.',
		runAgent: 'waiter',
		agentsInScope: ['waiter'],
		payload: {
			message: 'write me a fantasy poem about a dashboard',
			sessionName: 'live_eval_irrelevant',
			streamName: 'main',
			source: 'cli',
		},
		expectedReplyType: 'final',
		passCriteria: [
			'Reject or explain inability directly.',
			'Do not perform unnecessary expensive domain work for a plainly out-of-scope request.',
			'Return a concise user-facing refusal or blocker without orchestration leakage.',
		],
		forbiddenReplyPatterns: [/waiter|kitchen|station|preflight|work\s*order/i],
	}),
];

export function evaluateLiveEvalResult(testCase: LiveEvalCase, result: { reply?: string; replyType?: string }): LiveEvalJudgement {
	const reasons: string[] = [];
	const reply = result.reply || '';
	for (const pattern of testCase.forbiddenReplyPatterns) {
		if (pattern.test(reply)) reasons.push(`Reply matched forbidden pattern: ${pattern}`);
	}
	if (!['final', 'followup_question'].includes(result.replyType || '')) {
		reasons.push(`Unexpected replyType: ${result.replyType || 'missing'}`);
	} else if (testCase.expectedReplyType && result.replyType !== testCase.expectedReplyType) {
		reasons.push(`Expected replyType ${testCase.expectedReplyType} but got ${result.replyType}`);
	}
	return {
		caseId: testCase.id,
		pass: reasons.length === 0,
		reasons,
	};
}

function plaasMattersPassCriteria(): string[] {
	return [
		...plaasMattersFixture.judgementRules,
		'The answer should include the fact that plaas is sourced on a google sheet as a caveat to user',
	];
}

function defineLiveEvalCase(input: Omit<LiveEvalCase, 'runCommand'>): LiveEvalCase {
	return {
		...input,
		runCommand: buildLiveEvalRunCommand(input.runAgent, input.id, input.payload),
	};
}

function buildLiveEvalRunCommand(
	runAgent: LiveEvalAgent,
	caseId: string,
	payload: Record<string, unknown>,
): string {
	return [
		`EXPLORER_MODEL=${shellQuote(PINNED_EXPLORER_MODEL)}`,
		'ANALYTICS_MODEL="${ANALYTICS_MODEL:-openai/gpt-5.4}"',
		'node ../../packages/cli/bin/flue.mjs run',
		runAgent,
		'--target node',
		`--id ${shellQuote(`live_${caseId}`)}`,
		'--env .env',
		'--env .env.secrets',
		`--payload ${shellQuote(JSON.stringify(payload))}`,
	].join(' ');
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

export function extractFlueRunResult(stdout: string): Record<string, unknown> {
	const trimmed = stdout.trim();
	const start = trimmed.lastIndexOf('\n{');
	const jsonText = start >= 0 ? trimmed.slice(start + 1) : trimmed;
	return JSON.parse(jsonText);
}

async function main() {
	const requestedCase = process.argv.find((arg) => arg.startsWith('--case='))?.slice('--case='.length);
	const cases = requestedCase
		? LIVE_EVAL_CASES.filter((testCase) => testCase.id === requestedCase)
		: LIVE_EVAL_CASES;
	if (requestedCase && cases.length === 0) {
		throw new Error(`Unknown live eval case: ${requestedCase}`);
	}

	const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
	const report: Array<{ case: LiveEvalCase; result?: Record<string, unknown>; judgement?: LiveEvalJudgement; error?: string }> = [];
	for (const testCase of cases) {
		const payload = {
			...testCase.payload,
			sessionName: `${testCase.payload.sessionName}_${timestamp}`,
		};
		const run = spawnSync(
			process.execPath,
			[
				'../../packages/cli/bin/flue.mjs',
				'run',
				testCase.runAgent,
				'--target',
				'node',
				'--id',
				`live_${testCase.id}_${timestamp}`,
				'--env',
				'.env',
				'--env',
				'.env.secrets',
				'--payload',
				JSON.stringify(payload),
			],
			{
				cwd: path.resolve(scriptDir, '..'),
				encoding: 'utf8',
				env: {
					...process.env,
					EXPLORER_MODEL: PINNED_EXPLORER_MODEL,
					ANALYTICS_MODEL: process.env.ANALYTICS_MODEL || 'openai/gpt-5.4',
				},
			},
		);
		if (run.status !== 0) {
			report.push({ case: testCase, error: run.stderr || run.stdout || `Exited with ${run.status}` });
			continue;
		}
		const result = extractFlueRunResult(run.stdout);
		report.push({
			case: testCase,
			result,
			judgement: evaluateLiveEvalResult(testCase, result),
		});
	}

	await fs.mkdir(path.resolve(scriptDir, '../artifacts'), { recursive: true });
	const outputPath = path.resolve(scriptDir, `../artifacts/live-eval-${timestamp}.json`);
	await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
	console.log(outputPath);
}

if (path.resolve(process.argv[1] || '') === scriptPath) {
	main().catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
}
