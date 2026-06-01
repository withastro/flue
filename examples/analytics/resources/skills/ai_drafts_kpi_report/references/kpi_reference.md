# AI Drafts KPI Reference

| Metric | Description | Priority | Anomaly Threshold | Source |
|--------|-------------|----------|-------------------|--------|
| % AI Drafts downloaded (XD) | % of Express Demand requests where an ai_generated revision was downloaded | P0 | ±10% | fact_self_serve_request + fact_self_serve_revision_downloads |
| % AI Drafts downloaded (MM) | % of Mirror Mode requests where an ai_generated revision was downloaded | P0 | ±10% | fact_self_serve_request + fact_self_serve_revision_downloads |
| Weekly XD requests | Total Express Demand AI Draft requests per week | P0 | ±10% | fact_self_serve_request |
| Weekly MM requests | Total Mirror Mode AI Draft requests per week | P0 | ±10% | fact_self_serve_request |
| Active firms (XD) | Distinct firms submitting XD requests per week | P1 | ±15% | fact_self_serve_request |
| Active firms (MM) | Distinct firms submitting MM requests per week | P1 | ±15% | fact_self_serve_request |
| Median TAT — XD | Median minutes from request to first AI-generated revision (XD) | P1 | ±15% | fact_self_serve_turnaround_time |
| Median TAT — MM | Median minutes from request to first AI-generated revision (MM) | P1 | ±15% | fact_self_serve_turnaround_time |
| p95 TAT — XD | 95th percentile TAT in minutes (XD) | P2 | ±25% | fact_self_serve_turnaround_time |
| p95 TAT — MM | 95th percentile TAT in minutes (MM) | P2 | ±25% | fact_self_serve_turnaround_time |

## Key Filters (all templates)
- `NOT is_test_firm`
- `NOT is_internal_requester`
- `request_type NOT LIKE '%Workstation'`

## Segment Logic
- `is_custom_template = FALSE` → Express Demand (XD)
- `is_custom_template = TRUE` → Mirror Mode (MM)

## Download Definition
A request is "downloaded" if it has at least one revision of `revision_type = 'ai_generated'`
with a non-null `first_downloaded_at` in `fact_self_serve_revision_downloads`.

## BigQuery Cost Note
Templates 1 and 2 scan ~1.2 GB each. Use `--max-gb 2` flag with bq_explore.

## Related Metabase Cards
| Card ID | Name |
|---------|------|
| 8921 | Activated and Unactivated AI Draft Users |
| 9200 | AI Draft Downloads |
| 9076 | AI Draft Generation Time |
