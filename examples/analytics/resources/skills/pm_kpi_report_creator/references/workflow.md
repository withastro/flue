# PM KPI Report Creator — Detailed Workflow

## CREATE Mode

Run this once when a PM wants to set up a new product's KPI report skill.

### Step 1: Research, then ask opinion questions

The product name and context come from the conversation. Do the research first, then ask the PM to confirm the plan AND share their mental model of what drives their metrics.

**Research before asking anything:**
1. Look up the product in `references/standard_metrics_library.md` — identify known metrics, segment dimension, and dbt models
2. If Metabase card IDs are known for this product, query `int_metabase_card_model_dependencies` to retrieve the SQL and understand what's already tracked
3. Infer the anomaly threshold from the product's row in the library (default ±15%)
4. Review `references/deep_dive_playbook.md` — note which investigation paths are likely applicable (e.g., caseload check, new vs established cohort split, CI sync errors)

**Then ask in plain text** for a two-part confirmation:

**Part 1 — Factual confirmation** (PM approves or adjusts what you found):
```
"Here's what I found for [Product Name]:
  P0 metrics: [list from library/Metabase research]
  Segment dimension: [e.g., CI vs non-CI]
  Anomaly threshold: ±15%
Does this look right? Anything to add or change?"
```

**Part 2 — Opinion questions** (these seed the investigation logic in the generated skill):
Ask these conversationally — they should feel like you're trying to understand the product, not fill out a form:

```
"A few quick questions to build the right investigation logic:

1. When [P0 metric] drops significantly in a week, what's your first instinct
   on what caused it? (e.g., 'usually it's just less caseload', 'check if a
   big firm went quiet', 'look at whether CI sync broke')

2. What would make you say 'this is a real product engagement problem' vs
   'this is just operational/external noise'?

3. Any firm-level patterns specific to your product that I should know
   about? (e.g., 'a few anchor firms dominate our volume', 'new firms take
   6 weeks to ramp up')"
```

The PM's answers directly shape the generated `deep_dive_decision_tree.md`. Good opinion answers = better investigation paths. Don't skip this — a generic decision tree misses the nuances that the PM knows intuitively.

Many investigation paths are shared across EvenUp products. When building the decision tree in Step 4, reuse patterns from `ai_playbooks_report/references/deep_dive_decision_tree.md` as a starting point — especially:
- Contract & Lifecycle check (Template 7 pattern)
- Caseload / matter volume check (Template 8 pattern)
- CI Sync errors (Template 9 pattern — for CI-dependent products only)
- Key-person dependency (Template 10 pattern)
- Organic vs new-firm cohort split (Template 6C pattern)

Adapt these to the PM's product by substituting the relevant tables and adding any product-specific hypotheses the PM mentioned in their answers.

---

### Step 2: Extract SQL from Metabase (if card IDs available)

If the PM provided a Metabase URL like `https://metabase.evenup.law/dashboard/1904-...` or `https://metabase.evenup.law/question/9201-...`, extract the card IDs (the number after the last `/` and before the `-`).

Query BigQuery to get the SQL behind those cards:
```sql
SELECT DISTINCT
  card_id,
  card_name,
  native_query_sql,
  dbt_model_name
FROM `evenup-bi.dbt_prod.int_metabase_card_model_dependencies`
WHERE card_id IN (<comma-separated list of card IDs>)
ORDER BY card_id, dbt_model_name
```

Use the resulting `native_query_sql` as the raw material for SQL templates. Note the `dbt_model_name` values — these tell you exactly which tables the PM's existing queries use.

**If no Metabase cards are available**: use `manifest_search` with keywords from the PM's product name and metrics to find relevant dbt models. Check `references/standard_metrics_library.md` for known EvenUp product→model mappings.

---

### Step 3: Design SQL Templates

Group the PM's metrics into N templates (aim for 3-6). Each template = one CSV output = one section of the report.

