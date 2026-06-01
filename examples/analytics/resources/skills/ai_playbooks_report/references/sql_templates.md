# SQL Templates — AI Playbooks Report

All templates return **weekly-grain data** with inline date filters. No `date_bounds` CTE — BigQuery can prune partitions from inline expressions.

**Analysis convention (applied after querying, not in SQL):**
- **Recent period** = last 2 complete Mon–Sun weeks
- **Prior period** = the 4 complete weeks before that
- Anchor: `DATE_TRUNC(CURRENT_DATE(), WEEK(MONDAY))`

---

## Table of Contents

| Template | Section | Purpose |
|----------|---------|---------|
| [Template 0](#template-0-weekly_kpi_trend) | WEEKLY_KPI_TREND | 8-week execution trend (pivot: KPIs × weeks) |
| [Template 1](#template-1-execution_kpis) | EXECUTION_KPIS | Completed runs, enabled firms, unique matters — CI/non-CI, 6-week window |
| [Template 1b](#template-1-execution_kpis) | EXECUTION_KPIS firm-grain | Same as Template 1, but by firm (for flagged-firm identification) |
| [Template 2A](#template-2-ux_engagement_kpis) | UX_ENGAGEMENT_KPIS | View/download events from fact_ai_playbook_promptset_result_actions |
| [Template 2B](#template-2-ux_engagement_kpis) | UX_ENGAGEMENT_KPIS (Amplitude) | Run-button press + edited events from fact_amplitude_ai_playbook_events |
| [Template 3](#template-3-firm_week_trend) | FIRM_WEEK_TREND | Week-by-week engagement time series for flagged firms |
| [Template 4](#template-4-first_touch_kpis) | FIRST_TOUCH_KPIS | Time-to-first-use bucket distribution by CI segment |
| [Template 5](#template-5-cost_anomalies) | COST_ANOMALIES | Aggregate LLM cost + token counts (fact_ttx_model_call_cost) |
| [Template 6A](#template-6-baseline_and_penetration) | BASELINE_AND_PENETRATION | Active & addressable matter baselines (dim_matter_activity_weekly_history) |
| [Template 6C](#template-6-baseline_and_penetration) | BASELINE_AND_PENETRATION cohort | New-firm (≤12wk) vs established-firm (>12wk) run split |
| [Template 7](#template-7-deep_dive_contract_status) | DEEP_DIVE_CONTRACT_STATUS | Firm Salesforce lifecycle status + CSM email lookup |
| [Template 8](#template-8-deep_dive_matter_volume) | DEEP_DIVE_MATTER_VOLUME | Weekly matter count for a single firm (caseload change hypothesis) |
| [Template 9](#template-9-deep_dive_ci_sync_errors) | DEEP_DIVE_CI_SYNC_ERRORS | CI sync error rate for a single firm |
| [Template 10](#template-10-deep_dive_user_week_trend) | DEEP_DIVE_USER_WEEK_TREND | Per-user engagement trend for a single firm (user dependency hypothesis) |

---

## Template 1: EXECUTION_KPIS

**Purpose:** Completed non-test AI Playbook runs, enabled firms, unique matters, runs/matter — weekly grain, CI/non-CI split, 6-week window.

**Source:** `stg_lops_sql__public_library_aipromptsetresult` (do NOT use fact_ttx_model_call_cost for run counts)

```sql
SELECT
    DATE_TRUNC(DATE(r.created_at_et), WEEK(MONDAY)) AS week_start,
    m.is_ci_matter,
    COUNT(DISTINCT r.run_id)            AS total_runs,
    COUNT(DISTINCT p.firm_id)           AS enabled_firms,
    COUNT(DISTINCT r.matter_id)         AS distinct_matters,
    COUNT(DISTINCT r.ai_promptset_id)   AS distinct_playbooks,
    COUNTIF(r.is_automated_run = TRUE)  AS automated_runs,
    COUNTIF(r.is_automated_run = FALSE) AS manual_runs,
    COUNTIF(p.is_template = TRUE)       AS template_runs,
    COUNTIF(p.is_template = FALSE)      AS custom_runs
FROM `evenup-bi.dbt_prod.stg_lops_sql__public_library_aipromptsetresult` r
-- Join dim_matters first so m alias is available for the dim_ai_playbook join condition.
-- Join dim_ai_playbook on BOTH keys: (ai_promptset_id, firm_id).
-- Templates are shared across firms; ai_promptset_id alone fans out to N firms.
INNER JOIN `evenup-bi.dbt_prod.dim_matters`     m ON r.matter_id        = m.matter_id
INNER JOIN `evenup-bi.dbt_prod.dim_ai_playbook` p ON r.ai_promptset_id = p.ai_promptset_id
                                                  AND p.firm_id         = m.firm_id
WHERE r.is_test    = FALSE
  AND p.is_deleted = FALSE
  AND DATE(r.created_at_et) >= DATE_TRUNC(CURRENT_DATE(), WEEK(MONDAY)) - 42
  AND DATE(r.created_at_et) <  DATE_TRUNC(CURRENT_DATE(), WEEK(MONDAY))
GROUP BY week_start, is_ci_matter
ORDER BY week_start, is_ci_matter
```

**Flagging logic (apply after reading CSV):**
- Recent = last 2 weeks; prior = 4 weeks before that
- Sum each period, normalize to per-week rate (recent ÷ 2, prior ÷ 4)
- Flag (is_ci_matter) groups where |% change| > 10%; drill into firm-grain below

**Firm-grain variant** — top 10 run increase + top 10 run decrease firms (20 rows max):

```sql
WITH firm_weekly AS (
    SELECT
        DATE_TRUNC(DATE(r.created_at_et), WEEK(MONDAY)) AS week_start,
        p.firm_id,
        p.firm_name,
        m.is_ci_matter,
        COUNT(DISTINCT r.run_id) AS total_runs
    FROM `evenup-bi.dbt_prod.stg_lops_sql__public_library_aipromptsetresult` r
    INNER JOIN `evenup-bi.dbt_prod.dim_ai_playbook` p ON r.ai_promptset_id = p.ai_promptset_id
                                                      AND p.firm_id         = m.firm_id
    INNER JOIN `evenup-bi.dbt_prod.dim_matters`     m ON r.matter_id        = m.matter_id
    WHERE r.is_test    = FALSE
      AND p.is_deleted = FALSE
      AND DATE(r.created_at_et) >= DATE_TRUNC(CURRENT_DATE(), WEEK(MONDAY)) - 42
      AND DATE(r.created_at_et) <  DATE_TRUNC(CURRENT_DATE(), WEEK(MONDAY))
    GROUP BY week_start, firm_id, firm_name, is_ci_matter
),
periods AS (
    SELECT
        firm_id,
        firm_name,
        is_ci_matter,
        SUM(CASE WHEN week_start >= DATE_TRUNC(CURRENT_DATE(), WEEK(MONDAY)) - 14
                 THEN total_runs ELSE 0 END) / 2.0 AS recent_pw,
        SUM(CASE WHEN week_start <  DATE_TRUNC(CURRENT_DATE(), WEEK(MONDAY)) - 14
                 THEN total_runs ELSE 0 END) / 4.0 AS prior_pw
    FROM firm_weekly
    GROUP BY firm_id, firm_name, is_ci_matter
),
with_delta AS (
    SELECT *, recent_pw - prior_pw AS delta
    FROM periods
    WHERE prior_pw >= 3
),
ranked AS (
    SELECT *,
        ROW_NUMBER() OVER (ORDER BY delta DESC) AS rn_grow,
        ROW_NUMBER() OVER (ORDER BY delta ASC)  AS rn_decl
    FROM with_delta
)
SELECT firm_id, firm_name, is_ci_matter, recent_pw, prior_pw, delta
FROM ranked
WHERE rn_grow <= 10 OR rn_decl <= 10
ORDER BY delta DESC
```

---

## Template 0: WEEKLY_KPI_TREND

**Purpose:** 8-week weekly trend of execution KPIs — first section of the report. One row per (week_start).

```sql
SELECT
    DATE_TRUNC(DATE(r.created_at_et), WEEK(MONDAY)) AS week_start,
    COUNT(DISTINCT r.run_id)              AS total_runs,
    COUNT(DISTINCT p.firm_id)             AS active_firms,
    COUNT(DISTINCT r.matter_id)           AS distinct_matters,
    COUNTIF(r.is_automated_run = TRUE)    AS auto_runs,
    COUNTIF(r.is_automated_run = FALSE)   AS manual_runs,
    SAFE_DIVIDE(
        COUNT(DISTINCT r.run_id),
        COUNT(DISTINCT r.matter_id)
    )                                     AS runs_per_matter
FROM `evenup-bi.dbt_prod.stg_lops_sql__public_library_aipromptsetresult` r
INNER JOIN `evenup-bi.dbt_prod.dim_matters`     m ON r.matter_id        = m.matter_id
INNER JOIN `evenup-bi.dbt_prod.dim_ai_playbook` p ON r.ai_promptset_id = p.ai_promptset_id
                                                  AND p.firm_id         = m.firm_id
WHERE r.is_test    = FALSE
  AND p.is_deleted = FALSE
  AND r.run_status = 'complete'
  AND DATE(r.created_at_et) >= DATE_TRUNC(CURRENT_DATE(), WEEK(MONDAY)) - 56
  AND DATE(r.created_at_et) <  DATE_TRUNC(CURRENT_DATE(), WEEK(MONDAY))
GROUP BY week_start
ORDER BY week_start
```

**Output:** 8 rows (totals only). CI note in Section 1 is derived from exec_agg (Template 1) data.

---

## Template 2: UX_ENGAGEMENT_KPIS

**Purpose:** View-tab, view-pinned, download events from the engagement fact; run-button press and edited events from Amplitude — weekly grain, CI/non-CI split, 6-week window.

**IMPORTANT — Validate event_type strings first:**
```sql
SELECT DISTINCT event_type
FROM `evenup-bi.dbt_prod.fact_amplitude_ai_playbook_events`
WHERE event_type LIKE '[AI Playbooks]%'
ORDER BY event_type
LIMIT 50
```
Use returned strings exactly (case-sensitive) in the queries below.

**Part A — View/Download events (fact_ai_playbook_promptset_result_actions):**

```sql
SELECT
    DATE_TRUNC(DATE(e.event_time_et), WEEK(MONDAY)) AS week_start,
    m.is_ci_matter,
    COUNTIF(e.event_type = '[AI Playbooks] View AI Playbook Result')         AS view_tab_count,
    COUNTIF(e.event_type = '[AI Playbooks] View Pinned AI Playbook Result')  AS view_pinned_count,
    COUNTIF(e.event_type = '[AI Playbooks] Download AI Playbook Docx')       AS download_count,
    COUNT(DISTINCT e.matter_id)                                              AS distinct_matters,
    COUNT(DISTINCT e.user_id)                                                AS distinct_users,
    COUNT(DISTINCT e.firm_id)                                                AS distinct_firms
FROM `evenup-bi.dbt_prod.fact_ai_playbook_promptset_result_actions` e
INNER JOIN `evenup-bi.dbt_prod.dim_matters` m ON e.matter_id = m.matter_id
WHERE e.event_time_et IS NOT NULL                              -- actual engagement only (LEFT JOIN model)
  AND DATE(e.event_time_et) >= DATE_TRUNC(CURRENT_DATE(), WEEK(MONDAY)) - 42
  AND DATE(e.event_time_et) <  DATE_TRUNC(CURRENT_DATE(), WEEK(MONDAY))
GROUP BY week_start, is_ci_matter
ORDER BY week_start, is_ci_matter
```

**Part B — Amplitude events (run button + edited):**

```sql
-- Replace event_type strings with exact values from the validation query above.
-- Typical names (verify before use):
--   Run button: '[AI Playbooks] Run AI Playbook'
--   Edited:     '[AI Playbooks] Edit AI Playbook Prompt Result'

SELECT
    DATE_TRUNC(DATE(a.event_time_et), WEEK(MONDAY)) AS week_start,
    m.is_ci_matter,
    a.event_type,
    COUNT(*)                   AS event_count,
    COUNT(DISTINCT a.matter_id)  AS distinct_matters,
    COUNT(DISTINCT a.user_id)    AS distinct_users,
    COUNT(DISTINCT a.firm_id)    AS distinct_firms
FROM `evenup-bi.dbt_prod.fact_amplitude_ai_playbook_events` a
INNER JOIN `evenup-bi.dbt_prod.dim_matters` m ON a.matter_id = m.matter_id
WHERE (a.is_staff = FALSE OR a.is_staff IS NULL)
  AND DATE(a.event_time_et) >= DATE_TRUNC(CURRENT_DATE(), WEEK(MONDAY)) - 42
  AND DATE(a.event_time_et) <  DATE_TRUNC(CURRENT_DATE(), WEEK(MONDAY))
  AND a.event_type IN (
      '[AI Playbooks] Run AI Playbook',          -- VERIFY this string
      '[AI Playbooks] Edit AI Playbook Prompt Result' -- VERIFY this string
  )
GROUP BY week_start, is_ci_matter, event_type
ORDER BY week_start, is_ci_matter, event_type
```

---

## Template 3: FIRM_WEEK_TREND

**Purpose:** Week-by-week engagement time series for flagged firms. Substitute `{FIRM_IDS}` with comma-separated integers.

**Note:** `ai_playbook_engagement_count` = view/download events (not run counts). For run trends use Template 1's firm-grain variant.

```sql
SELECT
    f.summary_week,
    f.firm_id,
    f.firm_name,
    m.is_ci_matter,
    SUM(f.ai_playbook_engagement_count) AS total_engagement,
    COUNT(DISTINCT f.matter_id)         AS distinct_matters,
    COUNT(DISTINCT f.user_id)           AS distinct_users
FROM `evenup-bi.dbt_prod.fact_workflow_and_insight_case_external_usage_by_date` f
INNER JOIN `evenup-bi.dbt_prod.dim_matters` m ON f.matter_id = m.matter_id
WHERE f.firm_id IN ({FIRM_IDS})
  AND f.usage_date >= DATE_TRUNC(CURRENT_DATE(), WEEK(MONDAY)) - 42
  AND f.usage_date <  DATE_TRUNC(CURRENT_DATE(), WEEK(MONDAY))
  AND f.ai_playbook_engagement_count > 0
GROUP BY f.summary_week, f.firm_id, f.firm_name, m.is_ci_matter
ORDER BY f.firm_id, f.summary_week
```

---

## Template 4: FIRST_TOUCH_KPIS

**Purpose:** Distribution of time-to-first-use buckets for AI Playbook, recent vs prior window, CI vs non-CI.

```sql
WITH date_bounds AS (
    SELECT
        DATE_TRUNC(CURRENT_DATE(), WEEK(MONDAY))      AS recent_end,
        DATE_TRUNC(CURRENT_DATE(), WEEK(MONDAY)) - 42 AS prior_start
)

SELECT
    k.summary_week,
    k.is_ci_matter,
    k.first_use_week_0,
    k.first_use_week_1_to_4,
    k.first_use_week_5_to_8,
    k.first_use_week_9_to_12,
    k.first_use_week_13_to_32,
    k.first_use_week_33_plus,
    k.avg_weeks_to_first_use
FROM `evenup-bi.dbt_prod.mart_workflow_and_insight_case_first_touch_kpis` k
CROSS JOIN date_bounds db
WHERE k.product_name = 'AI Playbook'
  AND k.summary_week >= db.prior_start
  AND k.summary_week <  db.recent_end
ORDER BY k.is_ci_matter, k.summary_week
```

---

## Template 5: COST_ANOMALIES

**Purpose:** Aggregate LLM costs and run counts — weekly grain, 6-week window.

One AI Playbook run can consist of multiple LLM calls, so `fact_ttx_model_call_cost` and `stg_lops_sql__public_library_aipromptsetresult` cannot be correlated at row level. Run both queries separately and divide in post-processing to get an approximate cost-per-run.

**Use inline date expressions** (not a CROSS JOIN CTE) so BigQuery can prune partitions on `fact_ttx_model_call_cost`. Without inline predicates this table scans ~20 GB.

**Known schema note:** `call_id` is NULL in `fact_ttx_model_call_cost`; use `COUNT(*)` not `COUNT(DISTINCT call_id)`.

**Part A — Aggregate costs (fact_ttx_model_call_cost):**

⚠ Check whether `matter_id` exists in this table before running. If absent, remove it from SELECT and GROUP BY.

```sql
SELECT
    DATE_TRUNC(c.date_created, WEEK(MONDAY)) AS week_start,
    c.firm_id,
    c.matter_id,
    SUM(c.total_cost)        AS total_cost,
    COUNT(*)                 AS total_llm_calls,
    SUM(c.input_tokens)      AS total_input_tokens,
    SUM(c.output_tokens)     AS total_output_tokens
FROM `evenup-bi.dbt_prod.fact_ttx_model_call_cost` c
WHERE c.product_name  = 'w&i'
  AND c.feature_name  = 'ai_playbooks'
  AND c.date_created >= DATE_TRUNC(CURRENT_DATE(), WEEK(MONDAY)) - 42
  AND c.date_created <  DATE_TRUNC(CURRENT_DATE(), WEEK(MONDAY))
GROUP BY week_start, firm_id, matter_id
ORDER BY week_start, firm_id, matter_id
```

**Part B — Run counts (stg_lops_sql__public_library_aipromptsetresult):**

Use the firm-grain variant of Template 1 — already returns `total_runs` by `week_start, firm_id`. No need to re-run if already executed. For matter grain, add `r.matter_id` to SELECT and GROUP BY in that query.

**Post-processing:**
- Join Part A and Part B on `(week_start, firm_id, matter_id)`
- `approx_cost_per_run` = `total_cost / total_runs` (approximate — LLM calls and runs can't be correlated row-by-row within a matter)
- Flag weeks where `approx_cost_per_run` deviates significantly from the 6-week average

---

## Template 6: BASELINE_AND_PENETRATION

**Purpose:** Active matter baselines, addressable matter baselines, run penetration rate, and firm-cohort split (new ≤12wk vs established >12wk) to separate sales-driven from organic engagement.

**Sources:**
- `dim_matter_activity_weekly_history` — matter × week grain with `case_status`, `is_ai_playbook_eligible`, `is_ci_matter`
- `fact_firm_feature_flags` — firm first-enable date (used for cohort classification only)
- `stg_lops_sql__public_library_aipromptsetresult` + `dim_ai_playbook` + `dim_matters` — run counts (same dual-key join as Template 1)

**⚠ Always filter `summary_week` on `dim_matter_activity_weekly_history`** — it is a matter × week spine since 2020 and will full-scan without a date predicate.

### Part A — Active & Addressable Matter Baselines (weekly, 8 weeks)

```sql
-- Returns: summary_week, is_ci_matter, active_eligible_matters, addressable_matters
-- Run for the same 8-week window as WEEKLY_KPI_TREND to enable overlay.

SELECT
    h.summary_week,
    h.is_ci_matter,
    COUNTIF(h.case_status = 'active'  AND h.is_ai_playbook_eligible = TRUE) AS active_eligible_matters,
    COUNTIF(h.case_status != 'closed' AND h.is_ai_playbook_eligible = TRUE) AS addressable_matters,
    COUNT(DISTINCT IF(h.case_status = 'active' AND h.is_ai_playbook_eligible = TRUE, h.matter_id, NULL)) AS active_eligible_matter_ids
FROM `evenup-bi.dbt_prod.dim_matter_activity_weekly_history` h
WHERE h.summary_week >= DATE_TRUNC(CURRENT_DATE(), WEEK(MONDAY)) - 56
  AND h.summary_week <  DATE_TRUNC(CURRENT_DATE(), WEEK(MONDAY))
GROUP BY h.summary_week, h.is_ci_matter
ORDER BY h.summary_week, h.is_ci_matter
```

### Part B — Run Penetration Rate (overlay with Part A and WEEKLY_KPI_TREND)

After running Part A and WEEKLY_KPI_TREND, compute in post-processing:
- `run_penetration_rate` = `total_runs` / `active_eligible_matters` per (week, is_ci_matter)
- `matter_coverage_rate` = `distinct_matters_with_run` / `active_eligible_matters` per (week, is_ci_matter)

These normalize for matter growth: flat penetration when matter count doubles = proportional scaling, not acceleration.

### Part C — Firm Cohort Split (weekly, organic vs sales-driven)

```sql
-- Classifies firms into new (≤12 weeks since AI Playbooks first enabled) vs established (>12 weeks).
-- Use only fact_firm_feature_flags for cohort classification; is_ai_playbook_eligible in
-- dim_matter_activity_weekly_history is pre-computed and should NOT be used to find first-enable date.

WITH firm_first_enable AS (
    SELECT
        firm_id,
        MIN(summary_date) AS ai_playbook_first_enabled_date
    FROM `evenup-bi.dbt_prod.fact_firm_feature_flags`
    WHERE ai_case_prompts IS TRUE
    GROUP BY firm_id
)

SELECT
    DATE_TRUNC(DATE(r.created_at_et), WEEK(MONDAY)) AS week_start,
    m.is_ci_matter,
    CASE
        WHEN DATE_DIFF(DATE(r.created_at_et), fe.ai_playbook_first_enabled_date, WEEK) <= 12
            THEN 'new_firm'
        ELSE 'established_firm'
    END AS firm_cohort,
    COUNT(DISTINCT r.run_id)    AS total_runs,
    COUNT(DISTINCT p.firm_id)   AS distinct_firms,
    COUNT(DISTINCT r.matter_id) AS distinct_matters
FROM `evenup-bi.dbt_prod.stg_lops_sql__public_library_aipromptsetresult` r
INNER JOIN `evenup-bi.dbt_prod.dim_matters`     m  ON r.matter_id        = m.matter_id
INNER JOIN `evenup-bi.dbt_prod.dim_ai_playbook` p  ON r.ai_promptset_id = p.ai_promptset_id
                                                   AND p.firm_id         = m.firm_id
LEFT JOIN  firm_first_enable                    fe ON p.firm_id          = fe.firm_id
WHERE r.is_test    = FALSE
  AND p.is_deleted = FALSE
  AND DATE(r.created_at_et) >= DATE_TRUNC(CURRENT_DATE(), WEEK(MONDAY)) - 42
  AND DATE(r.created_at_et) <  DATE_TRUNC(CURRENT_DATE(), WEEK(MONDAY))
GROUP BY week_start, is_ci_matter, firm_cohort
ORDER BY week_start, is_ci_matter, firm_cohort
```

**Interpretation:**
- Compare `new_firm` vs `established_firm` run counts in the recent period.
- If the majority of period-over-period growth comes from `new_firm` cohort → growth is primarily sales/onboarding driven.
- Organic signal = `established_firm` recent_runs_per_week vs prior_runs_per_week change.
- Report both cohorts' absolute run counts and their share of total runs.


**Post-processing:**
- Sum last 2 weeks → recent_engagement; sum prior 4 weeks → prior_engagement
- Normalize: recent ÷ 2, prior ÷ 4
- `user_delta` = recent_per_week − prior_per_week
- `pct_of_firm_change` = user_delta / SUM(ABS(user_delta)) across all users
- Flag users where |pct_of_firm_change| > 0.3 (single user driving ≥30% of the shift)
- A user with prior > 0 and recent ≈ 0 → likely departed; prior ≈ 0 and recent > 0 → new/returning

---

## Deep-Dive Templates

These templates are run on-demand for specific firm_ids flagged as significant movers. Substitute `{FIRM_ID}` with the integer firm_id.

---

## Template 7: DEEP_DIVE_CONTRACT_STATUS

**Thesis:** The firm may have churned, gone inactive, or is at-risk — explaining declining engagement as a business outcome rather than a product signal.

**Always run first for any flagged firm.** Returns CSM email needed for escalation regardless of outcome.

**Lifecycle field:** `dim_salesforce_account.account_type` — values: Customer, Churned, Pending Churn, Prospect, Disqualified.

```sql
SELECT
    f.firm_id,
    f.firm_name,
    f.csm_email,
    f.is_firm_active,
    s.account_type           -- Salesforce lifecycle status
FROM `evenup-bi.dbt_prod.dim_companies_and_firms` f
LEFT JOIN `evenup-bi.dbt_prod.dim_salesforce_account` s ON s.account_id = f.account_id
WHERE f.firm_id = {FIRM_ID}
LIMIT 1
```

⚠ Verify join key: `f.account_id = s.account_id` — check that `dim_companies_and_firms.account_id` is the Salesforce account ID.

**Interpretation:**
- `account_type = 'Churned'` → engagement decline is a contract event, not a product issue
- `account_type = 'Pending Churn'` + direction = decrease → imminent churn; escalate to CSM immediately
- `account_type = 'Prospect'` → firm was never fully onboarded; treat differently from active customer decline
- `account_type = 'Disqualified'` → removed from pipeline; deprioritize
- `account_type = 'Customer'` + `is_firm_active = TRUE` → proceed to deeper investigation

---

## Template 8: DEEP_DIVE_MATTER_VOLUME

**Thesis:** Run counts naturally follow caseload. If a firm's matter volume changed, the engagement shift may be structural (more/fewer cases) rather than behavioral (attorneys using AI Playbooks differently).

```sql
SELECT
    DATE_TRUNC(DATE(r.created_at_et), WEEK(MONDAY)) AS week_start,
    COUNT(DISTINCT r.matter_id)  AS distinct_matters,
    COUNT(DISTINCT r.run_id)     AS total_runs
FROM `evenup-bi.dbt_prod.stg_lops_sql__public_library_aipromptsetresult` r
INNER JOIN `evenup-bi.dbt_prod.dim_ai_playbook` p ON r.ai_promptset_id = p.ai_promptset_id
WHERE p.firm_id    = {FIRM_ID}
  AND r.is_test    = FALSE
  AND p.is_deleted = FALSE
  AND DATE(r.created_at_et) >= DATE_TRUNC(CURRENT_DATE(), WEEK(MONDAY)) - 42
  AND DATE(r.created_at_et) <  DATE_TRUNC(CURRENT_DATE(), WEEK(MONDAY))
GROUP BY week_start
ORDER BY week_start
```

**Interpretation:**
- Compare the trajectory of `distinct_matters` vs `total_runs` week-over-week
- If both moved in the same direction and at similar magnitude → caseload explains the run shift
- If runs moved but matters held flat → behavioral change (attorneys running more/fewer playbooks per matter)
- Runs/matter ratio change is the key signal: increasing = deeper per-case usage; decreasing = disengagement per case

---

## Template 9: DEEP_DIVE_CI_SYNC_ERRORS

**Thesis:** For CI firms, sync failures reduce the flow of new matters into EvenUp. Fewer intake-ready matters = fewer AI Playbook run opportunities, independent of attorney behavior.

**Only relevant for CI firms (`is_ci_matter = TRUE`).**

```sql
SELECT
    sync_status,
    sync_error,
    COUNT(*)                                             AS matter_count,
    COUNT(*) * 100.0 / SUM(COUNT(*)) OVER ()            AS pct_of_total
FROM `evenup-bi.dbt_prod.mart_integration_matters_and_files`
WHERE firm_id = {FIRM_ID}
GROUP BY sync_status, sync_error
ORDER BY matter_count DESC
LIMIT 20
```

**Interpretation:**
- What share of matters have non-success sync status or non-null sync_error?
- A high error rate (even 5–10%) concentrated on a specific error type suggests a pipeline issue (credential expiry, schema change, partner API change)
- Cross-reference the error onset timing with the run drop timing — if they align, sync failure is the likely driver

---

## Template 10: DEEP_DIVE_USER_WEEK_TREND

**Thesis:** AI Playbook usage at small-to-mid firms often concentrates in 1–3 power users. A single attorney joining, leaving, or changing workflow can move firm-level metrics materially.

**Note:** This template uses `fact_ai_playbook_promptset_result_actions` (engagement events: views + downloads) because `user_id` is not confirmed available on the stg run table. Engagement events are a strong proxy for active usage. If the stg table exposes `user_id` or `created_by`, a run-based variant is preferable.

```sql
SELECT
    DATE_TRUNC(DATE(e.event_time_et), WEEK(MONDAY)) AS week_start,
    e.user_id,
    COUNT(*)                      AS engagement_events,
    COUNT(DISTINCT e.matter_id)   AS distinct_matters
FROM `evenup-bi.dbt_prod.fact_ai_playbook_promptset_result_actions` e
WHERE e.firm_id        = {FIRM_ID}
  AND e.event_time_et IS NOT NULL
  AND DATE(e.event_time_et) >= DATE_TRUNC(CURRENT_DATE(), WEEK(MONDAY)) - 42
  AND DATE(e.event_time_et) <  DATE_TRUNC(CURRENT_DATE(), WEEK(MONDAY))
GROUP BY week_start, e.user_id
ORDER BY e.user_id, week_start
```

**Post-processing:**
- For each user: recent_pw = sum(last 2 weeks) / 2; prior_pw = sum(prior 4 weeks) / 4
- user_delta = recent_pw − prior_pw
- Share of firm change = user_delta / SUM(|user_delta|) across all users
- Users with prior_pw > 0 and recent_pw ≈ 0 → likely departed or stopped using
- Users with prior_pw ≈ 0 and recent_pw > 0 → new or returning user
- If 1–2 users explain the bulk of the shift, that's a key-person dependency signal
