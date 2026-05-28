# Ontario Canada and California active employees by month

## Chosen source
- `dim_employees_history`
- Why: one row per employee per active day, which makes it the best fit for month-by-month active headcount.

## Alternatives considered
- `dim_employees_rippling`: good location fields, but not a daily/monthly history table by itself.
- `dim_employees`: current snapshot only, so it cannot answer month-by-month history.

## Validated values
- `geo_country`: `CA` = Canada, `US` = United States
- `geo_state_province`: `ON` = Ontario, `CA` = California

## Query logic
- Build one snapshot date per month using `MAX(summary_date)`.
- Count distinct `employee_canonical_id` on that monthly snapshot.
- Return two line-series columns: Ontario, Canada and California.

## Validation
- BigQuery query succeeded under the 1 GB guardrail (~40.3 MB billed).
- Latest validated month in this run:
  - 2026-05-01 Ontario = 89
  - 2026-05-01 California = 173
