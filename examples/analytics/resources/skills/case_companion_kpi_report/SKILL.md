---
name: case_companion_kpi_report
trigger: "/kpi case-companion"
description: |
  Case Companion KPI analytics report.

  Invoke when the user sends /kpi case-companion or adds <CASE_COMPANION_KPI> tag.

  Orchestrates: fixed SQL queries → anomaly detection → interactive deep-dives → HTML report → GCS upload.
model: haiku
---

# Case Companion KPI Report

## Workflow

Analysis convention:
- **Recent period** = last 2 complete Mon–Sun weeks (weeks -2 and -1)
- **Prior period** = the 4 complete weeks before that (weeks -6 through -3)
- Normalize to per-week rates: recent ÷ 2, prior ÷ 4

```
Step 1: RUN SQL TEMPLATES
    Execute each template from references/sql_templates.md via bq_explore.
    Save CSVs to /tmp/cc_<section>_<date>.csv

    Templates to run:
      Template 0  → /tmp/cc_t0_weekly.csv
      Template 0B → /tmp/cc_t0b_wai_fact.csv
      Template 1  → /tmp/cc_t1_exec.csv
      Template 1b → /tmp/cc_t1b_firms.csv
      Template 2  → /tmp/cc_t2_quality.csv
      Template 3  → /tmp/cc_t3_latency.csv
    ↓
Step 2: FILL REPORT
    python3 .claude/skills/case_companion_kpi_report/scripts/fill_report.py \
        --weekly     /tmp/cc_t0_weekly.csv \
        --wai-fact   /tmp/cc_t0b_wai_fact.csv \
        --exec-agg   /tmp/cc_t1_exec.csv \
        --firm-grain /tmp/cc_t1b_firms.csv \
        --quality    /tmp/cc_t2_quality.csv \
        --latency    /tmp/cc_t3_latency.csv \
        --output /tmp/cc_report_YYYYMMDD.html
    Script prints flagged metrics (those with >10% change).
    ↓
Step 3: FIRST-LINE INVESTIGATION (auto)
    For each flagged metric, run its pre-defined deep-dive query from
    references/deep_dive_decision_tree.md and summarize the finding.

    LATENCY IS ALWAYS THE FIRST CHECK when WAU drops — before firm-level investigation.
    ↓
Step 4: PRESENT ANOMALY SUMMARY
    Show PM: metric name, direction, % change, first-line check result.
    Offer to go deeper on any anomaly interactively.
    ↓
Step 5: INTERACTIVE DEEP-DIVE (on demand)
    See references/deep_dive_decision_tree.md → ## Interactive Loop
    ↓
Step 6: UPLOAD AND SHARE
    Invoke the report-uploader skill (.claude/skills/report-uploader/SKILL.md):
      local_path   = /tmp/cc_report_YYYYMMDD.html
      gcs_path     = case_companion/YYYY-MM-DD/cc_report_YYYYMMDD.html
      display_name = "Case Companion Report – <Month D, YYYY>"
```

## P0 Metrics (anomaly threshold: ±10%)

- External Companion WAU (distinct external users asking questions/week)
- External CC WAU / Active matters (penetration rate)
- P50 response latency (seconds) — **first-line check when WAU drops**

## P1 Metrics (anomaly threshold: ±15%)

- Total questions asked per week
- Questions per active matter
- Is-helpful rate (thumbs up / total rated)
- Copy rate (questions where user copied the answer)

## P2 Metrics

- Mode distribution (fast / balanced / deep)
- Active CC firms per week

## Segment Dimension

CI vs non-CI: split all WAU/question metrics by `is_ci_matter`.
Non-CI adoption is relatively low — CI firms are the primary user base.

## Key Models

| Model | Purpose |
|-------|---------|
| `evenup-bi.dbt_prod.mart_case_companion_usage` | 1 row per question asked; has `is_question_asker_internal`, `is_helpful`, `copied`, `labeled_mode`, `created_at_et`, `updated_at_et` |
| `evenup-bi.dbt_prod.demand_intake_questionnaire` | Demand package requests; `requested_at_et` = submission, `first_completed_at_et` = completion. Used for pre/pending/post doc-status classification. |
| `evenup-bi.dbt_prod.fact_workflow_and_insight_case_external_usage_by_date` | Matter × user × week grain; source for total EvenUp WAU and new CC user signal |
| `evenup-bi.dbt_prod.dim_matters` | `is_ci_matter`, matter metadata |
| `evenup-bi.dbt_prod.dim_companies_and_firms` | `firm_id → firm_name, csm_email, is_firm_active` |
| `evenup-bi.dbt_prod.mart_workflow_and_insight_case_first_touch_kpis` | First-touch timing; use `product_name = 'Case QA'` |
| `evenup-bi.dbt_prod.mart_integration_matters_and_files` | CI sync errors for CI firms |
| `evenup-bi.dbt_prod.dim_salesforce_account` | Firm lifecycle status (Customer/Churned/Pending Churn) |

## Important Rules

1. **Always filter `is_question_asker_internal = FALSE`** — internal users inflate WAU.
2. **Latency is the first-line check for WAU drops** — per PM guidance, users disengage when CC is slow.
3. **Latency proxy**: `DATETIME_DIFF(updated_at_et, created_at_et, SECOND)` — this is updated_at minus created_at, not dedicated processing time. Filter out negative values and >600s outliers.
4. **A few anchor firms dominate WAU** — always check firm-level movers when aggregate WAU shifts.
5. **Non-CI adoption is low** — CI/non-CI divergence in WAU is expected; focus escalation on CI firms.
6. **Established-firm WAU decline** (>12 wk firms) is a real product signal; new-firm dilution is not.
7. **Doc status classification uses `demand_intake_questionnaire`**, not the dbt `cc_usage_before/after_doc_request` columns. The dbt columns incorrectly collapse "pending" into "post". Use `requested_at_et` (submission) and `first_completed_at_et` (completion) for a 3-way split: Pre / Pending / Post. See Template 0B.

## Tools

- **Execute SQL**: `python3 .claude/scripts/bq_explore/bq_explore.py "SELECT ..."`
- **Model discovery**: `python3 .claude/scripts/manifest_search/manifest_search.py search <keyword>`
