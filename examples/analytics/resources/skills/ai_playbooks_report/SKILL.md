---
name: ai_playbooks_report
trigger: "/kpi playbooks"
description: |
  AI Playbooks analytics report generator for the W&I product.

  Invoke when the user sends /kpi playbooks or adds <AI_PLAYBOOKS_KPI> tag.

  Orchestrates: fixed SQL queries → dynamic deep-dives for significant movers → HTML report → GCS upload.
model: haiku
---

# AI Playbooks Analytics Report Skill

## Workflow

Analysis convention (applied post-query, not in SQL):
- **Recent period** = last 2 complete Mon–Sun weeks (weeks -2 and -1)
- **Prior period**  = the 4 complete weeks before that (weeks -6 through -3)
- Normalize to per-week rates when comparing: recent ÷ 2, prior ÷ 4

```
Step 1: RUN WEEKLY KPI TREND (Section 1 of report)
    Load references/sql_templates.md → section WEEKLY_KPI_TREND
    Execute via bq_explore. Returns 8 weeks × CI grain (16 rows max).
    This feeds the first section: KPIs as rows, weeks as columns, CI/Non-CI groups.
    ↓
Step 2: RUN EXECUTION KPIs (period comparison)
    Load references/sql_templates.md → section EXECUTION_KPIS
    Execute via bq_explore. Compute per-week rates. fill_report.py identifies top movers by absolute run delta.
    ↓
Step 3: RUN UX ENGAGEMENT KPIs
    Load references/sql_templates.md → section UX_ENGAGEMENT_KPIS
    Execute via bq_explore. Note: "run button" and "edited" KPIs come from Amplitude.
    ↓
Step 4: RUN FIRM WEEK TREND (for flagged firms only)
    Load references/sql_templates.md → section FIRM_WEEK_TREND
    Build IN list of flagged firm_ids from Step 2. Execute via bq_explore.
    ↓
Step 5: RUN FIRST-TOUCH KPIs
    Load references/sql_templates.md → section FIRST_TOUCH_KPIS
    Execute via bq_explore.
    ↓
Step 5b: RUN BASELINE & PENETRATION KPIs
    Load references/sql_templates.md → section BASELINE_AND_PENETRATION
    Execute via bq_explore. Produces: active eligible matters, addressable matters, run penetration rate,
    and new-firm vs established-firm split. See references/kpi_reference.md for concept.
    ↓
Step 6: RUN COST ANALYSIS
    Load references/sql_templates.md → section COST_ANOMALIES
    Execute via bq_explore. This is the ONLY template that touches fact_ttx_model_call_cost.
    ↓
Step 7: FILL HTML REPORT (no deep dives yet)
    Run scripts/fill_report.py with all CSV paths from Steps 1–6:

        python3 .claude/skills/ai_playbooks_report/scripts/fill_report.py \
            --weekly     <path>  \
            --exec-agg   <path>  \
            --firm-grain <path>  \
            --ux-actions <path>  \
            --amplitude  <path>  \
            --first-touch <path> \
            --cost       <path>  \
            --baseline   <path>  \
            --cohort     <path>  \
            --firm-trend <path>  \
            --contracts  <path>

    The script fills references/report_template.html and writes
    ai_playbooks_report_YYYYMMDD.html in the current working directory.
    Print the absolute path. Deep-dive section shows a placeholder.

    The script prints flagged firm IDs for the user to review.
    ↓
Step 8 (ON DEMAND): DEEP-DIVE ON P0 ANOMALIES
    Any P0 metric showing significant movement triggers a deep dive.
    Load references/deep_dive_decision_tree.md — it routes by anomaly type (run count,
    cost, UX engagement divergence, penetration rate, baseline shift, organic signal).
    For firm-level run count deep dives, run Templates 7–10 as needed and inject results:

        python3 .claude/skills/ai_playbooks_report/scripts/add_deep_dive.py \
            --report    ai_playbooks_report_YYYYMMDD.html \
            --firm-id   <id>         \
            --firm-name "<name>"     \
            --is-ci     True|False   \
            --recent-pw <n>          \
            --prior-pw  <n>          \
            --check1    <path>       \
            [--check2   <path>]      \
            [--check3   <path>]      \
            [--root-cause "<text>"]  \
            [--evidence  "<text>"]   \
            [--csm-note  "<text>"]

    Repeat for each requested firm. Report is updated in-place.
    ↓
Step 9: UPLOAD AND SHARE
    Invoke the report-uploader skill (.claude/skills/report-uploader/SKILL.md):
      local_path   = /tmp/ai_playbooks_report_YYYYMMDD.html
      gcs_path     = ai_playbooks/YYYY-MM-DD/ai_playbooks_report_YYYYMMDD.html
      display_name = "AI Playbooks Report – <Month D, YYYY>"
```