**Required template conventions** (these ensure fill_report.py can normalize correctly):
- Always return a `week_start` column: `DATE_TRUNC(event_date, WEEK(MONDAY)) AS week_start`
- Always cover the 8-week window:
  ```sql
  WHERE DATE_TRUNC(event_date, WEEK(MONDAY)) >= DATE_TRUNC(
    DATE_SUB(CURRENT_DATE('America/New_York'), INTERVAL 8 WEEK), WEEK(MONDAY))
  ```
- Filter non-test data where applicable: `is_test = FALSE`
- Partition filters must be applied directly on the partition column — no function wrapping (write `event_date >= DATE '...'`, not `DATE(event_date) >= '...'`)
- If the table has a large spine (matter × week history), always add a `week_start >=` predicate

**Template 0** must always be the "core weekly volume" query — the simplest count of the primary entity (runs, requests, users) per week. This is what's validated in Step 5.

If adapting from existing Metabase SQL:
- Replace the existing date filter with the 8-week window pattern above
- Add `GROUP BY week_start` if the card was a single-number metric
- Add the segment dimension column (e.g., `is_ci_matter`) as a GROUP BY dimension

---

### Step 4: Generate Skill Files

Write these 6 files to the Flue AGI project skill resources at `apps/dbt-explorer-api/agi-agent/resources/skills/{product_slug}_kpi_report/` in the application repo, or to the source Flue resource tree that generates that bundle (product_slug = lowercase snake_case, e.g., `case_companion_kpi_report`).

**Runtime/generated agent directories may be overwritten by deploys.** All new project skills must go through the repo source of truth and a PR.

Set up a branch, write all 6 files, commit, and push — do not pause for confirmation before pushing:
```bash
cd ../evenup-internal-tools
git checkout main && git pull
git checkout -b {product-slug}-kpi-skill
```

After writing all 6 files:
```bash
git add apps/dbt-explorer-api/agi-agent/resources/skills/{product_slug}_kpi_report/
git commit -m "feat: add {product} KPI report skill"
git push -u origin {product-slug}-kpi-skill
```

Then open the PR and share with the PM:

```bash
curl -s -X POST https://jira-automation-api.apps.evenup.law/create-pr \
  -H "Content-Type: application/json" \
  -d '{
    "repo": "evenup-ai/evenup-internal-tools",
    "title": "feat: add {product} KPI report skill",
    "head": "{product-slug}-kpi-skill",
    "body": "Adds KPI report skill for {product}. Generated from PM interview."
  }'
```

Share the returned `html_url` with the PM:
```
Skill created. PR: {html_url}

Any changes? Reply and I'll update the branch.
```

> **⚠️ STATELESS**: The bot runs on 2 GKE pods. Complete branch → write → commit → push in one turn. If the PM wants changes, reply on any pod and pull the branch there.

#### File 1: `SKILL.md`

```markdown
---
name: {product}_kpi_report
description: |
  {Product Name} KPI analytics report.

  Invoke when the user explicitly adds <{PRODUCT}_KPI> tag to their query.

  Orchestrates: fixed SQL queries → anomaly detection → interactive deep-dives → HTML report → GCS upload.
---

# {Product Name} KPI Report

## Workflow

Analysis convention:
- **Recent period** = last 2 complete Mon–Sun weeks (weeks -2 and -1)
- **Prior period** = the 4 complete weeks before that (weeks -6 through -3)
- Normalize to per-week rates: recent ÷ 2, prior ÷ 4

```
Step 1: RUN SQL TEMPLATES
    Execute each template from references/sql_templates.md via bq_explore.
    Save CSVs to /tmp/{product}_<section>_<date>.csv
    ↓
Step 2: FILL REPORT
    python3 .claude/skills/{product}_kpi_report/scripts/fill_report.py \
        --template-0 /tmp/{product}_t0.csv \
        [--template-N /tmp/{product}_tN.csv ...] \
        --output /tmp/{product}_report_YYYYMMDD.html
    Script prints flagged metrics (those with >{threshold}% change).
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
    gsutil -o GSUtil:default_project_id=evenup-internal-tools cp \
      /tmp/{product}_report_YYYYMMDD.html \
      gs://evenup-internal-tools-dbt-explorer-api/report-files/
    Print the GCS path.
