# E2E User Responses - 2026-06-02

Live waiter-orchestrated runs using the existing E2E fixture questions.

## Summary

| Fixture | Run ID | Reply Type | Result | Cost |
| --- | --- | --- | --- | --- |
| employee-growth-metabase-card | run_01KT45WNF2GACA3BDETTHP0FBK | final | Blocked by BigQuery `bigquery.jobs.create`; no Metabase card created | $0.5305 |
| plaas-matter-flag-caveat | run_01KT4622G1GKB2J5G2GN36GQDN | final | Accepted metadata answer with GSheet caveat and BigQuery validation caveat | $0.3337 |

Total observed cost: $0.8642.

## employee-growth-metabase-card

Query:

```text
make a metabase card to track evenup employee growth of all time, only ontario CAN and California USA
```

Payload notes:

```json
{
  "allowMetabaseCreate": true,
  "maxGb": 1,
  "source": "cli"
}
```

User response:

````text
I couldn't create the Metabase card on this run - warehouse access was denied (`bigquery.jobs.create` permission missing on `evenup-bi`), so I couldn't validate the exact country/state values, check date coverage, or sanity-check current headcount before building the card.

What I did confirm:
- Right source: `evenup-bi.dbt_prod.dim_employees_history` (one row per active employee per day, with `summary_date`, `geo_country`, `geo_state_province`, `employment_type`, `is_current`, `employee_canonical_id`).
- Caveats to be aware of when this runs:
  - Special handling for batch imports on 2024-08-06 and 2024-11-08.
  - Rippling snapshot logic only starts 2025-09-20.
  - Remote employees can have null location fields upstream.
  - Rippling rows hardcode `employment_type` to "Salaried, full-time" in this model.

Draft SQL (monthly headcount, Ontario CA vs California US - ready to run once access is restored):

```sql
WITH monthly_snapshots AS (
  SELECT
    DATE_TRUNC(summary_date, MONTH) AS month,
    CASE
      WHEN LOWER(TRIM(geo_country)) IN ('canada','ca')
        AND LOWER(TRIM(geo_state_province)) IN ('ontario','on')
        THEN 'Ontario (CA)'
      WHEN LOWER(TRIM(geo_country)) IN ('united states','united states of america','usa','us')
        AND LOWER(TRIM(geo_state_province)) IN ('california','ca')
        THEN 'California (US)'
      ELSE NULL
    END AS region,
    employee_canonical_id
  FROM `evenup-bi.dbt_prod.dim_employees_history`
  WHERE summary_date = LAST_DAY(summary_date, MONTH)
)
SELECT month, region, COUNT(DISTINCT employee_canonical_id) AS headcount
FROM monthly_snapshots
WHERE region IS NOT NULL
GROUP BY 1, 2
ORDER BY month, region;
```

To unblock: grant BigQuery job-run permission on `evenup-bi` (or run via a service account that has it). Once that's in place, I'll validate the exact location strings and coverage, dry-run the SQL, and create the line chart card titled "EvenUp Employee Headcount Over Time - Ontario (CA) & California (US)".

One thing worth confirming while you're at it: "growth" here is interpreted as monthly active headcount (a stock). If you actually want net new hires per month (a flow), let me know and I'll adjust.
````

Observed notes:

- Good: did not claim card creation after validation failure.
- Good: selected `dim_employees_history`.
- Good: surfaced auth blocker and draft SQL.
- Gap: because BigQuery was blocked, it did not verify fixture-required `geo_country = 'CA'`, `geo_state_province = 'ON'`, `geo_country = 'US'`, `geo_state_province = 'CA'` values.
- Gap: no Metabase card was created.

Cost:

```json
{
  "waiter": 0.3757525,
  "explorer": 0.00882858,
  "kitchen": 0.145916,
  "total": 0.53049708
}
```

## plaas-matter-flag-caveat

Query:

```text
For matters, is there a field indicating if it is a PLAAS case?
```

Payload notes:

```json
{
  "maxGb": 1,
  "source": "cli"
}
```

User response:

````text
Short answer: No - the main matter dimensions don't carry a direct PLAAS flag.

What I checked in dbt:
- `evenup-bi.dbt_prod.dim_matters` (35 cols) - has `matter_id` and `labeled_case_type`, but no `is_plaas` / `plaas_case` field.
- `evenup-bi.dbt_prod.dim_casejoin_matters` (42 cols) - same story; `matter_id` and `labeled_case_type` are there, but no PLAAS-specific column.
- Broader manifest searches for `plaas` / `pre-litigation` across matter-related models didn't surface any matter-centric PLAAS indicator.

Where PLAAS membership actually lives:
- Canonical model: `evenup-bi.dbt_prod.dim_plaas_case` ("Dimension table containing case information for PLAAS (pre-litigation as a service) cases").
- Join key: `dim_plaas_case.evenup_matter_id` = your matter dim's `matter_id`.

Pattern to derive an `is_plaas_case` flag:
```sql
WITH plaas_matters AS (
  SELECT DISTINCT evenup_matter_id
  FROM `evenup-bi.dbt_prod.dim_plaas_case`
  WHERE evenup_matter_id IS NOT NULL
)
SELECT
  m.matter_id,
  m.firm_id,
  m.labeled_case_type,
  p.evenup_matter_id IS NOT NULL AS is_plaas_case
FROM `evenup-bi.dbt_prod.dim_casejoin_matters` AS m
LEFT JOIN plaas_matters AS p
  ON m.matter_id = p.evenup_matter_id
```
Dedupe with the CTE before joining - `dim_plaas_case` has a `productivity_week` grain, so joining the raw table can multiply rows.

Caveats:
- `dim_plaas_case` is sourced from a Google Sheet, so coverage/refresh may lag core portal matter dims - treat it as the best available list, not a guaranteed-complete flag.
- I couldn't run BigQuery validation in this environment (missing `bigquery.jobs.create` permission), so join overlap between `matter_id` and `evenup_matter_id`, and whether `labeled_case_type` ever holds a PLAAS-like value, weren't warehouse-confirmed. Conclusion is based on dbt metadata.
````

Observed notes:

- Good: answered no direct PLAAS flag.
- Good: recommended `dim_plaas_case` membership via `evenup_matter_id`.
- Good: deduped `dim_plaas_case` before joining.
- Good: included Google Sheet source caveat.
- Good: postflight corrected a station typo from `plaats_matters` to `plaas_matters`.
- Gap: BigQuery validation was blocked, so `labeled_case_type` distinct values and join overlap were not warehouse-confirmed.

Cost:

```json
{
  "waiter": 0.17434125,
  "explorer": 0.01263283,
  "kitchen": 0.146721,
  "total": 0.33369508
}
```
