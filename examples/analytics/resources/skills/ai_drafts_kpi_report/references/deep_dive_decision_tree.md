# AI Drafts — Deep-Dive Decision Tree

## First-Line Checks (auto-run when a P0 metric is flagged)

### Weekly Request Volume Drop (XD or MM)
**Hypothesis**: Either overall case volume is down, a major firm stopped submitting, or a feature/routing issue.

**Check 1 — Top firms this period vs prior (DD-1 from sql_templates.md)**:
Run DD-1 query. Compare top 10 firms by volume. If top firm(s) have significantly fewer requests,
that's likely a key-person / firm-level explanation rather than a product issue.

**Check 2 — Aggregate matter volume check**:
```sql
SELECT
  DATE_TRUNC(DATE(date_requested), WEEK(MONDAY)) AS week_start,
  CASE WHEN is_custom_template THEN 'Mirror Mode' ELSE 'Express Demand' END AS draft_type,
  COUNT(DISTINCT matter_id) AS distinct_matters
FROM `evenup-bi.dbt_prod.fact_self_serve_request`
WHERE NOT is_test_firm
  AND NOT is_internal_requester
  AND request_type NOT LIKE '%Workstation'
  AND date_requested >= TIMESTAMP(DATE_TRUNC(
        DATE_SUB(CURRENT_DATE('America/New_York'), INTERVAL 8 WEEK), WEEK(MONDAY)))
GROUP BY 1, 2
ORDER BY 1, 2
```

**Interpretation**:
- If matters also down proportionally → caseload/external explanation (not a product problem)
- If matters flat but requests down → users stopped requesting; investigate firm-level behavior
- If one/two firms explain >60% of the drop → key-person dependency, not systemic

---

### % Downloaded Drop (XD or MM)
**Hypothesis**: Drafts are being generated but not opened/downloaded. Could be quality issue,
workflow change, or specific firms not opening drafts.

**Check — Firm-level download rate (DD-2 from sql_templates.md)**:
Run DD-2. Identify firms with the lowest download rates in recent period.

**Interpretation**:
- If 1-2 large firms have near-0% download rate → isolated firm issue (check with CSM)
- If download rate dropped uniformly across many firms → possible quality or UX regression
- If MM drop but XD flat → Mirror Mode-specific issue (template quality, routing)
- If XD drop but MM flat → Express Demand-specific (generation failure, request type change)

---

### Median TAT Spike (XD or MM)
**Hypothesis**: Generation pipeline slowdown, queue backup, or infrastructure issue.

**Check — Week-over-week TAT with request count**:
```sql
SELECT
  DATE_TRUNC(DATE(t.first_revision_created_at), WEEK(MONDAY)) AS week_start,
  CASE WHEN r.is_custom_template THEN 'Mirror Mode' ELSE 'Express Demand' END AS draft_type,
  APPROX_QUANTILES(t.minutes_to_first_revision, 100)[OFFSET(50)] AS p50_minutes,
  APPROX_QUANTILES(t.minutes_to_first_revision, 100)[OFFSET(95)] AS p95_minutes,
  COUNT(*) AS total_completed
FROM `evenup-bi.dbt_prod.fact_self_serve_turnaround_time` t
JOIN `evenup-bi.dbt_prod.fact_self_serve_request` r USING (self_serve_request_id)
WHERE NOT r.is_test_firm
  AND NOT r.is_internal_requester
  AND r.request_type NOT LIKE '%Workstation'
  AND t.first_revision_created_at >= TIMESTAMP(DATE_TRUNC(
        DATE_SUB(CURRENT_DATE('America/New_York'), INTERVAL 4 WEEK), WEEK(MONDAY)))
GROUP BY 1, 2
ORDER BY 1, 2
```

**Interpretation**:
- p95 spike with stable p50 → tail latency issue (a few requests taking very long)
- Both p50 and p95 up → systemic slowdown (infra or queue)
- Volume also spiked that week → may be demand-driven, not a bug
- Correlate with engineering incidents if confirmed systemic

---

## Interactive Loop

When first-line checks don't explain >80% of the delta:

1. Present finding: "[metric] moved X%, first-line check showed Y"
2. Ask: "What's your hypothesis for this? (or type 'done' to skip)"
3. PM states hypothesis → generate targeted SQL → run → show results
4. If explained: document root cause, inject green callout into HTML
5. If not explained after 3 rounds: recommend CSM/engineering escalation
   — Add yellow escalation callout: "This anomaly was not explained by data checks.
     Recommend checking with CSM team or engineering on-call."

## Shared Investigation Patterns (reuse from ai_playbooks_report)

These patterns apply to AI Drafts in the same way:
- **Contract & Lifecycle check**: Query `dim_companies_and_firms` to check if declining firms
  are on trial, expired, or recently churned
- **New vs established firm cohort**: Split firms by age (< 6 months vs ≥ 6 months since first request)
  to distinguish ramp-up noise from genuine drops in established usage
- **CI vs non-CI split**: Add `is_ci_matter` (from `dim_matters`) to any query to see if the
  drop is concentrated in CI matters (which may have different business dynamics)