```

## P0 Metrics (anomaly threshold: {threshold}%)
{List of P0 metric names from PM interview}

## Segment Dimension
{e.g., "CI vs non-CI: split all metrics by `is_ci_matter`"}

## Tools
- **Execute SQL**: `python3 .claude/scripts/bq_explore/bq_explore.py "SELECT ..."`
- **Model discovery**: `python3 .claude/scripts/manifest_search/manifest_search.py search <keyword>`
```

#### File 2: `references/sql_templates.md`

One section per template, with:
- Section header: `## Template N: <SECTION_NAME>`
- Grain description: "1 row per (week_start, segment)"
- Full BigQuery SQL in a code block
- Note on partition key and any important filters

#### File 3: `references/kpi_reference.md`

| Metric | Description | Priority | Anomaly Threshold | Source Card ID |
|--------|-------------|----------|-------------------|----------------|
| ... | ... | P0/P1/P2 | ±15% | 9201 |

Include a "BigQuery Availability" note if any metrics come from Amplitude or Salesforce.

#### File 4: `references/deep_dive_decision_tree.md`

Structure:
```markdown
## First-Line Checks (auto-run when P0 metric is flagged)

### [Metric Name] Drop/Spike
**Hypothesis**: [what's most likely causing this]
**Check**: [SQL template — inline, parameterized if needed]
**Interpretation**:
- If [result pattern A] → [conclusion A]
- If [result pattern B] → [conclusion B]
- If unexplained → enter interactive mode

## Interactive Loop
When first-line check doesn't explain >80% of the delta:
1. Present the finding to the PM: "[metric] moved X%, first-line check showed Y"
2. Ask: "What's your hypothesis for this? (or type 'done' to skip)"
3. PM states hypothesis → generate targeted SQL → run → show results
4. If explained: document root cause, call add_deep_dive injection (see below)
5. If not explained after 3 rounds: recommend CSM/engineering escalation

## Deep-Dive Injection (add_deep_dive.py pattern)
After root cause is found, inject into report:
[Python snippet adapting add_deep_dive.py for this product's HTML structure]
```

#### File 5: `scripts/fill_report.py`

Generate a Python script following the `ai_playbooks_report/scripts/fill_report.py` pattern. The script must:
- Accept `--template-N <csv_path>` args for each template
- Accept `--output <html_path>`
- Load `references/report_template.html` from the same skill directory
- Compute 8-week sliding window: identify RECENT (last 2 weeks) and PRIOR (4 weeks before)
- Normalize: `recent_total / 2`, `prior_total / 4` → per-week rates
- Compute % change: `(recent_pw - prior_pw) / prior_pw * 100`
- Flag metrics where |% change| > threshold (default 15%)
- Generate HTML rows/blocks for each metric section
- Replace `{{PLACEHOLDERS}}` in the template
- Print: `Report saved to <path>` and `FLAGGED METRICS: <list>`
- Include GCS-ready: print the `gsutil cp` command at the end

**Adapt the fill_report.py skeleton from** `.claude/skills/ai_playbooks_report/scripts/fill_report.py` — reuse the formatting helpers (`fi()`, `ff()`, `usd()`, `arrow()`, `pct_class()`), the date-window computation, and the period normalization logic. Replace the metric-specific sections with the PM's metrics.

#### File 6: `references/report_template.html`

Adapt from `.claude/skills/pm_kpi_report_creator/references/report_template_base.html`. Replace:
- Product name in header
- Section names and descriptions
- Table column headers to match the PM's metric names
- Remove sections that don't apply (e.g., remove Cost section if no cost metrics)

---

### Step 5: Validate All SQL Templates

Run **every** template in `references/sql_templates.md` via bq_explore (full execution, not dry-run only).
For deep-dive templates with `{FIRM_ID}` / `{FIRM_IDS}` placeholders, substitute a real firm_id from the results of Template 1's firm-grain output.

