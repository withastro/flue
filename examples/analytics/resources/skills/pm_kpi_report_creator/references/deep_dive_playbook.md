# Deep Dive Playbook

## Overview

When a P0 metric moves beyond its anomaly threshold, the RUN workflow triggers two phases:
1. **First-line investigation** (automatic): Pre-defined checks run immediately to rule out the most common explanations
2. **Interactive loop** (on demand): If the PM wants to go deeper, Claude helps develop and test hypotheses until the anomaly is explained

**Investigation style** (mirrors `ai_playbooks_report/references/deep_dive_decision_tree.md`):
These are hypotheses to test, not steps to execute mechanically. If early evidence is decisive, stop. The goal is to give the PM (and CSM, if escalated) enough context to act — not to produce a definitive verdict from data alone.

### Shared EvenUp Investigation Building Blocks

Many root causes are universal across EvenUp products. The generated skill's `deep_dive_decision_tree.md` should reuse these patterns — adapted to the product's tables and augmented by what the PM said in the opinion questions:

| Check | When to use | Source pattern |
|-------|-------------|----------------|
| **Contract & Lifecycle** | Any firm-level volume anomaly | ai_playbooks Template 7 |
| **Caseload / matter volume** | Runs or engagement dropped but firm is active | ai_playbooks Template 8 |
| **CI Sync errors** | CI-integrated product; runs dropped at a specific CI firm | ai_playbooks Template 9 |
| **Key-person dependency** | Small-to-mid firm with concentrated usage | ai_playbooks Template 10 |
| **New vs. established firm cohort** | Overall metric moved but unclear if organic or sales-mix | ai_playbooks Template 6C pattern |
| **Cost: volume vs. per-call** | Cost spike — is it more runs or costlier runs? | ai_playbooks cost CSV analysis |
| **Automated run share shift** | Engagement/UX metrics diverging from run counts | ai_playbooks Template 2B |

For the exact SQL templates behind these, see `.claude/skills/ai_playbooks_report/references/sql_templates.md` — they can be adapted for other products by substituting the relevant source tables.

---

## First-Line Checks by Metric Category

These run automatically whenever the corresponding metric type is flagged. Each check is designed to answer: "Is this anomaly caused by something structural (volume, mix) or behavioral (actual change in engagement)?"

### Adoption / Penetration Drop

**Most likely cause**: Denominator growth outpaced numerator (more eligible entities, not fewer users)

**Auto-check SQL**:
```sql
SELECT
  DATE_TRUNC(event_date, WEEK(MONDAY)) AS week_start,
  COUNT(DISTINCT entity_id)            AS eligible_entities,
  COUNT(DISTINCT CASE WHEN feature_used THEN entity_id END) AS feature_users
FROM source_table
WHERE event_date >= DATE_TRUNC(DATE_SUB(CURRENT_DATE(), INTERVAL 8 WEEK), WEEK(MONDAY))
GROUP BY 1 ORDER BY 1
```

**Interpretation**:
- If eligible_entities grew faster than feature_users → denominator expansion, not a real drop; document this
- If both fell → structural decline; check next whether it's new vs. established entities
- If only feature_users fell → real behavioral change; enter interactive mode

---

### Activity Volume Drop (runs, requests, events)

**Most likely cause**: Less underlying caseload/activity (structural), not less engagement with the feature

**Auto-check SQL**:
```sql
-- Check if the primary entity count also fell (matters, cases, users)
SELECT
  DATE_TRUNC(event_date, WEEK(MONDAY)) AS week_start,
  COUNT(DISTINCT entity_id) AS entity_count
FROM primary_entity_table   -- e.g., dim_matters, fact_cases
WHERE event_date >= DATE_TRUNC(DATE_SUB(CURRENT_DATE(), INTERVAL 8 WEEK), WEEK(MONDAY))
GROUP BY 1 ORDER BY 1
```

**Interpretation**:
- If entity count fell proportionally → structural (less to work on), not a product concern
- If entity count held but activity fell → real drop; check new vs. established firm split next
- If a single firm accounts for >30% of the delta → firm-level anomaly; investigate that firm specifically

---

### New vs. Established Firm Split

Use this when the volume drop passes the first-line check — to determine if it's organic decline (established firms pulling back) vs. sales mix shift (fewer new firms being onboarded).

```sql
SELECT
  DATE_TRUNC(event_date, WEEK(MONDAY)) AS week_start,
  CASE WHEN weeks_since_onboarding <= 12 THEN 'new_≤12wk' ELSE 'established_>12wk' END AS cohort,
  COUNT(DISTINCT firm_id)                AS active_firms,
  SUM(metric_count)                      AS total_metric
FROM source_table
JOIN firm_onboarding_dates USING (firm_id)
WHERE ...
GROUP BY 1, 2 ORDER BY 1, 2
```

**Interpretation**:
- Drop concentrated in new_≤12wk → sales pipeline slowdown, not product issue
- Drop concentrated in established_>12wk → real product/engagement concern

---

### Funnel / Conversion Drop

**Most likely cause**: Drop at a specific step, not the whole funnel

