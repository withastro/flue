// Live LLM e2e cost baseline from 2026-05-31 runs through Codex:
// - employee-growth-metabase-card: about $0.69 total; waiter about $0.52, explorer about $0.01, kitchen about $0.15.
// - plaas-matter-flag-caveat: about $0.25 total; waiter about $0.10, explorer about $0.01, kitchen about $0.17.
// - explorer-summary experiment on PLAAS with missing manifest/auth: about $0.65 total; waiter about $0.53,
//   explorer about $0.01, kitchen about $0.12. Summarizing explorer-to-waiter payload alone did not move
//   waiter cost because Opus cache writes across several waiter phases dominated the run.
// - explorer-summary retry on PLAAS with manifest fixed but BigQuery auth blocked: about $0.39 total;
//   waiter about $0.26, explorer about $0.01, kitchen about $0.11. The answer was accepted by postflight and
//   included the GSheet/Hightouch caveat.
// Cost is acceptable for now. Future optimization levers: reduce waiter phases, split waiter phases by model,
// or rely more on cache once prompt/session behavior stabilizes.

export const employeeGrowthFixture = {
	name: 'employee-growth-metabase-card',
	query: 'make a metabase card to track evenup employee growth of all time, only ontario CAN and California USA',
	judgementRules: [
		'Route to analytics with manifest, BigQuery, and Metabase available.',
		'Validate user-facing locations before writing filters: Ontario CAN must map to geo_country=CA and geo_state_province=ON; California USA must map to geo_country=US and geo_state_province=CA.',
		'Use dim_employees_history and monthly last-available-summary_date snapshot semantics, not cumulative hires.',
		'Count distinct employee_canonical_id.',
		'Create a Metabase line card only after query validation succeeds.',
	],
	sourceModel: 'evenup-bi.dbt_prod.dim_employees_history',
	card: {
		title: 'EvenUp Employee Headcount Growth - Ontario (CAN) vs California (USA)',
		description:
			"Monthly active headcount trend for EvenUp employees located in Ontario, Canada or California, USA. Uses evenup-bi.dbt_prod.dim_employees_history and counts distinct employee_canonical_id on the last available summary_date in each month. Abbreviation legend: geo_country = 'CA' means Canada; geo_state_province = 'CA' means California.",
		vizType: 'line' as const,
	},
	expectedFilters: {
		ontario: { geo_country: 'CA', geo_state_province: 'ON', label: 'Ontario, CAN' },
		california: { geo_country: 'US', geo_state_province: 'CA', label: 'California, USA' },
	},
	expectedCoverage: {
		minSummaryDate: '2020-01-01',
		maxSummaryDate: '2026-05-31',
	},
	sql: `
WITH month_end_dates AS (
  SELECT
    DATE_TRUNC(summary_date, MONTH) AS month,
    MAX(summary_date) AS month_snapshot_date
  FROM \`evenup-bi.dbt_prod.dim_employees_history\`
  GROUP BY 1
),
location_labels AS (
  SELECT 'Ontario, CAN' AS location_label
  UNION ALL
  SELECT 'California, USA' AS location_label
),
monthly_counts AS (
  SELECT
    med.month,
    CASE
      WHEN e.geo_country = 'CA' AND e.geo_state_province = 'ON' THEN 'Ontario, CAN'
      WHEN e.geo_country = 'US' AND e.geo_state_province = 'CA' THEN 'California, USA'
    END AS location_label,
    COUNT(DISTINCT e.employee_canonical_id) AS active_employee_headcount
  FROM \`evenup-bi.dbt_prod.dim_employees_history\` AS e
  INNER JOIN month_end_dates AS med
    ON e.summary_date = med.month_snapshot_date
  WHERE (e.geo_country = 'CA' AND e.geo_state_province = 'ON')
     OR (e.geo_country = 'US' AND e.geo_state_province = 'CA')
  GROUP BY 1, 2
)
SELECT
  med.month,
  ll.location_label,
  COALESCE(mc.active_employee_headcount, 0) AS active_employee_headcount
FROM month_end_dates AS med
CROSS JOIN location_labels AS ll
LEFT JOIN monthly_counts AS mc
  ON med.month = mc.month
 AND ll.location_label = mc.location_label
ORDER BY 1, 2
`,
	caveats: [
		'Monthly headcount uses the last available summary_date per month.',
		'Counts distinct employee_canonical_id, not cumulative hires.',
		'Relocated employees count under their location on that month snapshot.',
	],
};

export const plaasMattersFixture = {
	name: 'plaas-matter-flag-caveat',
	query: 'For matters, is there a field indicating if it is a PLAAS case?',
	judgementRules: [
		'Answer no if no direct PLAAS field exists on core matter dimensions.',
		'Validate that labeled_case_type does not encode PLAAS before claiming absence.',
		'Recommend deriving is_plaas from dim_plaas_case membership.',
		'Dedupe dim_plaas_case by evenup_matter_id before joining because it is not one-row-per-matter.',
		'Include the GSheet pipeline freshness/completeness caveat.',
	],
	sourceModels: {
		matter: 'evenup-bi.dbt_prod.dim_matters',
		plaas: 'evenup-bi.dbt_prod.dim_plaas_case',
	},
	expectedJoinCoverage: {
		distinctPlaasMatterIds: 1716,
		matchedMatterIds: 1712,
		unmatchedMatterIds: 4,
	},
	sql: `
WITH plaas_matters AS (
  SELECT DISTINCT evenup_matter_id
  FROM \`evenup-bi.dbt_prod.dim_plaas_case\`
  WHERE evenup_matter_id IS NOT NULL
)
SELECT
  m.matter_id,
  m.firm_name,
  m.labeled_case_type,
  p.evenup_matter_id IS NOT NULL AS is_plaas
FROM \`evenup-bi.dbt_prod.dim_matters\` AS m
LEFT JOIN plaas_matters AS p
  ON m.matter_id = p.evenup_matter_id
`,
	requiredAnswerFragments: [
		'no direct PLAAS',
		'dim_plaas_case',
		'evenup_matter_id',
		'dedupe',
		'GSheet',
	],
	caveats: [
		'No direct PLAAS flag exists on core matter dimensions.',
		'Use dim_plaas_case membership deduped by evenup_matter_id.',
		'dim_plaas_case is sourced from a GSheet-based pipeline, so freshness and completeness depend on that sync.',
	],
};