```bash
python3 .claude/scripts/bq_explore/bq_explore.py "<Template N SQL>"
```

For each template, verify:

| Check | What to look for |
|-------|-----------------|
| No error | Query completes without exception |
| `week_start` present | Date column exists and parses correctly |
| Non-null values | At least one metric column has non-zero values |
| Row count reasonable | Weekly templates: 8–16 rows (8 weeks × 1–2 segments); deep-dives: ≥1 row for the test firm |
| No fan-out | Row count is not unexpectedly large (e.g., 10× expected = likely missing join key) |

If any template fails or returns suspicious results (all zeros, nulls, wrong grain), **fix the SQL before proceeding**. Do not generate the skill files with unvalidated queries.

Print a validation summary before confirming skill creation:
```
✅ T0: WEEKLY_KPI_TREND        — 8 rows, looks good
✅ T1: EXECUTION_KPIS          — 12 rows, looks good
✅ T2: ...
❌ T3: FIRM_WEEK_TREND         — ERROR: column not found → fixed and re-validated
...
✅ PR pushed: {product-slug}-kpi-skill. Merge to deploy. Once live, invoke with <{PRODUCT}_KPI>.
```

---

## RUN Mode

Runs on demand when the PM explicitly adds the product's trigger tag (e.g. `<MDC_KPI>`) to their Slack message — not on a schedule.

### Step 1: Execute SQL Templates

For each template in `references/sql_templates.md`:
```bash
python3 .claude/scripts/bq_explore/bq_explore.py "<template SQL>" > /tmp/{product}_t{N}_{date}.csv
```
(bq_explore writes to /tmp automatically and prints the path — use the printed path)

### Step 2: Fill Report

```bash
python3 .claude/skills/{product}_kpi_report/scripts/fill_report.py \
    --template-0 /tmp/{product}_t0_{date}.csv \
    [--template-N /tmp/{product}_tN_{date}.csv ...] \
    --output /tmp/{product}_report_{date}.html
```

Note the flagged metrics printed to stdout.

### Step 3: First-Line Investigation

For each flagged metric, consult `references/deep_dive_decision_tree.md` for its first-line check query. Run it and summarize:
- What the check found
- Whether it explains the anomaly (>80% of the delta)

### Step 4: Present Anomaly Summary

Show the PM a table like:
```
ANOMALY SUMMARY
───────────────────────────────────────────────────────────
Metric              Direction   Change    First-Line Finding
────────────────────────────────────────────────────────────
[metric name]       ▼ Drop      -23%      Matter volume also down -18% (partial explanation)
[metric name]       ▲ Spike     +31%      No first-line check found; may need investigation
────────────────────────────────────────────────────────────
```

Then ask: "Want to dig deeper into any of these? I can run targeted queries if you have a hypothesis."

### Step 5: Interactive Deep-Dive (on demand)

If the PM wants to investigate an anomaly further:

1. Ask: "What's your hypothesis for [metric] moving [direction]?"
2. PM responds (e.g., "maybe it's because of the new firm we onboarded last week")
3. Translate hypothesis into a targeted SQL query → run via bq_explore → show results
4. If it explains the anomaly:
   - Summarize: "Root cause confirmed: [explanation]"
   - Inject a green callout block into the HTML (see `references/deep_dive_playbook.md` for injection pattern)
5. If it doesn't explain it:
   - "That doesn't account for the full move. What else might explain it?"
   - Repeat up to 3 rounds
6. After 3 unexplained rounds: "This one may need CSM or engineering input. I'll add an escalation note to the report."
7. PM types "done" to close the deep-dive on any metric

### Step 6: Upload to GCS

```bash
gsutil -o GSUtil:default_project_id=evenup-internal-tools cp \
  /tmp/{product}_report_{date}.html \
  gs://evenup-internal-tools-dbt-explorer-api/report-files/
```

Print the GCS URI so the PM can share it.
