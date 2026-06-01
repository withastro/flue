# Standard Metrics Library — EvenUp Product KPIs

Source: Product Review KPIs Master spreadsheet (2025). All metrics are **WAU (weekly)** grain unless noted.

## Table of Contents
1. [Metric Category Patterns](#metric-category-patterns)
2. [EvenUp Product Map](#evenup-product-map)
3. [BigQuery Model Reference](#bigquery-model-reference)
4. [Known Metabase Card → dbt Model Mappings](#known-metabase-card--dbt-model-mappings)

---

## Metric Category Patterns

### 1. Adoption / Penetration
**What it measures**: What fraction of eligible entities are using the feature this week?
**SQL skeleton**:
```sql
SELECT
  DATE_TRUNC(event_date, WEEK(MONDAY)) AS week_start,
  segment_col,
  COUNT(DISTINCT CASE WHEN feature_used THEN entity_id END) AS users_with_feature,
  COUNT(DISTINCT entity_id)                                   AS eligible_entities,
  SAFE_DIVIDE(
    COUNT(DISTINCT CASE WHEN feature_used THEN entity_id END),
    COUNT(DISTINCT entity_id)
  )                                                           AS adoption_rate
FROM source_table
WHERE event_date >= DATE_TRUNC(DATE_SUB(CURRENT_DATE('America/New_York'), INTERVAL 8 WEEK), WEEK(MONDAY))
  AND is_test = FALSE
GROUP BY 1, 2
ORDER BY 1, 2
```
**EvenUp examples**: CI W&I Bundle use %, MDC enabled firm %, Companion WAU / Total WAU, % firms running MDC

---

### 2. Activity Volume
**What it measures**: How many events/runs/requests happened this week?
**SQL skeleton**:
```sql
SELECT
  DATE_TRUNC(created_at_et, WEEK(MONDAY)) AS week_start,
  segment_col,
  COUNT(*)                                 AS total_events,
  COUNT(DISTINCT entity_id)               AS distinct_entities
FROM source_table
WHERE created_at_et >= TIMESTAMP(DATE_TRUNC(DATE_SUB(CURRENT_DATE('America/New_York'), INTERVAL 8 WEEK), WEEK(MONDAY)))
  AND is_test = FALSE
GROUP BY 1, 2
ORDER BY 1, 2
```
**EvenUp examples**: Total MDC runs, MM requests, XD requests, Companion WAU #, total AI Playbook runs

---

### 3. Engagement Depth
**What it measures**: How deeply are active users engaging? (actions per user, queries per session)
**SQL skeleton**:
```sql
SELECT
  DATE_TRUNC(event_date, WEEK(MONDAY)) AS week_start,
  segment_col,
  SAFE_DIVIDE(SUM(action_count), COUNT(DISTINCT active_entity_id)) AS avg_actions_per_entity
FROM source_table
WHERE event_date >= ...
  AND active_entity_id IS NOT NULL
GROUP BY 1, 2
ORDER BY 1, 2
```
**EvenUp examples**: Avg # Companion queries per active user, MDC runs/active firm, Avg flags per case, % review items opened

---

### 4. Funnel / Conversion
**What it measures**: What % of entities complete each step of a funnel?
**SQL skeleton**:
```sql
SELECT
  DATE_TRUNC(started_at, WEEK(MONDAY)) AS week_start,
  segment_col,
  COUNT(DISTINCT session_id)                            AS entered_funnel,
  COUNT(DISTINCT CASE WHEN completed_step2 THEN session_id END) AS reached_step2,
  COUNT(DISTINCT CASE WHEN completed_step3 THEN session_id END) AS reached_step3,
  SAFE_DIVIDE(
    COUNT(DISTINCT CASE WHEN completed_step3 THEN session_id END),
    COUNT(DISTINCT session_id)
  )                                                     AS end_to_end_rate
FROM funnel_table
WHERE started_at >= ...
GROUP BY 1, 2
ORDER BY 1, 2
```
**EvenUp examples**: % MM completion from new template, % AI Drafts downloaded, MDC Results Modal Open rate, Bill Summary view ≥10s

---

### 5. Retention
**What it measures**: What fraction of previously active users are still active?
**SQL skeleton**:
```sql
-- Cohort-based: week_N active WHERE first_use_week <= W-N
WITH cohorts AS (
  SELECT entity_id, MIN(DATE_TRUNC(first_event_date, WEEK(MONDAY))) AS cohort_week
  FROM source_table
  GROUP BY 1
)
SELECT
  DATE_TRUNC(e.event_date, WEEK(MONDAY)) AS week_start,
  SAFE_DIVIDE(
    COUNT(DISTINCT e.entity_id),
    COUNT(DISTINCT c.entity_id)
  ) AS retention_rate
FROM cohorts c
JOIN source_table e ON e.entity_id = c.entity_id
WHERE c.cohort_week <= DATE_TRUNC(DATE_SUB(DATE_TRUNC(e.event_date, WEEK(MONDAY)), INTERVAL 4 WEEK), WEEK(MONDAY))
  AND e.event_date >= ...
GROUP BY 1
ORDER BY 1
```
**EvenUp examples**: Companion WAUs / lifetime users, firm 14D retention after first MM doc, % activated users requesting AI Draft L7, Rosie WAU / Active Drafters

---

### 6. Quality / Output
**What it measures**: What % of outputs meet a defined quality bar?
**SQL skeleton**:
```sql
SELECT
  DATE_TRUNC(evaluated_at, WEEK(MONDAY)) AS week_start,
  COUNTIF(quality_label = 'high')         AS high_quality,
  COUNT(*)                                AS total_evaluated,
  SAFE_DIVIDE(COUNTIF(quality_label = 'high'), COUNT(*)) AS quality_rate
FROM evaluation_table
WHERE evaluated_at >= ...
GROUP BY 1
ORDER BY 1
```
**EvenUp examples**: % MDC runs with precision >50%, % MM Docs with High Quality, Review acceptance rate, % AI Drafts with >1 version

---

### 7. Infrastructure / Latency
**What it measures**: Are we meeting SLA targets? How fast is the product?
**SQL skeleton**:
```sql
SELECT
  DATE_TRUNC(completed_at, WEEK(MONDAY))                               AS week_start,
  APPROX_QUANTILES(duration_minutes, 100)[OFFSET(50)]                  AS p50_minutes,
  APPROX_QUANTILES(duration_minutes, 100)[OFFSET(95)]                  AS p95_minutes,
  COUNTIF(duration_minutes <= sla_threshold_minutes) / COUNT(*)        AS sla_compliance_rate
FROM processing_table
WHERE completed_at >= ...
  AND status = 'completed'
GROUP BY 1
ORDER BY 1
```
**EvenUp examples**: % XD within 15 min, Median MDC TAT (hours), Median MM generation time

---

### 8. Revenue / Commercial
⚠️ **Largely NOT in BigQuery** — primary source is Salesforce/HubSpot.

Available in BigQuery via:
- `dim_companies_and_firms` → firm contract status, CSM email, firm type
- Salesforce sync tables (check with `manifest_search.py search salesforce` for available models)

**EvenUp examples**: Paying W&I Firms, W&I ARR, Churned/Expired as % of Total Ever Active

---

### 9. Email / Notification Engagement
⚠️ **Email open/CTR not in BigQuery** — sourced from SendGrid.

Amplitude events partially available:
- `fact_amplitude_*` tables for in-product events
- Check with `manifest_search.py search amplitude` for available event tables

**EvenUp examples**: SDR email open rate, EA email CTR, SDR estimate WAUs

---

## EvenUp Product Map

| Product | Owner | P0 Metric | Anomaly Threshold | Primary dbt Model |
|---------|-------|-----------|-------------------|-------------------|
| Overall W&I | Brittany Barlow | Cases with any W&I use / W&I enabled firms | ±15% | `mart_workflow_and_insight_case_external_usage_summary` |
| Express Demand (XD) | — | % AI Drafts downloaded | ±10% | `stg_lops_sql__*` demand tables |
| Mirror Mode (MM) | — | # firms generating AI Draft, funnel completion % | ±15% | MM-specific mart models |
| Executive Analytics (EA) | Lauren Wu | WAU / enabled users | ±10% | `fact_amplitude_*` |
| Settlement Repo (SDR) | Garrett Edel | Cases with SDR views / eligible cases | ±20% | SDR-specific models |
| Missing Docs Check (MDC) | Neha Zope | % MDC runs with 1+ Results Modal Open | ±10% | `mart_missing_doc_check_product_usage_kpi` |
| Case Strengths & Weaknesses (VD&D) | Neha Zope | # flags automated | ±15% | `mart_caseflag_product_usage_kpi` |
| Rosie | Arturo Garrido Contreras | Rosie WAU / Active Drafters | ±15% | Rosie-specific models |
| Case Companion | Arturo Garrido Contreras | External Companion WAU / Total EvenUp WAU | ±10% | `fact_amplitude_*`, Companion models |
| AI Playbooks | — | Run counts, penetration rate | ±15% | `stg_lops_sql__public_library_aipromptsetresult`, `dim_ai_playbook` |

---

## BigQuery Model Reference

### Always Available (✅ fully queryable)

| Model | What it has | Partition key |
|-------|-------------|---------------|
| `mart_missing_doc_check_product_usage_kpi` | MDC runs, modal opens, firm counts, precision | `summary_week` |
| `mart_caseflag_product_usage_kpi` | VD&D flags generated, user engagement, firm counts | `summary_week` |
| `mart_workflow_and_insight_case_external_usage_summary` | W&I usage per matter per week | `summary_week` |
| `mart_workflow_and_insight_case_first_touch_kpis` | First-touch timing by product | `summary_week` |
| `stg_lops_sql__public_library_aipromptsetresult` | AI Playbook run counts, is_test, is_automated_run | `created_at_et` (TIMESTAMP) |
| `dim_ai_playbook` | Playbook metadata, firm_id, is_template, is_deleted | — |
| `dim_matters` | is_ci_matter, matter metadata | — |
| `dim_companies_and_firms` | firm_id → csm_email, firm_name, plan type | — |
| `fact_ttx_model_call_cost` | LLM cost, tokens (filter product_name, feature_name) | `model_call_date` |
| `fact_amplitude_ai_playbook_events` | Amplitude events for AI Playbooks | `event_date` |
| `fact_ai_playbook_promptset_result_actions` | View/download engagement per result | `event_time_et` |
| `dim_matter_activity_weekly_history` | Matter × week spine (LARGE — always filter `summary_week`) | `summary_week` |
| `int_metabase_card_model_dependencies` | Metabase card SQL + dbt model deps | — |

### Partially Available (⚠️ limited)

| Model | Limitation |
|-------|-----------|
| Salesforce data | Check `manifest_search.py search salesforce` — some sync tables available |
| Amplitude events | Only specific event tables exist; check `manifest_search.py search amplitude event` |

### Not in BigQuery (❌)

- Email open/CTR (SendGrid)
- HubSpot deal data
- Some Amplitude charts that aren't synced

---

## Known Metabase Card → dbt Model Mappings

These card IDs come from the Product Review KPIs spreadsheet. Use when a PM's product overlaps with existing metrics.

| Card ID | Card Name (approx) | Primary dbt Model |
|---------|--------------------|-------------------|
| 9201 | % AI Drafts downloaded | XD/MM demand tables |
| 8921 | Activated users requesting AI Draft | User activation models |
| 10139 | MM template creation funnel | MM funnel models |
| 10136 | MM existing template funnel | MM funnel models |
| 8890 | # MM requests | MM demand tables |
| 8891 | # firms with MM AI Draft | MM firm models |

To look up any card's SQL directly:
```bash
python3 .claude/scripts/bq_explore/bq_explore.py "
SELECT DISTINCT card_id, card_name, native_query_sql, dbt_model_name
FROM \`evenup-bi.dbt_prod.int_metabase_card_model_dependencies\`
WHERE card_id IN (9201, 8921, 10139)
ORDER BY card_id
"
```
