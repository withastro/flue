# SQL Templates — MDC KPI Report

All templates return **weekly-grain data** with inline date filters.

**Analysis convention:**
- **Recent period** = last 2 complete weeks by position in the result set
- **Prior period** = the 4 complete weeks before that
- NOTE: mart stores `summary_date` as Tuesdays. Use positional date logic in fill_report.py — do NOT compute Monday anchors and match against it.

---

## Template 0: WEEKLY_MDC_KPIS

**Purpose:** 8-week trend of all MDC KPIs from the pre-aggregated mart.

**Grain:** 1 row per week_start (Tuesday — mart anchor).

```sql
SELECT
  summary_date                    AS week_start,
  num_total_runs,
  num_ci_runs,
  num_non_ci_runs,
  num_firms_with_1_plus_mdc_run,
  num_firms_with_5_plus_mdc_run,
  num_mdc_enabled_firms,
  num_mdc_runs_by_new_user,
  num_mdc_runs_by_repeat_user,
  num_cases_with_dismissed_issue,
  num_cases_with_resolved_issue,
  num_repeat_users,
  avg_turnaround_time,
  avg_issue_per_run,
  pct_mdc_runs_viewed,
  pct_ci_mdc_runs_viewed,
  pct_non_ci_mdc_runs_viewed,
  pct_firms_with_1_plus_mdc_run,
  pct_firms_with_5_plus_mdc_run,
  mdc_runs_per_firm,
  pct_mdc_runs_by_new_user,
  pct_mdc_runs_by_repeat_user,
  pct_cases_with_dismissed_issue,
  pct_cases_with_resolved_issue
FROM `evenup-bi.dbt_prod.mart_missing_doc_check_product_usage_kpi`
WHERE summary_date >= DATE_TRUNC(
    DATE_SUB(CURRENT_DATE('America/New_York'), INTERVAL 8 WEEK), WEEK(MONDAY))
  AND summary_date < DATE_TRUNC(CURRENT_DATE('America/New_York'), WEEK(MONDAY))
ORDER BY week_start
```

**Output:** Up to 8 rows. Validate: non-null `pct_mdc_runs_viewed`, `num_total_runs > 0`.

---

## Template DD1: DEEP_DIVE_CI_MIX

**Purpose:** First-line check when P0 modal open rate drops. Checks if CI share increased (mechanically dilutes total % since non-CI ~40% vs CI ~16%).

```sql
SELECT
  summary_date                                                        AS week_start,
  num_total_runs,
  num_ci_runs,
  num_non_ci_runs,
  SAFE_DIVIDE(num_ci_runs, num_total_runs)                           AS ci_run_share,
  SAFE_DIVIDE(num_non_ci_runs, num_total_runs)                       AS non_ci_run_share,
  pct_mdc_runs_viewed,
  pct_ci_mdc_runs_viewed,
  pct_non_ci_mdc_runs_viewed
FROM `evenup-bi.dbt_prod.mart_missing_doc_check_product_usage_kpi`
WHERE summary_date >= DATE_TRUNC(
    DATE_SUB(CURRENT_DATE('America/New_York'), INTERVAL 8 WEEK), WEEK(MONDAY))
  AND summary_date < DATE_TRUNC(CURRENT_DATE('America/New_York'), WEEK(MONDAY))
ORDER BY week_start
```

**Interpretation:**
- `ci_run_share` increased + segment rates held flat → pure mix shift (noise)
- Both CI and non-CI rates declined → real engagement drop; proceed to firm-level

---

## Template DD2: DEEP_DIVE_CONTRACT_STATUS

Substitute `{FIRM_ID}` with integer firm_id.

```sql
SELECT
  f.firm_id,
  f.firm_name,
  f.csm_email,
  f.is_firm_active,
  s.account_type
FROM `evenup-bi.dbt_prod.dim_companies_and_firms` f
LEFT JOIN `evenup-bi.dbt_prod.dim_salesforce_account` s ON s.account_id = f.account_id
WHERE f.firm_id = {FIRM_ID}
LIMIT 1
```

---

## Template DD3: DEEP_DIVE_MATTER_VOLUME

Substitute `{FIRM_ID}`.

```sql
SELECT
  DATE_TRUNC(mah.summary_week, WEEK(MONDAY))     AS week_start,
  COUNT(DISTINCT mah.matter_id)                   AS active_matters,
  mah.is_ci_matter
FROM `evenup-bi.dbt_prod.dim_matter_activity_weekly_history` mah
INNER JOIN `evenup-bi.dbt_prod.dim_matters` m ON m.matter_id = mah.matter_id
WHERE m.firm_id = {FIRM_ID}
  AND mah.summary_week >= DATE_TRUNC(
      DATE_SUB(CURRENT_DATE('America/New_York'), INTERVAL 8 WEEK), WEEK(MONDAY))
  AND mah.summary_week < DATE_TRUNC(CURRENT_DATE('America/New_York'), WEEK(MONDAY))
GROUP BY week_start, is_ci_matter
ORDER BY week_start, is_ci_matter
```

---

## Template DD4: DEEP_DIVE_CI_SYNC_ERRORS

Substitute `{FIRM_ID}`. Only relevant for CI firms.

```sql
SELECT
  sync_status,
  sync_error,
  COUNT(*)                                          AS matter_count,
  COUNT(*) * 100.0 / SUM(COUNT(*)) OVER ()         AS pct_of_total
FROM `evenup-bi.dbt_prod.mart_integration_matters_and_files`
WHERE firm_id = {FIRM_ID}
GROUP BY sync_status, sync_error
ORDER BY matter_count DESC
LIMIT 20
```
