# Case Companion KPI Reference

## KPI Priority

| Priority | Metric | Section | Anomaly Threshold | Source |
|----------|--------|---------|-------------------|--------|
| P0 | External Companion WAU | Execution | ±10% | `mart_case_companion_usage` |
| P0 | CC WAU / Active matters (penetration) | Execution | ±10% | mart_case_companion_usage + dim_matter_activity_weekly_history |
| P0 | P50 response latency (seconds) | Latency | ±15% | `mart_case_companion_usage` (updated_at − created_at proxy) |
| P1 | Total questions asked | Execution | ±10% | `mart_case_companion_usage` |
| P1 | Questions per active matter | Execution | ±10% | mart_case_companion_usage + dim_matter_activity_weekly_history |
| P1 | Is-helpful rate | Quality | ±15% | `mart_case_companion_usage.is_helpful` |
| P1 | Copy rate | Quality | ±15% | `mart_case_companion_usage.copied` |
| P2 | P95 response latency (seconds) | Latency | ±20% | mart_case_companion_usage proxy |
| P2 | Mode distribution (fast/balanced/deep) | Quality | — | `mart_case_companion_usage.labeled_mode` |
| P2 | Active CC firms | Execution | ±15% | `mart_case_companion_usage` |

**CI vs non-CI split required on Execution section.**

---

## Latency Metric Notes

Response latency is approximated as `DATETIME_DIFF(updated_at_et, created_at_et, SECOND)`.

This is a proxy — it measures time from question creation to last record update, not dedicated processing time. Limitations:
- Questions that are re-opened or re-processed will show inflated latency
- Filter: `latency > 0 AND latency < 600` (exclude invalid/extreme outliers)

**Per PM guidance:** Latency is the first-line explanation for WAU drops. Users disengage if CC results take too long. Check latency BEFORE doing firm-level investigation.

---

## WAU / Penetration Concepts

### WAU Definition
External Companion WAU = distinct `question_asker_id` values per week where `is_question_asker_internal = FALSE`.

### Penetration Rate
`CC WAU / active matters` = how many of the week's actively-worked matters had at least one CC interaction. Derived by joining WAU data with `dim_matter_activity_weekly_history` (case_status = 'active').

Note: WAU counts users, not matters. If multiple users work on the same matter, only one "matter" counts in the denominator but both users count in WAU. This is intentional — WAU is the user-level engagement signal.

### Anchor Firm Dominance
A few large firms (especially CI firms with high matter volume) drive the majority of CC WAU. A single anchor firm going quiet or ramping up can shift aggregate WAU by ≥15%. Always check firm-level movers alongside aggregate trends.

### Established vs New Firm Signal
- **New firm** (≤12 wk since onboarded or first CC use): questions may be exploratory/onboarding
- **Established firm** (>12 wk): reflects organic daily workflow adoption
- Declining WAU among established firms = real engagement problem

---

## Mode Distribution

| Mode | Description |
|------|-------------|
| `fast` | Quick response, lower document analysis depth |
| `balanced` | Default mode |
| `deep` | Comprehensive analysis, higher latency |

Mode shifts can explain latency changes (e.g., more `deep` queries → higher latency is expected, not a regression).
