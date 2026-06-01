---
name: ai_drafts_kpi_report
trigger: "/kpi drafts"
description: |
  AI Drafts KPI analytics report (Express Demand + Mirror Mode).

  Invoke when the user sends /kpi drafts or adds <AI_DRAFTS_KPI> tag.

  Orchestrates: fixed SQL queries → anomaly detection → interactive deep-dives → HTML report → GCS upload.
---

# AI Drafts KPI Report

## Workflow

Analysis convention:
- **Recent period** = last 2 complete Mon–Sun weeks (weeks -2 and -1)
- **Prior period** = the 4 complete weeks before that (weeks -6 through -3)
- Normalize to per-week rates: recent ÷ 2, prior ÷ 4

```
Step 1: RUN SQL TEMPLATES
    Execute each template from references/sql_templates.md via bq_explore.
    NOTE: Templates 1 and 2 require --max-gb 2 flag (~1.2 GB each).
    Save CSVs to /tmp/ai_drafts_t{N}_{date}.csv
    ↓
Step 2: FILL REPORT
    python3 .claude/skills/ai_drafts_kpi_report/scripts/fill_report.py \
        --template-0 /tmp/ai_drafts_t0_{date}.csv \
        --template-1 /tmp/ai_drafts_t1_{date}.csv \
        --template-2 /tmp/ai_drafts_t2_{date}.csv \
        --output /tmp/ai_drafts_report_{date}.html
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
Step 6: UPLOAD REPORT
    Invoke .claude/skills/report-uploader/SKILL.md with:
      local_path: /tmp/ai_drafts_report_{date}.html
      gcs_path: ai-drafts/{date}/ai_drafts_report_{date}.html
      display_name: AI Drafts KPI Report — {date}
```

## P0 Metrics (anomaly threshold: ±10%)
- % AI Drafts downloaded — XD and MM separately
- Weekly AI Draft request volume — XD and MM separately
- Median TAT minutes to first revision (P1)

## Segment Dimension
**XD vs MM**: split all metrics by `is_custom_template`
- `False` = Express Demand (XD)
- `True` = Mirror Mode (MM)

## Tools
- **Execute SQL**: `python3 .claude/scripts/bq_explore/bq_explore.py [--max-gb 2] "SELECT ..."`
- **Model discovery**: `python3 .claude/scripts/manifest_search/manifest_search.py search <keyword>`