**Auto-check SQL** (adapt to the product's specific funnel steps):
```sql
SELECT
  DATE_TRUNC(started_at, WEEK(MONDAY))              AS week_start,
  COUNT(DISTINCT session_id)                          AS step_1,
  COUNTIF(completed_step2)                            AS step_2,
  COUNTIF(completed_step3)                            AS step_3,
  SAFE_DIVIDE(COUNTIF(completed_step2), COUNT(DISTINCT session_id)) AS step1_to_2_rate,
  SAFE_DIVIDE(COUNTIF(completed_step3), COUNTIF(completed_step2))   AS step2_to_3_rate
FROM funnel_table
WHERE started_at >= DATE_TRUNC(DATE_SUB(CURRENT_DATE(), INTERVAL 8 WEEK), WEEK(MONDAY))
GROUP BY 1 ORDER BY 1
```

**Interpretation**:
- Specific step-to-step rate drops → usually a product/UX issue at that step; escalate to engineering
- All rates dropped uniformly → likely external (less input volume); check entity count

---

### Engagement Depth Drop (avg queries/user, avg actions/entity)

**Most likely cause**: Mix shift — more new/low-frequency users diluting the average

**Auto-check SQL**:
```sql
SELECT
  DATE_TRUNC(event_date, WEEK(MONDAY))     AS week_start,
  COUNTIF(is_returning_user)                AS returning_users,
  COUNTIF(NOT is_returning_user)            AS new_users,
  SAFE_DIVIDE(COUNTIF(is_returning_user), COUNT(DISTINCT user_id)) AS returning_user_pct
FROM user_activity_table
WHERE ...
GROUP BY 1 ORDER BY 1
```

**Interpretation**:
- More new users this week → mix shift; engagement/depth naturally lower for new users
- Same mix but depth fell → actual behavioral change; ask PM what changed

---

### Quality Drop

**Most likely cause**: Change in input distribution or evaluation method

**Auto-check SQL**:
```sql
SELECT
  DATE_TRUNC(evaluated_at, WEEK(MONDAY)) AS week_start,
  quality_label,
  COUNT(*)                                AS count
FROM evaluation_table
WHERE ...
GROUP BY 1, 2 ORDER BY 1, 2
```

**Interpretation**:
- If "medium" quality grew as "high" fell → borderline cases are being rated differently
- If total evaluations fell sharply → sampling issue (fewer items reviewed, not lower quality)
- If specific quality dimension drives it → product-specific root cause

---

### Cost Spike

**Most likely cause**: Volume growth (more runs) rather than per-run cost increase

**Auto-check SQL**:
```sql
SELECT
  DATE_TRUNC(model_call_date, WEEK(MONDAY))   AS week_start,
  COUNT(*)                                      AS llm_call_count,
  SUM(cost_usd)                                 AS total_cost,
  SAFE_DIVIDE(SUM(cost_usd), COUNT(*))          AS cost_per_call,
  SUM(input_tokens)                             AS input_tokens,
  SUM(output_tokens)                            AS output_tokens
FROM `evenup-bi.dbt_prod.fact_ttx_model_call_cost`
WHERE product_name = '<product>'
  AND model_call_date >= DATE_TRUNC(DATE_SUB(CURRENT_DATE(), INTERVAL 8 WEEK), WEEK(MONDAY))
GROUP BY 1 ORDER BY 1
```

**Interpretation**:
- `cost_per_call` stable, call count grew → volume-driven (expected with growth)
- `cost_per_call` rose → model change, prompt change, or longer outputs; escalate to engineering
- `output_tokens` grew disproportionately → generation getting longer; check prompt/model version

---

## Interactive Loop

When the first-line check doesn't explain >80% of the delta, enter the interactive loop.

### How to Present the Handoff

After the auto-check, show:
```
First-Line Finding for [Metric]:
  The metric fell -23% (prior: 145/wk → recent: 112/wk)
  Entity count check: ↓ -5% (partial explanation; doesn't account for the full drop)
  Unexplained gap: ~-15% remains unaccounted for

Would you like to investigate further? If so, what's your hypothesis?
(Or type "done" to move on)
```

### Running Hypothesis-Driven SQL

When the PM gives a hypothesis:
1. Translate it into a targeted SQL query
2. Run via `bq_explore`
3. Show the result with a clear interpretation: "This explains [X]% of the gap" or "This doesn't appear to be the cause"
4. If explained (>80% of the gap): proceed to injection
5. If not: "That accounts for [X]% — the rest is still unexplained. Other ideas?" → max 3 rounds
6. After 3 unexplained rounds: suggest CSM or engineering escalation with a note summarizing what was ruled out

### Root-Cause Callout Injection

When a root cause is found, inject this HTML block into the report's deep-dive section:

```html
<div class="firm-block">
  <strong>{Metric Name} — Root Cause Found</strong>
  <div class="callout-rc">
    <strong>Root cause: {one-sentence explanation}</strong>
    Evidence: {summary of the SQL result that confirmed it}
    Action: {recommended next step, if any}
  </div>
</div>
```

CSS classes from `report_template_base.html` that apply:
- `.callout-rc` → green success callout (root cause confirmed)
- `.callout-esc` → yellow warning callout (escalation needed)
- `.firm-block` → container with border
- `.up` / `.down` → green/red change indicators

### Escalation Note Injection

When no root cause is found after 3 rounds:

```html
<div class="firm-block">
  <strong>{Metric Name} — Investigation Inconclusive</strong>
  <div class="callout-esc">
    <strong>Escalation recommended</strong>
    <ul>
      <li>Ruled out: {list of hypotheses tested and their results}</li>
      <li>Remaining unexplained: {% of the delta still unaccounted for}</li>
      <li>Recommended questions for CSM or engineering: {2-3 targeted questions}</li>
    </ul>
  </div>
</div>
```
