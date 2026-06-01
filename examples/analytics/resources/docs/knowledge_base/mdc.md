# Missing Document Check (MDC)

## Product Overview

W&I tool that identifies missing medical records and bills during case preparation.

## Key Data Models

### stg_missing_doc_check_issues
- `is_doc_missing = true` indicates actual missing documents (excludes matched documents)
- Grain: one row per issue per case check
- Key columns: `issue_status` (active, resolved, dismissed), `issue_missing_doc_type`, `provider_name`, `date_of_service`

### fact_missing_doc_check_casechecks
- Grain: one row per MDC check run
- Primary key: `id` (used as `case_check_id`)
- `issue_count` already filters for `is_doc_missing = true`
- Breakdown: `active_issue_count`, `resolved_issue_count`, `dismissed_issue_count`
- Does NOT have `firm_name` (only `firm_id`)

## Business Logic

### Critical Non-Obvious Rules

**Operator Workload = Unresolved Issues Only**
- When calculating operator workload, count only `unresolved` issues, NOT total issues
- Dismissed issues do NOT count toward operator workload
- This is the actual work operators need to handle

**Manual vs Automated Requests**
- Filter for external/user-triggered requests: `WHERE manually_requested_at IS NOT NULL`
- `manually_requested_at IS NULL` = automated/system-triggered runs
- Use `manually_requested_at` (not `created_at`) for turnaround time on manual requests

### Timing Relationships
- MDC can run before or after demand requests
- "During demand preparation" = demand requested before MDC check created
- Filter: `fact_document_request.date_requested < fact_missing_doc_check_casechecks.created_at_et`

### Demand Types
- `expert_document` = traditional LOPs-drafted demands
- `ai_document` = AI-drafted demands (self-serve)

## Common Query Patterns

**Find matters with MDC issues after demand:**
```sql
-- Use fact_missing_doc_check_casechecks for aggregated issue counts
-- Use stg_missing_doc_check_issues for individual issue details
```

**Key joins:**
- `fact_document_request` via `matter_id` for demand timing
- `dim_matters` via `matter_id` for matter details and `firm_name`
