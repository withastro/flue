# AI Playbooks KPI Reference

## KPI Priority — Section 1 Order (matches Product Review spreadsheet)

| Priority | Metric | Notes |
|----------|--------|-------|
| P0 | Completed, non-test AI Playbook runs | `total_runs` from weekly template |
| P0 | AI Playbooks cost | Total LLM cost per week |
| P0 | Enabled Firms with 1+ run | `active_firms` per week |
| P2 | Unique matters w/ 1+ AI Playbook run | `distinct_matters` per week |
| P2 | Runs over matters | `runs / distinct_matters` |
| P2 | AI Playbooks cost per run | Derived: cost / runs |
| — | **AI Playbooks in Case UX** | *(group header)* |
| P0 | Playbook Views in AI Playbooks-tab UX | `view_tab_count` (BQ) |
| P2 | AI Playbook downloads (not staff) | `download_count` (BQ) |
| P0 | Pinned Playbook Views on Case Page | `view_pinned_count` (BQ) |
| — | Total views of Playbooks (may double-count unique AI Playbooks) | NULL — source not in BQ |
| — | Total views of Playbooks / Playbooks | NULL — source not in BQ |
| P1 | Run AI Playbooks — pressed run button | Amplitude event |
| P2 | Edited AI Playbook Response in UX | Amplitude event |
| Dep | AI Playbooks downloads over runs | Derived: downloads / runs × 100 |

**CI vs non-CI split is required on every section.**

---

## Baselines & Sales Isolation

EvenUp is growing fast — new contracts inflate engagement metrics. To distinguish **organic growth** from **sales-driven growth**, the report tracks two matter baselines and a firm-cohort split.

### Two Matter Baselines

Both come from `dim_matter_activity_weekly_history`, which pre-computes `is_ai_playbook_eligible` and `case_status` per matter per week.

| Baseline | Definition | Answers |
|----------|------------|---------|
| **Active eligible matters** | `case_status = 'active' AND is_ai_playbook_eligible = TRUE` | How many matters *would* we expect to see runs on? (demand signal) |
| **Addressable matters** | `case_status != 'closed' AND is_ai_playbook_eligible = TRUE` | How many matters *could* receive a run? (supply/TAM) |

Case status rules:
- `'active'`: CI matters with activity in last 4 weeks; non-CI in last 8 weeks; or created within 3 weeks
- `'dormant'`: open but no recent activity
- `'closed'`: matter ended > 1 week before summary_week

### Derived Penetration Metrics

- **Run penetration rate** = `total_runs / active_eligible_matters` per week (per CI segment)
- **Matter coverage rate** = `distinct_matters_with_run / active_eligible_matters`

Flat penetration when matter count doubles = proportional scaling, not acceleration.

### Firm Cohort Split

- **New firm** (≤ 12 weeks since first AI Playbooks enable): primarily sales/onboarding driven
- **Established firm** (> 12 weeks): reflects organic adoption

If total runs are up +22% but +20% comes from new firms, the organic signal is only +2%.

### Schema Notes

- `dim_matter_activity_weekly_history`: always filter `summary_week` tightly (spine since 2020). `is_ai_playbook_eligible` is pre-computed — do NOT re-join `fact_firm_feature_flags` for eligibility.
- `fact_firm_feature_flags`: grain is `summary_date × firm_id`. AI Playbooks flag column = **`ai_case_prompts`** (not 'ai_playbooks').