For KPI priorities and baseline/penetration concepts (organic vs sales-driven, matter baselines, cohort split), see `references/kpi_reference.md`.

## Key Models

| Model | Purpose |
|-------|---------|
| `evenup-bi.dbt_prod.stg_lops_sql__public_library_aipromptsetresult` | Run counts (cheap; has is_test, is_automated_run) |
| `evenup-bi.dbt_prod.dim_ai_playbook` | Playbook metadata; firm_id, is_template, is_deleted |
| `evenup-bi.dbt_prod.dim_matters` | is_ci_matter, matter metadata |
| `evenup-bi.dbt_prod.fact_ai_playbook_promptset_result_actions` | View/download engagement events (non-staff only) |
| `evenup-bi.dbt_prod.fact_amplitude_ai_playbook_events` | Run-button press + edited events |
| `evenup-bi.dbt_prod.mart_workflow_and_insight_case_external_usage_summary` | Weekly engagement rollup by matter |
| `evenup-bi.dbt_prod.mart_workflow_and_insight_case_first_touch_kpis` | First-touch timing by week/CI/product |
| `evenup-bi.dbt_prod.fact_ttx_model_call_cost` | LLM cost — filter product_name='w&i', feature_name='ai_playbooks' |
| `evenup-bi.dbt_prod.dim_companies_and_firms` | firm_id → csm_email lookup |
| `evenup-bi.dbt_prod.mart_integration_matters_and_files` | CI sync errors for CI firms |
| `evenup-bi.dbt_prod.dim_matter_activity_weekly_history` | Matter × week grain; `case_status` (active/dormant/closed); `is_ai_playbook_eligible` (from FF); `is_ci_matter`. Always filter `summary_week` tightly. |
| `evenup-bi.dbt_prod.fact_firm_feature_flags` | Daily firm × feature flag; `ai_case_prompts` = TRUE when AI Playbooks enabled. Used to find firm's first-enable date. |
| `evenup-bi.dbt_prod.fact_workflow_and_insight_case_external_usage_by_date` | Grain: `matter_id × user_id × usage_date`. Has `firm_id`, `firm_name`, `summary_week`, `ai_playbook_engagement_count` (view/download events — NOT run counts). No `is_ci_matter`; join `dim_matters`. Only contains matters with ≥1 W&I usage event. Use for Templates 3 and 7. |

## Tools

- **Execute SQL**: `python3 .claude/scripts/bq_explore/bq_explore.py "SELECT ..."` — writes CSV to /tmp
- **Model discovery**: `python3 .claude/scripts/manifest_search/manifest_search.py search <keyword>`

## Important Rules

1. **Never use `fact_ttx_model_call_cost` for run counts** — it's a large table. Use `stg_lops_sql__public_library_aipromptsetresult` for run counts.
2. **Always filter partition keys directly** — no function wrapping on the filtered column (e.g., `date_created >= DATE '...'`, not `DATE(date_created) >= '...'`).
3. **Filter non-test runs** using `is_test = FALSE` on the stg promptset result table.
4. **Engagement events require `event_time_et IS NOT NULL`** in `fact_ai_playbook_promptset_result_actions` (LEFT JOIN model — null = no engagement).
5. **Validate Amplitude event_type strings** before running the UX query — run a quick `SELECT DISTINCT event_type FROM ... WHERE event_type LIKE '[AI Playbooks]%' LIMIT 50` first.
6. **Always filter `summary_week` on `dim_matter_activity_weekly_history`** — it's a matter × week spine since 2020 and is large. Never query without a `summary_week >=` predicate. The AI Playbooks eligibility column is `is_ai_playbook_eligible` (pre-computed); no need to join `fact_firm_feature_flags` again just for eligibility. Use `fact_firm_feature_flags` only when you need the firm's first-enable date for cohort classification.
