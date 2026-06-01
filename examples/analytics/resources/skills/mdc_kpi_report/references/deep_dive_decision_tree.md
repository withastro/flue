# Deep-Dive Decision Tree — MDC KPI Report

Any **P0 metric** showing >10% movement triggers a deep dive. Follow the investigation order below.

**Key PM guidance:** When modal open rate drops, **check CI mix shift first** — an increase in CI case volume mechanically dilutes the total rate without any real behavioral change.

---

## P0 Anomaly → Investigation Path

| P0 Metric | Abnormal Pattern | First Check |
|-----------|-----------------|-------------|
| % MDC Runs with Modal Open (total) | Drop > 10% | [CI Mix Shift](#step-1--ci-mix-shift-always-first) |
| % MDC Runs with Modal Open (total) | Spike > 10% | [CI Mix Shift](#step-1--ci-mix-shift-always-first) then firm-level movers |
| % MDC Runs with Modal Open (CI only) | Drop > 10% | [Holiday / File Upload](#step-2--holiday--file-upload-pattern) then [Firm Movers](#step-3--firm-level-movers) |
| % MDC Runs with Modal Open (non-CI) | Drop > 10% | [Holiday / File Upload](#step-2--holiday--file-upload-pattern) then [Firm Movers](#step-3--firm-level-movers) |

---

## Step 1 — CI Mix Shift (always first)

**Thesis:** Non-CI modal open rate (~40%) is ~2.5× CI rate (~16%). If CI run share grew (more CI cases created or CI firms ramped up), the blended total rate will drop with no behavioral change.

**Template:** `sql_templates.md → Template DD1: DEEP_DIVE_CI_MIX`

**What to look for:**
- Did `ci_run_share` increase in anomaly weeks?
- Did `pct_ci_mdc_runs_viewed` and `pct_non_ci_mdc_runs_viewed` hold stable?

**Interpretation:**
- CI share up + both segment rates stable → **pure mix shift; document as noise, no escalation needed**
- Both segment rates declined → real engagement drop; proceed to Step 2

---

## Step 2 — Holiday / File Upload Pattern

**Thesis:** Holidays reduce attorney activity across all metrics. A holiday week will show fewer runs and lower engagement broadly. File upload patterns matter too — if new CI files aren't being uploaded, attorneys have less reason to open MDC.

**Check (no SQL needed):**
- Were there US federal holidays in the anomaly weeks? (Thanksgiving, Christmas, July 4th, Memorial Day, Labor Day)
- Is this a partial week (report period cut off mid-week)?
- Look at `num_total_runs` — if total runs also dropped, holiday is likely the driver

**Interpretation:**
- Anomaly week overlaps a holiday + all metrics depressed together → seasonal noise
- Non-holiday week or only modal open rate dropped (not run count) → proceed to Step 3

---

## Step 3 — Firm-Level Movers

**Thesis:** A small number of large firms drive most MDC runs. One firm going quiet or changing behavior can shift aggregate metrics.

**Template:** Re-query Template 0 data from the report CSV and sort by firm contribution.

**Note:** The mart is aggregate-only (no firm_id grain). To get firm-level MDC data, use manifest_search:
```
python3 .claude/scripts/manifest_search/manifest_search.py search "mdc run firm"
```
Then query the found model filtered to the anomaly weeks.

**What to look for:**
- Which firm(s) drove the most run volume in prior period that disappeared in recent?
- Are those firms CI or non-CI?

---

## Step 4 — Contract & Lifecycle (for flagged firms)

**Template:** `sql_templates.md → Template DD2: DEEP_DIVE_CONTRACT_STATUS`

Always run first for any flagged firm — also returns CSM email.

**Interpretation:**
- `Churned` → business event, not product issue; deprioritize
- `Pending Churn` + declining MDC → escalate to CSM immediately
- `Customer` + `is_firm_active = TRUE` → proceed to Step 5

---

## Step 5 — Caseload Change

**Template:** `sql_templates.md → Template DD3: DEEP_DIVE_MATTER_VOLUME`

**What to look for:**
- Matter count and MDC runs moving together → structural caseload change (expected)
- Matter count stable but MDC runs or modal open rate changed → behavioral shift

---

## Step 6 — CI Sync Errors (CI firms only)

**Template:** `sql_templates.md → Template DD4: DEEP_DIVE_CI_SYNC_ERRORS`

**What to look for:**
- High error rate on a specific `sync_error` type aligning with MDC decline onset → pipeline failure
- If sync errors are the cause: escalate to engineering, not CSM

---

## Step 7 — No Root Cause Found → CSM Escalation

If CI mix, holidays, firm movers, contract, caseload, and sync checks don't explain the shift:

Generate a CSM escalation note with:
- What was ruled out (mix shift: stable, no holidays, caseload: stable, no sync errors)
- Observed change (P0 rate magnitude, direction, period)
- Suggested CSM questions: recent attorney feedback on MDC relevance, changes in workflow, whether attorneys are uploading docs before opening MDC (reducing perceived need), any firm-level training sessions

---

## Interactive Loop

When first-line check doesn't explain >80% of the delta:

1. Present finding to PM: "[metric] moved X%, first-line check showed Y"
2. Ask: "What's your hypothesis for this? (or type 'done' to skip)"
3. PM states hypothesis → generate targeted SQL → run → show results
4. If explained: document root cause, inject findings into deep-dive section of HTML
5. If not explained after 3 rounds: escalate to CSM/engineering with structured note

## Deep-Dive Injection Pattern

After root cause is found, inject a callout block into the HTML report under Section 4:

```html
<div class="firm-block">
  <strong>{Firm Name} (ID: {firm_id}) — {CI/Non-CI}</strong>
  <div class="callout-rc">
    <strong>Root cause confirmed: {root_cause_title}</strong>
    {evidence_text}
  </div>
</div>
```

Or for escalations:

```html
<div class="firm-block">
  <strong>{Firm Name} (ID: {firm_id})</strong>
  <div class="callout-esc">
    <strong>Escalate to CSM: {csm_email}</strong>
    <ul>
      <li>Observed: {change_description}</li>
      <li>Ruled out: {what_was_checked}</li>
      <li>Suggested questions: {csm_questions}</li>
    </ul>
  </div>
</div>
```
