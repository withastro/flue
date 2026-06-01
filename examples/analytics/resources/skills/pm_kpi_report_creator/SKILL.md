---
name: pm_kpi_report_creator
trigger: "/kpi-create"
description: |
  Meta skill for creating and running product KPI report skills for PMs.

  Use this skill whenever a PM wants to:
  - Set up a KPI report skill for their product area ("build me a report for MDC", "I want to track Companion metrics")
  - Generate a KPI report on demand (PM sends /kpi <product> or <PRODUCT_KPI> tag)
  - Investigate anomalies in their product metrics through interactive deep-dive
  - Save a finalized HTML report to GCS for sharing

  Also invoke when: a PM says "can you build a report for [product]", "help me understand why [metric] dropped", "I want analytics for [feature]", or similar — even if they don't mention "skill" or "tag".

  This skill operates in two modes:
  - CREATE: Interviews PM → generates a new product-specific skill directory on disk (one-time setup per product)
  - RUN: PM explicitly triggers via product tag (e.g. <MDC_KPI>) → SQL → HTML → anomaly detection → deep-dive → GCS upload
---

# PM KPI Report Creator

## Quick Reference

**Mode detection**: If a product skill already exists at `.claude/skills/{product}_kpi_report/` (the deployed copy), enter RUN mode. Otherwise, enter CREATE mode.

| Mode | When | Outcome |
|------|------|---------|
| CREATE | New product, no skill yet | Generates `.claude/skills/{product}_kpi_report/` with all files |
| RUN | PM sends explicit `<{PRODUCT}_KPI>` tag | HTML report → GCS (on demand, not scheduled) |

**Full workflow details**: See `references/workflow.md`

**Standard EvenUp metric patterns**: See `references/standard_metrics_library.md`

**Deep-dive investigation guide**: See `references/deep_dive_playbook.md`

---

## CREATE Mode (High-Level)

Read `references/workflow.md → ## CREATE Mode` for the full step-by-step. Summary:

1. **Research then confirm** — look up product in `standard_metrics_library.md` + query Metabase card SQL, then present findings in plain text for PM to approve (one round, not open-ended questions)
2. **Extract SQL** _(if Metabase card IDs provided)_ — query `int_metabase_card_model_dependencies` for `native_query_sql`; otherwise use `manifest_search` to find relevant models
3. **Adapt SQL** — transform card SQL into 8-week weekly templates (DATE_TRUNC WEEK MONDAY window)
4. **Generate skill files** — write all 6 files to `.claude/skills/{product}_kpi_report/`
5. **Validate** — run Template 0 via `bq_explore` to confirm shape

---

## RUN Mode (High-Level)

Read `references/workflow.md → ## RUN Mode` for the full step-by-step. Summary:

1. Execute all SQL templates → CSVs in `/tmp/`
2. Run `fill_report.py` → HTML with flagged anomalies printed to stdout
3. Auto-run first-line investigation for each flagged metric (see `references/deep_dive_playbook.md`)
4. Present anomaly summary; offer interactive deep-dive loop for unexplained movers
5. Inject deep-dive findings into HTML
6. Upload and share: invoke the **report-uploader** skill (`.claude/skills/report-uploader/SKILL.md`).
   The generated skill's SKILL.md must define its own `gcs_path` (e.g. `{product_slug}/YYYY-MM-DD/{filename}.html`).
   Pass `local_path`, `gcs_path`, and `display_name` to report-uploader.

---

## Tools

- **Execute SQL**: `python3 .claude/scripts/bq_explore/bq_explore.py "SELECT ..."` → writes CSV to /tmp
- **Model discovery**: `python3 .claude/scripts/manifest_search/manifest_search.py search <keyword>`
- **Metabase card SQL lookup**: query `evenup-bi.dbt_prod.int_metabase_card_model_dependencies` via bq_explore
- **GCS upload + Slack link**: invoke `.claude/skills/report-uploader/SKILL.md`
