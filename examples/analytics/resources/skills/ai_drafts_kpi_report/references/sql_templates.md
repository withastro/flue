# AI Drafts KPI — SQL Templates

All templates cover the **8-week rolling window** ending at the most recent complete Monday-week.
Standard filters applied everywhere: `NOT is_test_firm`, `NOT is_internal_requester`, `request_type NOT LIKE '%Workstation'`.

---

## Template 0: WEEKLY_REQUEST_VOLUME

**Grain**: 1 row per (week_start, draft_type)
**Use for**: Section 1 weekly trend + Section 2 period comparison
**Cost**: ~840 MB

```sql
SELECT
  DATE_TRUNC(DATE(date_requested), WEEK(MONDAY)) AS week_start,
  CASE WHEN is_custom_template THEN 'Mirror Mode' ELSE 'Express Demand' END AS draft_type,
  COUNT(*)                    AS total_requests,
  COUNT(DISTINCT firm_id)     AS active_firms,
  COUNT(DISTINCT user_id)     AS active_users,
  COUNT(DISTINCT matter_id)   AS distinct_matters
FROM `evenup-bi.dbt_prod.fact_self_serve_request`
WHERE NOT is_test_firm
  AND NOT is_internal_requester
  AND request_type NOT LIKE '%Workstation'
  AND date_requested >= TIMESTAMP(DATE_TRUNC(
        DATE_SUB(CURRENT_DATE('America/New_York'), INTERVAL 8 WEEK),
        WEEK(MONDAY)))
GROUP BY 1, 2
ORDER BY 1, 2
```

---

## Template 1: DOWNLOAD_FUNNEL

**Grain**: 1 row per (week_start, draft_type)
**Use for**: P0 metric — % AI Drafts downloaded
**Cost**: ~1.2 GB — use `--max-gb 2`

```sql
SELECT
  DATE_TRUNC(DATE(r.date_requested), WEEK(MONDAY)) AS week_start,
  CASE WHEN r.is_custom_template THEN 'Mirror Mode' ELSE 'Express Demand' END AS draft_type,
  COUNT(DISTINCT r.self_serve_request_id) AS total_requests,
  COUNT(DISTINCT CASE WHEN d.self_serve_request_id IS NOT NULL THEN r.self_serve_request_id END) AS downloaded_requests,
  SAFE_DIVIDE(
    COUNT(DISTINCT CASE WHEN d.self_serve_request_id IS NOT NULL THEN r.self_serve_request_id END),
    COUNT(DISTINCT r.self_serve_request_id)
  ) AS pct_downloaded
FROM `evenup-bi.dbt_prod.fact_self_serve_request` r
LEFT JOIN (
  SELECT DISTINCT self_serve_request_id
  FROM `evenup-bi.dbt_prod.fact_self_serve_revision_downloads`
  WHERE revision_type = 'ai_generated'
    AND first_downloaded_at IS NOT NULL
    AND revision_created_at >= TIMESTAMP(DATE_TRUNC(
          DATE_SUB(CURRENT_DATE('America/New_York'), INTERVAL 9 WEEK), WEEK(MONDAY)))
) d ON r.self_serve_request_id = d.self_serve_request_id
WHERE NOT r.is_test_firm
  AND NOT r.is_internal_requester
  AND r.request_type NOT LIKE '%Workstation'
  AND r.date_requested >= TIMESTAMP(DATE_TRUNC(
        DATE_SUB(CURRENT_DATE('America/New_York'), INTERVAL 8 WEEK), WEEK(MONDAY)))
GROUP BY 1, 2
ORDER BY 1, 2
```

---

## Template 2: TURNAROUND_TIME

**Grain**: 1 row per (week_start, draft_type)
**Use for**: Median and p95 TAT (minutes to first AI-generated revision)
**Cost**: ~1.0 GB — use `--max-gb 2`

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
        DATE_SUB(CURRENT_DATE('America/New_York'), INTERVAL 8 WEEK), WEEK(MONDAY)))
GROUP BY 1, 2
ORDER BY 1, 2
```

---

## Deep-Dive Queries (run on demand — see deep_dive_decision_tree.md)

### DD-1: Top firms by request volume (last 2 weeks)
```sql
SELECT
  firm_id,
  firm_name,
  CASE WHEN is_custom_template THEN 'Mirror Mode' ELSE 'Express Demand' END AS draft_type,
  COUNT(*) AS total_requests,
  COUNT(DISTINCT matter_id) AS distinct_matters
FROM `evenup-bi.dbt_prod.fact_self_serve_request`
WHERE NOT is_test_firm
  AND NOT is_internal_requester
  AND request_type NOT LIKE '%Workstation'
  AND date_requested >= TIMESTAMP(DATE_TRUNC(
        DATE_SUB(CURRENT_DATE('America/New_York'), INTERVAL 2 WEEK), WEEK(MONDAY)))
GROUP BY 1, 2, 3
ORDER BY total_requests DESC
LIMIT 25
```

### DD-2: Download rate by firm (last 2 weeks) — diagnose % downloaded drops
```sql
SELECT
  r.firm_id,
  r.firm_name,
  CASE WHEN r.is_custom_template THEN 'Mirror Mode' ELSE 'Express Demand' END AS draft_type,
  COUNT(DISTINCT r.self_serve_request_id) AS total_requests,
  COUNT(DISTINCT CASE WHEN d.self_serve_request_id IS NOT NULL THEN r.self_serve_request_id END) AS downloaded,
  SAFE_DIVIDE(
    COUNT(DISTINCT CASE WHEN d.self_serve_request_id IS NOT NULL THEN r.self_serve_request_id END),
    COUNT(DISTINCT r.self_serve_request_id)
  ) AS pct_downloaded
FROM `evenup-bi.dbt_prod.fact_self_serve_request` r
LEFT JOIN (
  SELECT DISTINCT self_serve_request_id
  FROM `evenup-bi.dbt_prod.fact_self_serve_revision_downloads`
  WHERE revision_type = 'ai_generated'
    AND first_downloaded_at IS NOT NULL
    AND revision_created_at >= TIMESTAMP(DATE_TRUNC(
          DATE_SUB(CURRENT_DATE('America/New_York'), INTERVAL 3 WEEK), WEEK(MONDAY)))
) d ON r.self_serve_request_id = d.self_serve_request_id
WHERE NOT r.is_test_firm
  AND NOT r.is_internal_requester
  AND r.request_type NOT LIKE '%Workstation'
  AND r.date_requested >= TIMESTAMP(DATE_TRUNC(
        DATE_SUB(CURRENT_DATE('America/New_York'), INTERVAL 2 WEEK), WEEK(MONDAY)))
GROUP BY 1, 2, 3
HAVING total_requests >= 5
ORDER BY pct_downloaded ASC
LIMIT 20
```
