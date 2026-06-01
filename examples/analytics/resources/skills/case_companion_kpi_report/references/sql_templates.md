# SQL Templates — Case Companion KPI Report

All templates return **weekly-grain data** with inline date filters.

**Analysis convention (applied after querying, not in SQL):**
- **Recent period** = last 2 complete Mon–Sun weeks
- **Prior period** = the 4 complete weeks before that
- Anchor: `DATE_TRUNC(CURRENT_DATE(), WEEK(MONDAY))`

---

## Table of Contents

| Template | Section | Purpose |
|----------|---------|---------|
| [Template 0](#template-0-weekly_wau_trend) | WEEKLY_WAU_TREND | 8-week WAU + question volume + mode/origin shares (mart_case_companion_usage) |
| [Template 0B](#template-0b-section1_wai_fact) | SECTION1_WAI_FACT | EvenUp WAU, pre/post-doc query share, new CC user rate (fact_workflow table) |
| [Template 1](#template-1-execution_kpis) | EXECUTION_KPIS | WAU, questions, matters — CI/non-CI split, 6-week window |
| [Template 1b](#template-1b-firm_wau_movers) | FIRM_WAU_MOVERS | Top 10 WAU-increasing + top 10 WAU-decreasing firms |
| [Template 2](#template-2-quality_kpis) | QUALITY_KPIS | Is-helpful rate, copy rate, mode distribution — CI split |
| [Template 3](#template-3-latency_kpis) | LATENCY_KPIS | P50/P95 response latency proxy (updated_at − created_at) |
| [Template 4](#template-4-first_touch_kpis) | FIRST_TOUCH_KPIS | Time-to-first-use distribution from mart_w&i_first_touch |
| [Template 5](#template-5-firm_week_trend) | FIRM_WEEK_TREND | WAU time series for specific flagged firms |
| [Template 6](#template-6-deep_dive_contract_status) | DEEP_DIVE_CONTRACT_STATUS | Firm Salesforce lifecycle + CSM email |
| [Template 7](#template-7-deep_dive_matter_volume) | DEEP_DIVE_MATTER_VOLUME | Active matter count vs CC WAU for a single firm |
| [Template 8](#template-8-deep_dive_ci_sync_errors) | DEEP_DIVE_CI_SYNC_ERRORS | CI sync error rate for a single firm |
| [Template 9](#template-9-deep_dive_user_week_trend) | DEEP_DIVE_USER_WEEK_TREND | Per-user CC activity for a single firm |
| [Template 10](#template-10-deep_dive_latency_by_mode) | DEEP_DIVE_LATENCY_BY_MODE | Latency breakdown by mode to explain aggregate latency shift |

---

## Template 0: WEEKLY_WAU_TREND

**Purpose:** 8-week trend of core CC KPIs — totals only (no CI split). Feeds Section 1 of the report.

**Grain:** 1 row per week_start.

```sql
SELECT
    DATE_TRUNC(DATE(cc.created_at_et), WEEK(MONDAY)) AS week_start,
    COUNT(DISTINCT cc.question_asker_id)              AS wau,
    COUNT(cc.question_id)                             AS total_questions,
    COUNT(DISTINCT cc.matter_id)                      AS distinct_matters,
    COUNT(DISTINCT cc.firm_id)                        AS active_firms,
    SAFE_DIVIDE(
        COUNT(cc.question_id),
        COUNT(DISTINCT cc.question_asker_id)
    )                                                 AS questions_per_user,
    SAFE_DIVIDE(
        COUNT(cc.question_id),
        COUNT(DISTINCT cc.matter_id)
    )                                                 AS questions_per_matter
FROM `evenup-bi.dbt_prod.mart_case_companion_usage` cc
WHERE cc.is_question_asker_internal = FALSE
  AND DATE(cc.created_at_et) >= DATE_TRUNC(CURRENT_DATE(), WEEK(MONDAY)) - 56
  AND DATE(cc.created_at_et) <  DATE_TRUNC(CURRENT_DATE(), WEEK(MONDAY))
GROUP BY week_start
ORDER BY week_start
```

**Output:** 8 rows. Validate shape: 8 rows, non-null `wau` column. Row count for the most recent week may be low (in-progress week — confirm it's excluded by `< current_week_monday`).

---

## Template 0B: SECTION1_WAI_FACT

**Purpose:** Feeds Section 1 rows 2, 4, 5, 6, 7, 8, 9 — EvenUp WAU (any product), 3-way doc-status query shares, and new CC user rate.

**Sources:**
- `fact_workflow_and_insight_case_external_usage_by_date` — total_ewau, cc_wau, new users
- `mart_case_companion_usage` + `demand_intake_questionnaire` — pre/pending/post doc request shares

**Grain:** 1 row per week_start (8 weeks).

**Notes:**
- `total_ewau` = users with any W&I product engagement that week — proxy for "Total EvenUp WAU". Portal-wide login WAU (Amplitude) is not available in BQ.
- `new_cc_users_this_week` uses `user_first_week_cc_engagement = summary_week` which is **per-matter, not per-user-ever**. This overcounts; treat as directional only.
- Doc status classification matches Metabase card 7196 logic using `demand_intake_questionnaire.requested_at_et` (submission) and `first_completed_at_et` (completion).
  - **Pre**: no demand request exists, OR query was before submission
  - **Pending**: query was after submission but before (or without) completion
  - **Post**: query was after both submission and completion

```sql
WITH
-- ── W&I FACT: total EvenUp WAU + new CC user signal ──────────────────────────
wai_weekly AS (
    SELECT
        summary_week,
        user_id,
        SUM(cc_usage_total) AS cc_usage_total,
        MAX(CASE WHEN user_first_week_cc_engagement = summary_week THEN 1 ELSE 0 END) AS is_new_cc_user,
        SUM(
            COALESCE(cc_usage_total,0) + COALESCE(mdc_runs_total,0)
            + COALESCE(vdd_views_total,0) + COALESCE(ai_doc_requests_total,0)
            + COALESCE(bills_summary_modal_views,0) + COALESCE(cmp_view_count,0)
            + COALESCE(ai_playbook_engagement_count,0)
        ) AS any_product_usage
    FROM `evenup-bi.dbt_prod.fact_workflow_and_insight_case_external_usage_by_date`
    WHERE summary_week >= DATE_TRUNC(CURRENT_DATE(), WEEK(MONDAY)) - 56
      AND summary_week <  DATE_TRUNC(CURRENT_DATE(), WEEK(MONDAY))
    GROUP BY summary_week, user_id
),
wai_agg AS (
    SELECT
        summary_week                                                                    AS week_start,
        COUNT(DISTINCT CASE WHEN any_product_usage > 0 THEN user_id END)              AS total_ewau,
        COUNT(DISTINCT CASE WHEN cc_usage_total > 0    THEN user_id END)              AS cc_wau_fact,
        SUM(is_new_cc_user)                                                            AS new_cc_users_this_week,
        SAFE_DIVIDE(
            SUM(is_new_cc_user),
            NULLIF(COUNT(DISTINCT CASE WHEN cc_usage_total > 0 THEN user_id END), 0)
        )                                                                              AS new_cc_user_rate
    FROM wai_weekly
    GROUP BY summary_week
),

-- ── DOC STATUS: 3-way classification (matches Metabase card 7196) ─────────────
doc_classified AS (
    SELECT
        DATE_TRUNC(DATE(ccu.created_at_et), WEEK(MONDAY)) AS week_start,
        COUNT(DISTINCT ccu.question_id)                    AS total_queries,
        COUNT(DISTINCT CASE
            WHEN diq.requested_at_et IS NULL                                        THEN ccu.question_id
            WHEN diq.requested_at_et > ccu.created_at_et                           THEN ccu.question_id
        END)                                                                       AS pre_queries,
        COUNT(DISTINCT CASE
            WHEN diq.requested_at_et < ccu.created_at_et
             AND (diq.first_completed_at_et IS NULL
                  OR diq.first_completed_at_et > ccu.created_at_et)               THEN ccu.question_id
        END)                                                                       AS pending_queries,
        COUNT(DISTINCT CASE
            WHEN diq.requested_at_et < ccu.created_at_et
             AND diq.first_completed_at_et < ccu.created_at_et                    THEN ccu.question_id
        END)                                                                       AS post_queries
    FROM `evenup-bi.dbt_prod.mart_case_companion_usage` ccu
    LEFT JOIN `evenup-bi.dbt_prod.demand_intake_questionnaire` diq
           ON ccu.matter_id = diq.matter_id
    WHERE ccu.is_question_asker_internal = FALSE
      AND DATE(ccu.created_at_et) >= DATE_TRUNC(CURRENT_DATE(), WEEK(MONDAY)) - 56
      AND DATE(ccu.created_at_et) <  DATE_TRUNC(CURRENT_DATE(), WEEK(MONDAY))
    GROUP BY week_start
)

SELECT
    w.week_start,
    w.total_ewau,
    w.cc_wau_fact,
    w.new_cc_users_this_week,
    w.new_cc_user_rate,
    d.total_queries                                             AS cc_queries_total,
    d.pre_queries                                              AS cc_queries_pre_doc,
    d.pending_queries                                          AS cc_queries_pending,
    d.post_queries                                             AS cc_queries_post_doc,
    SAFE_DIVIDE(d.pre_queries,     NULLIF(d.total_queries, 0)) AS share_pre_doc,
    SAFE_DIVIDE(d.pending_queries, NULLIF(d.total_queries, 0)) AS share_pending,
    SAFE_DIVIDE(d.post_queries,    NULLIF(d.total_queries, 0)) AS share_post_doc
FROM wai_agg w
LEFT JOIN doc_classified d ON d.week_start = w.week_start
ORDER BY w.week_start
```

---

## Template 1: EXECUTION_KPIS

**Purpose:** WAU, questions, matters, and questions/matter by CI/non-CI — period comparison window (6 weeks).

**Grain:** 1 row per (week_start, is_ci_matter).

```sql
SELECT
    DATE_TRUNC(DATE(cc.created_at_et), WEEK(MONDAY)) AS week_start,
    m.is_ci_matter,
    COUNT(DISTINCT cc.question_asker_id)              AS wau,
    COUNT(cc.question_id)                             AS total_questions,
    COUNT(DISTINCT cc.matter_id)                      AS distinct_matters,
    COUNT(DISTINCT cc.firm_id)                        AS active_firms,
    SAFE_DIVIDE(
        COUNT(cc.question_id),
        COUNT(DISTINCT cc.matter_id)
    )                                                 AS questions_per_matter
FROM `evenup-bi.dbt_prod.mart_case_companion_usage` cc
INNER JOIN `evenup-bi.dbt_prod.dim_matters` m ON cc.matter_id = m.matter_id
WHERE cc.is_question_asker_internal = FALSE
  AND DATE(cc.created_at_et) >= DATE_TRUNC(CURRENT_DATE(), WEEK(MONDAY)) - 42
  AND DATE(cc.created_at_et) <  DATE_TRUNC(CURRENT_DATE(), WEEK(MONDAY))
GROUP BY week_start, is_ci_matter
ORDER BY week_start, is_ci_matter
```

**Flagging logic (apply in fill_report.py):**
- Sum recent 2 weeks / 2 = recent_pw; sum prior 4 weeks / 4 = prior_pw
- Flag where |% change| > 10% for WAU

---

## Template 1b: FIRM_WAU_MOVERS

**Purpose:** Top 10 WAU-increasing + top 10 WAU-decreasing firms to identify anchor firm effects.

**Grain:** 1 row per firm (summarized over the 6-week window).

```sql
WITH firm_weekly AS (
    SELECT
        DATE_TRUNC(DATE(cc.created_at_et), WEEK(MONDAY)) AS week_start,
        cc.firm_id,
        cc.firm_name,
        m.is_ci_matter,
        COUNT(DISTINCT cc.question_asker_id) AS wau,
        COUNT(cc.question_id)                AS total_questions
    FROM `evenup-bi.dbt_prod.mart_case_companion_usage` cc
    INNER JOIN `evenup-bi.dbt_prod.dim_matters` m ON cc.matter_id = m.matter_id
    WHERE cc.is_question_asker_internal = FALSE
      AND DATE(cc.created_at_et) >= DATE_TRUNC(CURRENT_DATE(), WEEK(MONDAY)) - 42
      AND DATE(cc.created_at_et) <  DATE_TRUNC(CURRENT_DATE(), WEEK(MONDAY))
    GROUP BY week_start, firm_id, firm_name, is_ci_matter
),
periods AS (
    SELECT
        firm_id,
        firm_name,
        is_ci_matter,
        SUM(CASE WHEN week_start >= DATE_TRUNC(CURRENT_DATE(), WEEK(MONDAY)) - 14
                 THEN wau ELSE 0 END) / 2.0 AS recent_pw,
        SUM(CASE WHEN week_start <  DATE_TRUNC(CURRENT_DATE(), WEEK(MONDAY)) - 14
                 THEN wau ELSE 0 END) / 4.0 AS prior_pw
    FROM firm_weekly
    GROUP BY firm_id, firm_name, is_ci_matter
),
with_delta AS (
    SELECT *, recent_pw - prior_pw AS delta
    FROM periods
    WHERE prior_pw >= 1  -- exclude firms with near-zero prior history
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

## Template 2: QUALITY_KPIS

**Purpose:** Is-helpful rate, copy rate, and mode distribution by CI/non-CI.

**Note:** `is_helpful` and `copied` are optional feedback signals — many questions will have NULL values. Rate denominator excludes NULLs.

**Grain:** 1 row per (week_start, is_ci_matter).

```sql
SELECT
    DATE_TRUNC(DATE(cc.created_at_et), WEEK(MONDAY)) AS week_start,
    m.is_ci_matter,
    COUNT(cc.question_id)                                                    AS total_questions,
    COUNTIF(cc.is_helpful IS NOT NULL)                                       AS rated_questions,
    COUNTIF(cc.is_helpful = TRUE)                                            AS helpful_count,
    SAFE_DIVIDE(
        COUNTIF(cc.is_helpful = TRUE),
        COUNTIF(cc.is_helpful IS NOT NULL)
    )                                                                        AS helpful_rate,
    COUNTIF(cc.copied = TRUE)                                                AS copied_count,
    SAFE_DIVIDE(COUNTIF(cc.copied = TRUE), COUNT(cc.question_id))           AS copy_rate,
    COUNTIF(cc.labeled_mode = 'fast')                                        AS fast_mode_count,
    COUNTIF(cc.labeled_mode = 'balanced')                                    AS balanced_mode_count,
    COUNTIF(cc.labeled_mode = 'deep')                                        AS deep_mode_count,
    SAFE_DIVIDE(COUNTIF(cc.labeled_mode = 'fast'),    COUNT(cc.question_id)) AS fast_pct,
    SAFE_DIVIDE(COUNTIF(cc.labeled_mode = 'balanced'), COUNT(cc.question_id)) AS balanced_pct,
    SAFE_DIVIDE(COUNTIF(cc.labeled_mode = 'deep'),    COUNT(cc.question_id)) AS deep_pct
FROM `evenup-bi.dbt_prod.mart_case_companion_usage` cc
INNER JOIN `evenup-bi.dbt_prod.dim_matters` m ON cc.matter_id = m.matter_id
WHERE cc.is_question_asker_internal = FALSE
  AND DATE(cc.created_at_et) >= DATE_TRUNC(CURRENT_DATE(), WEEK(MONDAY)) - 42
  AND DATE(cc.created_at_et) <  DATE_TRUNC(CURRENT_DATE(), WEEK(MONDAY))
GROUP BY week_start, is_ci_matter
ORDER BY week_start, is_ci_matter
```

---

## Template 3: LATENCY_KPIS

**Purpose:** Weekly P50 and P95 response latency proxy. **This is the first-line check when WAU drops.**

**Latency proxy:** `DATETIME_DIFF(updated_at_et, created_at_et, SECOND)` — time from question creation to last record update. Not a dedicated processing-time column; filter 0 < latency < 600 to exclude invalid rows.

**Grain:** 1 row per week_start (no CI split — latency is infrastructure-level, not segment-specific).

```sql
SELECT
    DATE_TRUNC(DATE(cc.created_at_et), WEEK(MONDAY))                       AS week_start,
    COUNT(cc.question_id)                                                   AS total_questions,
    APPROX_QUANTILES(
        DATETIME_DIFF(cc.updated_at_et, cc.created_at_et, SECOND), 100
    )[OFFSET(50)]                                                           AS p50_latency_sec,
    APPROX_QUANTILES(
        DATETIME_DIFF(cc.updated_at_et, cc.created_at_et, SECOND), 100
    )[OFFSET(95)]                                                           AS p95_latency_sec,
    COUNTIF(
        DATETIME_DIFF(cc.updated_at_et, cc.created_at_et, SECOND) > 60
    )                                                                       AS questions_over_60s,
    SAFE_DIVIDE(
        COUNTIF(DATETIME_DIFF(cc.updated_at_et, cc.created_at_et, SECOND) > 60),
        COUNT(cc.question_id)
    )                                                                       AS pct_over_60s
FROM `evenup-bi.dbt_prod.mart_case_companion_usage` cc
WHERE cc.is_question_asker_internal = FALSE
  AND cc.updated_at_et IS NOT NULL
  AND DATETIME_DIFF(cc.updated_at_et, cc.created_at_et, SECOND) > 0
  AND DATETIME_DIFF(cc.updated_at_et, cc.created_at_et, SECOND) < 600
  AND DATE(cc.created_at_et) >= DATE_TRUNC(CURRENT_DATE(), WEEK(MONDAY)) - 42
  AND DATE(cc.created_at_et) <  DATE_TRUNC(CURRENT_DATE(), WEEK(MONDAY))
GROUP BY week_start
ORDER BY week_start
```

**Flagging:** Flag if p50 changes by >15% period-over-period, or if p50 > 45 seconds in the recent period.

---

## Template 4: FIRST_TOUCH_KPIS

**Purpose:** Distribution of time-to-first-CC-use buckets (weeks since matter creation).

```sql
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
WHERE k.product_name = 'Case QA'
  AND k.summary_week >= DATE_TRUNC(CURRENT_DATE(), WEEK(MONDAY)) - 42
  AND k.summary_week <  DATE_TRUNC(CURRENT_DATE(), WEEK(MONDAY))
ORDER BY k.is_ci_matter, k.summary_week
```

---

## Template 5: FIRM_WEEK_TREND

**Purpose:** Weekly WAU time series for specific flagged anchor firms. Substitute `{FIRM_IDS}` with comma-separated integers.

```sql
SELECT
    DATE_TRUNC(DATE(cc.created_at_et), WEEK(MONDAY)) AS week_start,
    cc.firm_id,
    cc.firm_name,
    m.is_ci_matter,
    COUNT(DISTINCT cc.question_asker_id) AS wau,
    COUNT(cc.question_id)                AS total_questions,
    COUNT(DISTINCT cc.matter_id)         AS distinct_matters
FROM `evenup-bi.dbt_prod.mart_case_companion_usage` cc
INNER JOIN `evenup-bi.dbt_prod.dim_matters` m ON cc.matter_id = m.matter_id
WHERE cc.firm_id IN ({FIRM_IDS})
  AND cc.is_question_asker_internal = FALSE
  AND DATE(cc.created_at_et) >= DATE_TRUNC(CURRENT_DATE(), WEEK(MONDAY)) - 42
  AND DATE(cc.created_at_et) <  DATE_TRUNC(CURRENT_DATE(), WEEK(MONDAY))
GROUP BY week_start, firm_id, firm_name, is_ci_matter
ORDER BY firm_id, week_start
```

---

## Deep-Dive Templates

These templates are run on-demand for specific `firm_id` values. Substitute `{FIRM_ID}` with the integer firm_id.

---

## Template 6: DEEP_DIVE_CONTRACT_STATUS

**Thesis:** Firm may have churned, gone inactive, or is a new pilot — explaining WAU change as a business event rather than a product signal.

**Always run first for any flagged firm.** Returns CSM email for escalation.

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

**Interpretation:**
- `Churned` → WAU decline is a contract event, not a product issue
- `Pending Churn` + declining WAU → escalate to CSM immediately
- `Customer` + `is_firm_active = TRUE` → proceed to deeper investigation
- `Prospect` → pilot/trial usage; not production signal

---

## Template 7: DEEP_DIVE_MATTER_VOLUME

**Thesis:** CC usage tracks caseload. If a firm's active matter count changed, WAU moves proportionally — that's structural, not behavioral.

```sql
SELECT
    DATE_TRUNC(DATE(cc.created_at_et), WEEK(MONDAY)) AS week_start,
    COUNT(DISTINCT cc.matter_id)         AS distinct_matters,
    COUNT(DISTINCT cc.question_asker_id) AS wau,
    COUNT(cc.question_id)                AS total_questions,
    SAFE_DIVIDE(
        COUNT(cc.question_id),
        COUNT(DISTINCT cc.matter_id)
    )                                    AS questions_per_matter
FROM `evenup-bi.dbt_prod.mart_case_companion_usage` cc
WHERE cc.firm_id = {FIRM_ID}
  AND cc.is_question_asker_internal = FALSE
  AND DATE(cc.created_at_et) >= DATE_TRUNC(CURRENT_DATE(), WEEK(MONDAY)) - 42
  AND DATE(cc.created_at_et) <  DATE_TRUNC(CURRENT_DATE(), WEEK(MONDAY))
GROUP BY week_start
ORDER BY week_start
```

**Interpretation:**
- Matter count and WAU moving together → structural caseload change
- WAU moved but matters held flat → behavioral shift (attorneys engaging differently per case)
- `questions_per_matter` declining → disengagement per case

---

## Template 8: DEEP_DIVE_CI_SYNC_ERRORS

**Thesis:** CI firms depend on automated matter intake. Sync failures reduce new matters flowing in, cutting CC usage opportunities.

**Only relevant for CI firms (`is_ci_matter = TRUE`).**

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

**Interpretation:**
- High error concentration on a specific `sync_error` → systemic pipeline issue
- Cross-reference error onset timing with WAU decline onset

---

## Template 9: DEEP_DIVE_USER_WEEK_TREND

**Thesis:** At small-to-mid firms, one or two power users drive most CC WAU. A single attorney departing or stopping usage can swing firm-level WAU materially.

```sql
SELECT
    DATE_TRUNC(DATE(cc.created_at_et), WEEK(MONDAY)) AS week_start,
    cc.question_asker_id                              AS user_id,
    cc.question_asker_full_name,
    cc.question_asker_email,
    COUNT(cc.question_id)                             AS questions_asked,
    COUNT(DISTINCT cc.matter_id)                      AS distinct_matters
FROM `evenup-bi.dbt_prod.mart_case_companion_usage` cc
WHERE cc.firm_id = {FIRM_ID}
  AND cc.is_question_asker_internal = FALSE
  AND DATE(cc.created_at_et) >= DATE_TRUNC(CURRENT_DATE(), WEEK(MONDAY)) - 42
  AND DATE(cc.created_at_et) <  DATE_TRUNC(CURRENT_DATE(), WEEK(MONDAY))
GROUP BY week_start, user_id, question_asker_full_name, question_asker_email
ORDER BY user_id, week_start
```

**Post-processing:**
- recent_pw = sum(last 2 weeks) / 2; prior_pw = sum(prior 4 weeks) / 4
- user_delta = recent_pw − prior_pw
- If 1–2 users explain the bulk of firm-level WAU change → key-person dependency

---

## Template 10: DEEP_DIVE_LATENCY_BY_MODE

**Thesis:** When aggregate latency rises, it may simply reflect a shift toward `deep` mode (expected to be slower). Check mode mix before treating latency change as a regression.

```sql
SELECT
    DATE_TRUNC(DATE(cc.created_at_et), WEEK(MONDAY))                        AS week_start,
    cc.labeled_mode,
    COUNT(cc.question_id)                                                    AS total_questions,
    APPROX_QUANTILES(
        DATETIME_DIFF(cc.updated_at_et, cc.created_at_et, SECOND), 100
    )[OFFSET(50)]                                                            AS p50_latency_sec,
    APPROX_QUANTILES(
        DATETIME_DIFF(cc.updated_at_et, cc.created_at_et, SECOND), 100
    )[OFFSET(95)]                                                            AS p95_latency_sec
FROM `evenup-bi.dbt_prod.mart_case_companion_usage` cc
WHERE cc.is_question_asker_internal = FALSE
  AND cc.updated_at_et IS NOT NULL
  AND DATETIME_DIFF(cc.updated_at_et, cc.created_at_et, SECOND) > 0
  AND DATETIME_DIFF(cc.updated_at_et, cc.created_at_et, SECOND) < 600
  AND DATE(cc.created_at_et) >= DATE_TRUNC(CURRENT_DATE(), WEEK(MONDAY)) - 42
  AND DATE(cc.created_at_et) <  DATE_TRUNC(CURRENT_DATE(), WEEK(MONDAY))
GROUP BY week_start, labeled_mode
ORDER BY week_start, labeled_mode
```

**Interpretation:**
- If mode mix shifted toward `deep` and p50 within each mode is stable → latency change is expected from mode shift, not a regression
- If p50 within a mode (especially `fast` or `balanced`) increased → infrastructure regression; escalate to engineering
