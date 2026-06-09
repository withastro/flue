import { describe, expect, it } from 'vitest';

import { getDateRange, getDistinctValues, getRowCount, runBigQuery, validateBigQuery } from '../.flue/lib/bigquery.ts';
import { createMetabaseCard } from '../.flue/lib/metabase.ts';
import { createKitchenOrder } from '../.flue/agents/waiter.ts';
import { employeeGrowthFixture, plaasMattersFixture } from './fixtures/e2e-cases.ts';

const runElectiveE2E = process.env.ANALYTICS_E2E_FIXTURES === '1';
const describeE2E = runElectiveE2E ? describe : describe.skip;

function fakeEmployeeBigQueryClient() {
	const calls: Array<Record<string, unknown>> = [];
	const client = {
		calls,
		async createQueryJob(options: Record<string, unknown>) {
			calls.push(options);
			const query = String(options.query);
			if (options.dryRun) return [job({ fields: ['month', 'location_label', 'active_employee_headcount'] })];

			return [job({
				fields: ['month', 'location_label', 'active_employee_headcount'],
				rows: rowsForEmployeeQuery(query),
			})];
		},
	};
	return client;
}

function rowsForEmployeeQuery(query: string) {
	if (query.includes('CAST(`geo_state_province` AS STRING)')) {
		return [
			{ value: 'CA', row_count: 178 },
			{ value: 'ON', row_count: 94 },
		];
	}
	if (query.includes('CAST(`geo_country` AS STRING)')) {
		return [
			{ value: 'US', row_count: 178 },
			{ value: 'CA', row_count: 94 },
		];
	}
	if (query.includes('MIN(`summary_date`) AS min_value')) {
		return [
			{
				min_value: employeeGrowthFixture.expectedCoverage.minSummaryDate,
				max_value: employeeGrowthFixture.expectedCoverage.maxSummaryDate,
				non_null_count: 100_000,
				row_count: 100_000,
			},
		];
	}
	return [
		{ month: '2026-05-01', location_label: 'California, USA', active_employee_headcount: 178 },
		{ month: '2026-05-01', location_label: 'Ontario, CAN', active_employee_headcount: 94 },
	];
}

function fakePlaasBigQueryClient() {
	const calls: Array<Record<string, unknown>> = [];
	const client = {
		calls,
		async createQueryJob(options: Record<string, unknown>) {
			calls.push(options);
			const query = String(options.query);
			if (options.dryRun) return [job({ fields: ['matter_id', 'is_plaas'] })];
			if (query.includes('CAST(`labeled_case_type` AS STRING)')) {
				return [job({
					fields: ['value', 'row_count'],
					rows: [
						{ value: 'Motor Vehicle Accident', row_count: 1000 },
						{ value: 'Premise Liability', row_count: 500 },
						{ value: 'Other', row_count: 100 },
					],
				})];
			}
			if (query.includes('COUNT(*) AS row_count')) {
				return [job({ fields: ['row_count'], rows: [{ row_count: plaasMattersFixture.expectedJoinCoverage.distinctPlaasMatterIds }] })];
			}
			return [job({
				fields: ['plaas_matter_ids', 'matched_matter_ids', 'unmatched_matter_ids'],
				rows: [{
					plaas_matter_ids: plaasMattersFixture.expectedJoinCoverage.distinctPlaasMatterIds,
					matched_matter_ids: plaasMattersFixture.expectedJoinCoverage.matchedMatterIds,
					unmatched_matter_ids: plaasMattersFixture.expectedJoinCoverage.unmatchedMatterIds,
				}],
			})];
		},
	};
	return client;
}

function job(input: { fields: string[]; rows?: Record<string, unknown>[] }) {
	const metadata = {
		statistics: {
			totalBytesProcessed: '4096',
			query: {
				schema: {
					fields: input.fields.map((name) => ({ name })),
				},
			},
		},
	};
	return {
		metadata,
		async getMetadata() {
			return [metadata];
		},
		async getQueryResults() {
			return [input.rows ?? []];
		},
	};
}

