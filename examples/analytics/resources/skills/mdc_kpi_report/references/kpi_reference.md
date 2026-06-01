# KPI Reference — MDC KPI Report

## KPI Priority Table

| Priority | Metric | Column | Anomaly Threshold | Section |
|----------|--------|--------|-------------------|---------|
| P0 | % MDC Runs with 1+ Results Modal Open (total) | `pct_mdc_runs_viewed` | ±10% | Weekly Trend + Period Comparison |
| P0 | % MDC Runs with 1+ Results Modal Open (CI only) | `pct_ci_mdc_runs_viewed` | ±10% | Weekly Trend + Period Comparison |
| P0 | % MDC Runs with 1+ Results Modal Open (non-CI) | `pct_non_ci_mdc_runs_viewed` | ±10% | Weekly Trend + Period Comparison |
| P1 | # Total MDC Runs | `num_total_runs` | ±10% | Weekly Trend |
| P1 | # CI MDC Runs | `num_ci_runs` | ±10% | Period Comparison |
| P1 | # Non-CI MDC Runs | `num_non_ci_runs` | ±10% | Period Comparison |
| P1 | # MDC-enabled firms | `num_mdc_enabled_firms` | ±10% | Weekly Trend |
| P1 | # Firms with 1+ MDC run | `num_firms_with_1_plus_mdc_run` | ±10% | Weekly Trend |
| P1 | % MDC-enabled firms with 1+ MDC run | `pct_firms_with_1_plus_mdc_run` | ±10% | Weekly Trend + Period Comparison |
| P1 | # Firms with 5+ MDC runs | `num_firms_with_5_plus_mdc_run` | ±15% | Weekly Trend |
| P1 | % MDC-enabled firms with 5+ MDC runs | `pct_firms_with_5_plus_mdc_run` | ±15% | Weekly Trend |
| P1 | MDC runs per active firm | `mdc_runs_per_firm` | ±15% | Weekly Trend + Period Comparison |
| P1 | Mean turnaround time per run (hours) | `avg_turnaround_time` | ±20% | Run Behavior |
| P1 | Mean issues per MDC run | `avg_issue_per_run` | ±15% | Run Behavior |
| P2 | T7 returning users | `num_repeat_users` | ±15% | Run Behavior |
| P2 | # MDC runs by new users | `num_mdc_runs_by_new_user` | ±20% | Run Behavior |
| P2 | # MDC runs by repeat users | `num_mdc_runs_by_repeat_user` | ±15% | Run Behavior |
| P2 | % MDC runs by new users | `pct_mdc_runs_by_new_user` | ±15% | Run Behavior |
| P2 | % cases with dismissed issue | `pct_cases_with_dismissed_issue` | ±15% | Run Behavior |
| P2 | % cases with resolved issue | `pct_cases_with_resolved_issue` | ±15% | Run Behavior |

**Source:** `evenup-bi.dbt_prod.mart_missing_doc_check_product_usage_kpi`

---

## CI vs Non-CI Segment Context

| Segment | Typical Modal Open Rate | Notes |
|---------|------------------------|-------|
| Non-CI | ~40% | Higher engagement — attorney manually opened matter, more likely to check docs |
| CI | ~16% | Lower engagement — CI auto-creates matters; attorney may not review MDC results |
| Total (blended) | ~25–30% | Mechanically affected by CI/non-CI mix |

**Key insight:** If CI run share increases (more CI cases created), the total modal open rate will drop even if individual CI and non-CI rates are unchanged. Always check CI mix shift BEFORE concluding modal open rate dropped.

---

## Metric Definitions

### Modal Open Rate (P0)
Percent of MDC runs where the attorney opened the results modal (1+ view). This is the primary engagement signal — a run without a view means the attorney never saw the MDC findings.

- `pct_mdc_runs_viewed` = total runs where modal opened / total runs
- `pct_ci_mdc_runs_viewed` = same, restricted to CI cases
- `pct_non_ci_mdc_runs_viewed` = same, restricted to non-CI cases

### Turnaround Time (TAT)
Mean hours from MDC run trigger to completion. Measures pipeline speed. Stored in `avg_turnaround_time`.

### Issues Per Run
Mean count of distinct missing-doc flags per MDC run. `avg_issue_per_run`. Increases when more doc types are expected/missing.

### Repeat Users (T7)
Attorneys who used MDC in more than one week within the 7-week window. Stored in `num_repeat_users`. Proxy for habitual adoption.

### Dismissed / Resolved Issues
- `pct_cases_with_dismissed_issue` — PM or attorney dismissed a missing-doc flag (manually marked not needed)
- `pct_cases_with_resolved_issue` — flag was resolved (doc was uploaded after MDC run)

---

## Not Available in BigQuery

- **Ops-led MDC Tracking** — tracked in a separate Ops system, not in the data warehouse
