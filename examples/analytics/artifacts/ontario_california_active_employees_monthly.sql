WITH month_snapshots AS (
  SELECT
    DATE_TRUNC(summary_date, MONTH) AS month,
    MAX(summary_date) AS snapshot_date
  FROM `evenup-bi.dbt_prod.dim_employees_history`
  GROUP BY 1
)
SELECT
  ms.month,
  COUNT(
    DISTINCT IF(
      eh.geo_country = 'CA' AND eh.geo_state_province = 'ON',
      eh.employee_canonical_id,
      NULL
    )
  ) AS ontario_canada_active_employees,
  COUNT(
    DISTINCT IF(
      eh.geo_country = 'US' AND eh.geo_state_province = 'CA',
      eh.employee_canonical_id,
      NULL
    )
  ) AS california_active_employees
FROM month_snapshots AS ms
LEFT JOIN `evenup-bi.dbt_prod.dim_employees_history` AS eh
  ON eh.summary_date = ms.snapshot_date
GROUP BY 1
HAVING ontario_canada_active_employees > 0 OR california_active_employees > 0
ORDER BY ms.month;
