WITH base AS (
  SELECT
    DATE_TRUNC(DATE(created_at_et), MONTH) AS case_creation_month,
    DATE_TRUNC(date_of_incident, MONTH) AS incident_month
  FROM `evenup-bi.dbt_bgu.dim_matters`
  WHERE firm_name = 'Mike Morse Law Firm'
)
SELECT
  metric,
  month_label,
  case_count,
  ROUND(100 * case_count / SUM(case_count) OVER (PARTITION BY metric), 2) AS pct_of_metric
FROM (
  SELECT
    'case_creation_month' AS metric,
    FORMAT_DATE('%Y-%m', case_creation_month) AS month_label,
    case_creation_month AS sort_month,
    COUNT(*) AS case_count
  FROM base
  GROUP BY 1, 2, 3

  UNION ALL

  SELECT
    'date_of_incident_month' AS metric,
    COALESCE(FORMAT_DATE('%Y-%m', incident_month), 'Unknown') AS month_label,
    IFNULL(incident_month, DATE '0001-01-01') AS sort_month,
    COUNT(*) AS case_count
  FROM base
  GROUP BY 1, 2, 3
)
ORDER BY metric, sort_month;