describeE2E('elective waiter-kitchen e2e fixtures', () => {
	it('fixture: employee growth creates a Metabase card only after validating coded location values', async () => {
		expect(employeeGrowthFixture.judgementRules).toEqual(expect.arrayContaining([
			expect.stringContaining('Validate user-facing locations'),
			expect.stringContaining('Create a Metabase line card'),
		]));

		const order = createKitchenOrder(employeeGrowthFixture.query, false, undefined, {
			summary:
				"Use dim_employees_history; Ontario is geo_country='CA' + geo_state_province='ON', California is geo_country='US' + geo_state_province='CA'.",
			searchedSources: ['manifest', 'bigquery', 'metabase'],
			queryVariantsTried: ['employee growth ontario california'],
			findings: [],
			candidateModels: [
				{
					name: 'dim_employees_history',
					relationName: employeeGrowthFixture.sourceModel,
					evidence: ['One row per active employee per day.', 'Location filters were validated as codes.'],
					concerns: ['Growth means monthly active headcount snapshot in this fixture.'],
				},
			],
			gaps: [],
		});
		expect(order).toEqual(expect.objectContaining({
			route: 'analytics',
			sources: expect.arrayContaining(['manifest', 'bigquery', 'metabase']),
		}));

		const client = fakeEmployeeBigQueryClient();
		const states = await getDistinctValues({
			relation: employeeGrowthFixture.sourceModel,
			column: 'geo_state_province',
			whereSql: "geo_country IN ('CA', 'US')",
			maxGb: 1,
			client,
		});
		const countries = await getDistinctValues({
			relation: employeeGrowthFixture.sourceModel,
			column: 'geo_country',
			whereSql: "geo_state_province IN ('ON', 'CA')",
			maxGb: 1,
			client,
		});
		const dateRange = await getDateRange({
			relation: employeeGrowthFixture.sourceModel,
			column: 'summary_date',
			maxGb: 1,
			client,
		});
		const validation = await validateBigQuery({ sql: employeeGrowthFixture.sql, maxGb: 1, client });
		const result = await runBigQuery({
			sql: employeeGrowthFixture.sql,
			maxGb: 1,
			client,
			outputDir: '/tmp',
			now: new Date('2026-05-31T00:00:00Z'),
		});

		expect(states.values.map((row) => row.value)).toEqual(['CA', 'ON']);
		expect(countries.values.map((row) => row.value)).toEqual(['US', 'CA']);
		expect(dateRange).toEqual(expect.objectContaining({
			min_value: employeeGrowthFixture.expectedCoverage.minSummaryDate,
			max_value: employeeGrowthFixture.expectedCoverage.maxSummaryDate,
		}));
		expect(validation.columns).toEqual(['month', 'location_label', 'active_employee_headcount']);
		expect(result).toEqual(expect.objectContaining({ ok: true, rows: 2 }));

		const calls: Array<{ url: string; init?: RequestInit }> = [];
		const card = await createMetabaseCard({
			vizType: employeeGrowthFixture.card.vizType,
			name: employeeGrowthFixture.card.title,
			description: employeeGrowthFixture.card.description,
			query: employeeGrowthFixture.sql,
			vizSettings: {
				'graph.dimensions': ['month', 'location_label'],
				'graph.metrics': ['active_employee_headcount'],
				'graph.x_axis.scale': 'timeseries',
				'graph.y_axis.min': 0,
			},
			apiKey: 'mb-test',
			metabaseUrl: 'https://metabase.test',
			fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
				calls.push({ url: String(url), init });
				return new Response(JSON.stringify({ id: 14663, name: employeeGrowthFixture.card.title }));
			}) as any,
		});

		const payload = JSON.parse(String(calls[0]?.init?.body));
		expect(card).toEqual(expect.objectContaining({ card_id: 14663, url: 'https://metabase.test/question/14663' }));
		expect(payload.dataset_query.native.query).toContain("geo_country = 'CA'");
		expect(payload.dataset_query.native.query).toContain("geo_state_province = 'ON'");
		expect(payload.dataset_query.native.query).toContain("geo_country = 'US'");
		expect(payload.dataset_query.native.query).not.toContain("geo_country = 'CAN'");
		expect(payload.dataset_query.native.query).not.toContain("geo_state_province = 'California'");
		expect(payload.description).toContain("geo_country = 'CA' means Canada");
	});

	it('fixture: PLAAS matters answer includes deduped join and GSheet caveat', async () => {
		expect(plaasMattersFixture.judgementRules).toEqual(expect.arrayContaining([
			expect.stringContaining('no direct PLAAS field'),
			expect.stringContaining('GSheet pipeline'),
		]));

		const order = createKitchenOrder(plaasMattersFixture.query, false, undefined, {
			summary: 'Core matter dims have no direct PLAAS field; use dim_plaas_case membership.',
			searchedSources: ['manifest', 'bigquery'],
			queryVariantsTried: ['plaas case field matter'],
			findings: [],
			candidateModels: [
				{
					name: 'dim_plaas_case',
					relationName: plaasMattersFixture.sourceModels.plaas,
					evidence: ['Contains evenup_matter_id for PLAAS membership.', 'Source caveat: GSheet pipeline.'],
					concerns: ['Weekly grain requires dedupe before joining.'],
				},
			],
			gaps: [],
		});
		expect(order).toEqual(expect.objectContaining({
			route: 'analytics',
			sources: expect.arrayContaining(['manifest']),
		}));

		const client = fakePlaasBigQueryClient();
		const dimMatterTypes = await getDistinctValues({
			relation: plaasMattersFixture.sourceModels.matter,
			column: 'labeled_case_type',
			caseInsensitiveLike: '%plaas%',
			maxGb: 1,
			client,
		});
		const plaasCount = await getRowCount({
			relation: plaasMattersFixture.sourceModels.plaas,
			whereSql: 'evenup_matter_id IS NOT NULL',
			maxGb: 1,
			client,
		});
		const validation = await validateBigQuery({ sql: plaasMattersFixture.sql, maxGb: 1, client });
		const joinCheck = await runBigQuery({
			sql: `
WITH plaas_matters AS (
  SELECT DISTINCT evenup_matter_id
  FROM \`evenup-bi.dbt_prod.dim_plaas_case\`
  WHERE evenup_matter_id IS NOT NULL
)
SELECT
  COUNT(*) AS plaas_matter_ids,
  COUNTIF(m.matter_id IS NOT NULL) AS matched_matter_ids,
  COUNTIF(m.matter_id IS NULL) AS unmatched_matter_ids
FROM plaas_matters p
LEFT JOIN \`evenup-bi.dbt_prod.dim_matters\` m
  ON p.evenup_matter_id = m.matter_id
`,
			maxGb: 1,
			client,
			outputDir: '/tmp',
			now: new Date('2026-05-31T00:00:00Z'),
		});

		expect(dimMatterTypes.values.map((row) => row.value.toLowerCase())).not.toContain('plaas');
		expect(plaasCount.row_count).toBe(plaasMattersFixture.expectedJoinCoverage.distinctPlaasMatterIds);
		expect(validation.columns).toEqual(['matter_id', 'is_plaas']);
		expect(joinCheck).toEqual(expect.objectContaining({ ok: true, rows: 1 }));
		expect(client.calls.some((call) => String(call.query).includes('SELECT DISTINCT evenup_matter_id'))).toBe(true);

		const answer = [
			'No direct PLAAS field exists on dim_matters.',
			'Use dim_plaas_case, deduped on evenup_matter_id, to derive is_plaas.',
			'dim_plaas_case is sourced from a GSheet-based pipeline, so freshness and completeness depend on that sync.',
			plaasMattersFixture.sql,
		].join('\n');
		for (const fragment of plaasMattersFixture.requiredAnswerFragments) {
			expect(answer.toLowerCase()).toContain(fragment.toLowerCase());
		}
		expect(answer).toContain('SELECT DISTINCT evenup_matter_id');
		expect(answer).toContain('GSheet-based pipeline');
	});
});
