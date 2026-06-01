# Deep-Dive Investigation Principles

Any **P0 metric** showing significant movement triggers a deep dive. Start by identifying which P0 metric is abnormal, then follow the corresponding investigation path below.

**Investigation style:** These are hypotheses to test, not steps to execute mechanically. If early evidence is decisive, stop. Use templates as starting points — adapt queries if data suggests a different angle. The goal is to give the CSM enough context to have a productive conversation, not produce a definitive verdict from data alone.

---

## P0 Anomaly → Investigation Path

| P0 Metric | Abnormal Pattern | Investigation Path |
|-----------|-----------------|-------------------|
| Completed non-test runs | Firm-level absolute delta (top movers from report) | [Run Count — Firm Level](#run-count-firm-level) |
| Enabled firms with 1+ run | Firms dropping off or newly appearing | [Run Count — Firm Level](#run-count-firm-level) |
| Cost (total, per run, per matter) | Cost/run spike; cost growing faster than runs | [Cost Anomaly](#cost-anomaly) |
| Playbook Views / Pinned Views | Views declining while runs hold flat or grow | [UX Engagement Divergence](#ux-engagement-divergence) |
| Run penetration rate | Penetration declining despite run growth | [Penetration Rate Decline](#penetration-rate-decline) |
| Active eligible matters | Sharp spike or drop not matching run movement | [Baseline Shift](#baseline-shift) |
| Organic vs sales-driven split | Organic (established firm) signal turns negative | [Cohort Organic Signal](#cohort-organic-signal) |

---

## Run Count — Firm Level

Top movers are firms with the largest absolute run delta (recent_pw − prior_pw). Investigate in the order below — stop when the hypothesis holds.

### 1. Contract & Lifecycle

**Thesis:** The firm may have churned, gone inactive, or is newly onboarded. Declining engagement at a churned firm is a business event, not a product signal. Surging engagement at a new firm is onboarding, not organic adoption.

**Template:** `sql_templates.md → Template 7: DEEP_DIVE_CONTRACT_STATUS`

Always run first — also returns `csm_email` for escalation.

**What to look for:**
- `account_type = 'Churned'` → decline is a contract event, not a product issue; deprioritize
- `account_type = 'Pending Churn'` + declining runs → imminent churn; escalate to CSM immediately
- `account_type = 'Prospect'` → never fully onboarded; runs may reflect a trial or pilot, not production usage
- `account_type = 'Disqualified'` → removed from pipeline; deprioritize entirely
- `account_type = 'Customer'` + `is_firm_active = TRUE` → proceed to deeper investigation
- Recently enabled firm (check Template 6C cohort data) + surging runs → onboarding effect, not organic signal

### 2. Caseload Change

**Thesis:** AI Playbook runs track case volume. If a firm took on more or fewer matters, run counts move proportionally — that's the system working, not a behavioral shift.

**Template:** `sql_templates.md → Template 8: DEEP_DIVE_MATTER_VOLUME`

**What to look for:**
- Matter count and run count moving together at similar magnitude → structural caseload change, likely not worth escalating
- Matter count stable but runs changed → behavioral shift (running more/fewer playbooks per case)
- Runs/matter ratio is the key signal: rising = deeper per-case usage; falling = disengagement per case
- A firm with 20% more matters but only 5% more runs → penetration declining even as volume grows

### 3. CI Sync Pipeline (CI firms only)

**Thesis:** CI firms depend on automated matter intake. Sync failures starve the pipeline of new cases, reducing run opportunities without any change in attorney behavior.

**Template:** `sql_templates.md → Template 9: DEEP_DIVE_CI_SYNC_ERRORS`

**What to look for:**
- High error concentration on a specific `sync_error` type → systemic pipeline failure (credential expiry, API change, schema drift)
- Error onset timing aligning with run decline onset → sync failure is the driver
- Even a 10–15% error rate on a high-volume CI firm is significant

### 4. Key-Person Dependency

**Thesis:** Usage at small-to-mid firms often concentrates in a few attorneys. One person joining, leaving, or changing habits can swing firm-level metrics materially.

**Template:** `sql_templates.md → Template 10: DEEP_DIVE_USER_WEEK_TREND`

**What to look for:**
- 1–2 users account for the bulk of the firm's delta → key-person event
- User present in prior period with near-zero recent activity → likely departed or stopped using
- User absent in prior period with high recent activity → new hire or newly onboarded
- Flag fragility: include a note in the CSM escalation to recommend broadening adoption

### 5. No Root Cause Found → CSM Escalation

If the above don't explain the shift, the cause is likely operational — something the CSM knows but the data doesn't capture (training sessions, internal policy changes, staffing restructures, reported bugs).

Generate a CSM escalation note via `add_deep_dive.py` (without `--root-cause`) with:
- What was ruled out
- Observed change (magnitude, direction, period)
- Suggested CSM questions: recent playbook setup changes, training sessions, staffing changes, reported technical issues

---

## Cost Anomaly

**Thesis:** Cost spikes can come from three sources: more runs (volume), longer prompts or responses (per-call cost), or a model change. These have very different implications.

**Primary question:** Is cost/run stable? If yes, the spike is pure volume — not an anomaly. If cost/run is rising, something structural changed.

**What to investigate:**
- Compare total cost growth vs run growth for the same period. Proportional = volume-driven; diverging = per-call cost issue
- Check input vs output token trends from the cost CSV: rising output tokens → responses getting verbose or prompts generating longer outputs; rising input tokens → prompt templates growing or more context being injected
- If cost/run spiked in a specific week and then normalized → one-off (large matter batch, unusual playbook type)
- If cost/run is trending up over multiple weeks → systemic change to prompt templates, model tier, or playbook complexity

**No templated query yet** — investigate using the cost CSV already produced by Template 5. If per-firm cost breakdown is needed, adapt Template 5 to add `firm_id` to GROUP BY.

---

## UX Engagement Divergence

**Thesis:** When views and pinned views decline while run counts hold flat or grow, attorneys are producing outputs they're not reading. This is either a trust/quality signal or a workflow change (automated runs bypassing the review step).

**Primary question:** Is the divergence uniform across firms, or concentrated in a few?

**What to investigate:**
- Check automated run share from the execution KPI CSV: if auto% increased, the drop in views is expected (automated runs don't trigger manual review)
- If auto% is flat but views declined → attorneys may be losing trust in outputs, using playbooks as a background tool rather than an active decision aid
- Check whether download counts also dropped: views down + downloads down = full disengagement; views down + downloads stable = reading elsewhere (e.g., downloading and reviewing outside the app)
- Firm-level breakdown: if a handful of high-volume firms shifted to automated runs, that explains aggregate view decline without any quality issue

**No templated query needed for aggregate analysis** — use the UX CSV from Template 2. For firm-level breakdown, adapt Template 2A to add `firm_id`.

---

## Penetration Rate Decline

**Thesis:** Penetration rate = runs / active eligible matters. It can fall even when absolute run counts grow — if the eligible matter base is expanding faster than run adoption. This signals that new matters (from new firms or new case types) are not yet being served by AI Playbooks.

**Primary question:** Is the penetration decline driven by matter base expansion or run count stagnation?

**What to investigate:**
- From the baseline CSV (Template 6A): did active eligible matter count grow? How fast vs run growth?
- From cohort data (Template 6C): is the matter base growth coming from new firms (≤12 weeks)? New firms have low playbook adoption by default — their matters inflate the denominator before their attorneys are trained
- If established firm penetration is stable but overall penetration is falling → new firm onboarding dilution; not alarming, but CSMs should accelerate playbook adoption during onboarding
- If established firm penetration is also falling → run adoption is genuinely not keeping up; worth understanding whether it's attorney behavior or playbook availability per case type

---

## Baseline Shift

**Thesis:** A sudden change in active eligible matter count — not explained by run volume — may indicate a data quality issue, a feature flag change, or a real shift in the firm mix.

**Primary question:** Did the `is_ai_playbook_eligible` flag or `ai_case_prompts` feature flag change for a group of firms?

**What to investigate:**
- Cross-reference the matter count change with firm cohort data: did a large firm enable or disable the feature flag?
- Check `fact_firm_feature_flags` for any firms where `ai_case_prompts` changed from TRUE to NULL/FALSE in the relevant period
- If eligible matter count jumped without new firms being enabled → possible model change in how `is_ai_playbook_eligible` is computed (check dbt model history)
- A drop in addressable matters without a corresponding drop in active matters → case closures accelerating; may indicate firm-level slowdown

---

## Cohort Organic Signal

**Thesis:** If established-firm runs (>12 weeks since enable) are declining, that's genuine retention/adoption risk — not dilution from new onboarding. This is the most important signal in the cohort split.

**Primary question:** Is organic decline broad-based or concentrated in a few large established firms?

**What to investigate:**
- From Template 6C cohort CSV: isolate established-firm run change by CI segment
- Cross-reference with the firm-level mover list: are the top declining firms in the established cohort? If yes, investigate those firms via the Run Count — Firm Level path above
- Check whether established-firm matter volume also declined (Template 8 for specific firms): if caseload shrank, run decline is proportional
- If established firms are running less per matter (runs/matter declining) → engagement quality issue; consider UX Engagement Divergence path in parallel
