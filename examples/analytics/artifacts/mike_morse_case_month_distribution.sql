with base as (
    select
        matter_id,
        date(created_at_et) as created_date_et,
        date_of_incident
    from `evenup-bi.dbt_prod.dim_matters`
    where lower(firm_name) = lower('Mike Morse Law Firm')
),
monthly_distribution as (
    select
        'case_creation_month' as distribution_type,
        date_trunc(created_date_et, month) as month_bucket,
        count(distinct matter_id) as case_count
    from base
    group by 1, 2

    union all

    select
        'date_of_incident_month' as distribution_type,
        date_trunc(date_of_incident, month) as month_bucket,
        count(distinct matter_id) as case_count
    from base
    group by 1, 2
)
select
    distribution_type,
    month_bucket,
    case_count
from monthly_distribution
order by distribution_type, month_bucket;
