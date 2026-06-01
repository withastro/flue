---
name: mdc_kpi_report
trigger: "/kpi mdc"
description: |
  Missing Docs Check (MDC) KPI analytics report.

  Invoke when the user sends /kpi mdc or adds <MDC_KPI> tag.

  Orchestrates: fixed SQL queries → anomaly detection → interactive deep-dives → HTML report → GCS upload.
---

# Missing Docs Check (MDC) KPI Report

## Workflow

Analysis convention:
- **Recent period** = last 2 complete Mon–Sun weeks (weeks -2 and -1)
- **Prior period** = the 4 complete weeks before that (weeks -6 through -3)
- Normalize to per-week rates: recent ÷ 2, prior ÷ 4

```
Step 1: RUN SQL TEMPLATES
    Execute Template 0 from references/sql_templates.md via bq_explore.
    Save CSV to /tmp/mdc_t0_<date>.csv
    ↓
Step 2: FILL REPORT
    python3 .claude/skills/mdc_kpi_report/scripts/fill_report.py \
        --kpis /tmp/mdc_t0_<date>.csv \
        --output /tmp/mdc_report_YYYYMMDD.html
    Script prints flagged metrics (those with >10% change).
    ↓
Step 3: FIRST-LINE INVESTIGATION (auto)
    For each flagged metric, run its pre-defined deep-dive query from
    references/deep_dive_decision_tree.md and summarize the finding.
    ↓
Step 4: PRESENT ANOMALY SUMMARY
    Show PM: metric name, direction, % change, first-line check result.
    Offer to go deeper on any anomaly interactively.
    ↓
Step 5: INTERACTIVE DEEP-DIVE (on demand)
    See references/deep_dive_decision_tree.md → ## Interactive Loop
    ↓
Step 6: UPLOAD TO GCS
    Invoke .claude/skills/report-uploader/SKILL.md
    local_path: /tmp/mdc_report_YYYYMMDD.html
    gcs_path: generated/mdc_report_YYYYMMDD.html
    display_name: MDC KPI Report — YYYY-MM-DD
```

## P0 Metrics (anomaly threshold: ±10%)
- % MDC Runs with 1+ Results Modal Open (total)
- % MDC Runs with 1+ Results Modal Open (CI-only)
- % MDC Runs with 1+ Results Modal Open (non-CI)

## Segment Dimension
CI vs non-CI: metrics split by `num_ci_runs` / `num_non_ci_runs` and corresponding pct columns.

## Tools
- **Execute SQL**: `python3 .claude/scripts/bq_explore/bq_explore.py "SELECT ..."`
- **Model discovery**: `python3 .claude/scripts/manifest_search/manifest_search.py search <keyword>`

## gcs_path
generated/mdc_report_{{YYYYMMDD}}.html
