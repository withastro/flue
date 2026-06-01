# Deep-Dive Decision Tree — Case Companion

Any **P0 metric** showing significant movement triggers a deep dive. Follow the investigation path below.

**Key PM guidance:** When WAU drops, **check latency first** — users disengage if CC is slow. Run Template 3 (latency check) before any firm-level investigation.

---

## P0 Anomaly → Investigation Path

| P0 Metric | Abnormal Pattern | Investigation Path |
|-----------|-----------------|-------------------|
| External CC WAU | Drop > 10% period-over-period | [WAU Drop](#wau-drop) |
| External CC WAU | Spike > 10% | [WAU Spike](#wau-spike) |
| P50 response latency | Rise > 15% or p50 > 45 seconds | [Latency Regression](#latency-regression) |
| CC WAU / Active matters | Penetration declining even as WAU holds | [Penetration Decline](#penetration-decline) |

---

## WAU Drop

**Investigation order: latency → firm-level → contract → caseload → CI sync → user dependency**

### Step 1 — Latency Check (always first)

**Thesis:** Users disengage when CC responses are slow. An infrastructure regression may be causing the drop without any change in firm behavior or caseload.

**Template:** `sql_templates.md → Template 3: LATENCY_KPIS`

**What to look for:**
- Did p50 latency increase by >15% in the same weeks WAU dropped?
- Did `pct_over_60s` spike? (questions taking >60s are likely abandoned)
- Is the latency change concentrated in a specific mode? → Run Template 10 to check mode-level latency

**Interpretation:**
- p50 up + WAU down in same weeks → latency is likely the primary driver; escalate to engineering
- p50 stable → latency is not the driver; proceed to firm-level investigation

---

### Step 2 — Firm-Level Movers (anchor firm check)

**Thesis:** A few anchor firms drive most CC WAU. One firm going quiet can cause a large aggregate drop.

**Template:** Template 1b (FIRM_WAU_MOVERS) is already in the report — review the "Top Declining Firms" section.

**What to look for:**
- Does 1–2 firm(s) account for most of the WAU decline?
- If yes: investigate those firms using the contract, caseload, and user path below

---

### Step 3 — Contract & Lifecycle (for each flagged firm)

**Template:** `sql_templates.md → Template 6: DEEP_DIVE_CONTRACT_STATUS`

**Always run first for any flagged firm** — also returns CSM email.

**What to look for:**
- `Churned` or `Pending Churn` → WAU decline is a business event, not a product issue
- `Customer` + `is_firm_active = TRUE` → proceed to caseload check

---

### Step 4 — Caseload Change

**Template:** `sql_templates.md → Template 7: DEEP_DIVE_MATTER_VOLUME`

**What to look for:**
- Matter count and WAU moving together → structural (caseload, not behavior)
- `questions_per_matter` declining → behavioral disengagement per case

---

### Step 5 — CI Sync Pipeline (CI firms only)

**Template:** `sql_templates.md → Template 8: DEEP_DIVE_CI_SYNC_ERRORS`

**What to look for:**
- High sync error rate aligning with WAU drop onset → pipeline issue, not product

---

### Step 6 — Key-Person Dependency

**Template:** `sql_templates.md → Template 9: DEEP_DIVE_USER_WEEK_TREND`

**What to look for:**
- 1–2 users account for the bulk of the firm's WAU delta
- A power user left, stopped using CC, or a new user is driving the growth
- Flag key-person fragility in the CSM escalation note

---

### Step 7 — No Root Cause Found → CSM Escalation

If latency, firm movers, contract, caseload, sync, and user checks don't explain the shift:

Generate a CSM escalation note with:
- What was ruled out (latency: stable, caseload: stable, no sync errors, no key-person event)
- Observed change (WAU magnitude, direction, period)
- Suggested CSM questions: recent firm feedback on CC quality/relevance, attorney workflow changes, training sessions, reported technical issues, whether attorneys are substituting another tool

---

## WAU Spike

**Thesis:** WAU spikes are often driven by new firm onboarding, a training session, or an anchor firm ramping up usage. Distinguish organic adoption from one-time events.

**Investigation:**
1. Check firm-level movers (Template 1b) — which firms drove the spike?
2. Are the spiking firms newly onboarded (≤12 weeks)?
3. Check if the spike sustained into the next week or was a one-time event
4. If organic and sustained from established firms → positive signal worth highlighting in exec summary

---

## Latency Regression

**Primary question:** Is the latency increase uniform across modes, or concentrated in a specific mode?

**Template:** `sql_templates.md → Template 10: DEEP_DIVE_LATENCY_BY_MODE`

**Investigation:**
1. Is mode mix shifting toward `deep`? If yes, higher latency is expected — not a regression
2. Is p50 within a specific mode (especially `fast` or `balanced`) rising? → Infrastructure regression
3. Is `pct_over_60s` growing? → High proportion of likely-abandoned questions; WAU impact imminent if not already happening
4. If latency regression confirmed → escalate to engineering with: week of onset, affected mode(s), magnitude of increase

---

## Penetration Decline

**Thesis:** WAU / active matters can decline even when WAU holds flat if the matter base is growing faster than CC adoption.

**Investigation:**
1. Is active matter count growing? (check from `dim_matter_activity_weekly_history` or Template 0 `distinct_matters`)
2. Is the matter growth coming from new firms (which have low CC adoption by default)?
3. If established-firm penetration is also declining → real engagement gap; behavioral issue
4. If only new firms are diluting the denominator → not alarming, but CSMs should accelerate CC adoption during onboarding

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
