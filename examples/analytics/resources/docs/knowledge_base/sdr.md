# Settlement Data Repository (SDR)

**Last Updated:** 2026-03-13

## Overview

SDR (Settlement Data Repository) is an EvenUp product that collects settlement outcome data from law firms. It operates as a **separate system** from the Portal with its own database (`prod_sdr_sql`). Cases and files are **auto-ingested from the firm's CMS** — firms do not manually enter cases into SDR.

SDR's primary purpose is to capture settlement outcomes (amounts, insurance policies, negotiations) so EvenUp can train models and provide settlement benchmarking to firms. The settlement estimate search feature (tracked in Amplitude as `Estimate Search Submitted`) is part of this product.

SDR matters are **excluded from Portal-facing models** like `dim_matters` and `fact_missing_doc_check_casechecks` — SDR annotation types are filtered out of the main annotation tracking pipeline.

---

## Key Concepts

| Concept | Description |
|---|---|
| **SDR case** | A case in the SDR system, auto-ingested from a firm's CMS. May or may not correspond to a Portal matter. |
| **`ext_id`** | The CMS external case ID on `integration_case`. This is the **canonical key** for joining an SDR case to a Portal matter. |
| **`lops_id`** | The old integer `case_id` from Portal. **Not the `matter_id` UUID.** Only cases that had expert demand workflows have a `case_id`, so `lops_id` is NULL for many SDR cases. Do not use as the primary join key to Portal. |
| **Non-portal SDR case** | An SDR case where `lops_id IS NULL` — the case exists in SDR but has no linked expert demand case in Portal. Use `ext_id` join or fuzzy match to find the corresponding matter. |
| **`pre_annotation_only` firm** | Firm flag where SDR files go through ML-based automated entity extraction only — they do not continue to human annotation workflows in Kili. |
| **SDR-enabled date** | Proxied by the earliest file ingestion or case creation date in SDR for a given firm — there is no direct engineering enablement timestamp. |

---

## Data Model

### Core Tables

| Table | Key Fields | Notes |
|---|---|---|
| `integration_case` | `id`, `ext_id`, `lops_id`, `firm_id`, `plaintiff_id`, `date_of_incident` | `ext_id` = CMS external ID; `lops_id` = old Portal integer case_id |
| `integration_file` | `id`, `case_id`, `document_type`, `category`, `ext_id` | `case_id` → `integration_case.id`; files auto-ingested from CMS |
| `integration_firm` | `id`, `auth_service_id`, `pre_annotation_only` | `auth_service_id` (cast to int) = Portal/LOPS firm ID |
| `integration_plaintiff` | `id`, `first_name`, `last_name`, `date_of_birth`, `firm_id` | |
| `integration_insurancepolicy` | `id`, `case_id`, `coverage_type`, `policy_amount`, `carrier_id` | `case_id` → `integration_case.id`; one case can have multiple policies |
| `integration_lopspolicyinformation` | `policy_id`, `limit`, `coverage_type`, `carrier_name`, `adjuster_name` | Enriched policy info from LOPS; `policy_id` → `integration_insurancepolicy.id` |
| `integration_insurancecarrier` | `id`, `name` | Carrier lookup |
| `integration_settlement` | `id`, `case_id`, `policy_id`, `settlement_amount`, `inferred_settlement_amount`, `inferred_policy_id`, `date_settled` | `policy_id` → `integration_insurancepolicy.id`; uses inferred amounts/policy when direct link is unavailable |
| `integration_settlementnegotiations` | `policy_id`, `negotiation_type`, `negotiation_date`, `negotiation_amount` | `negotiation_type = 'offer'` for offers; first offer by date = opening settlement offer |

### Annotation Tables

| Table | Description |
|---|---|
| `annotation_annotationrequest` | Links annotation work to an SDR case via `sdr_case_id`. |
| `annotation_annotationfile` | Per-file annotation results. Contains `pre_annotation_excerpt_data` (entities from ML-based automated extraction) and `excerpt_data` (entities after subsequent processing — exact definition unconfirmed, reach out to AI entities team) as JSON. Both hold charges, ICD codes, CPT codes, provider names, and dates of service. |
| `sdr_annotationfile_entities` | Parses the JSON fields from `annotation_annotationfile` into typed arrays: charges, ICD codes, CPT codes, provider names, dates of service. |
| `sdr_annotation_diff_metrics` | Aggregates pre/post annotation entities per SDR case and computes diffs between the two sets of extracted entities. |

---

## Joining SDR to Portal

### Canonical: SDR case → `matter_id` (UUID)

Use `integration_case.ext_id` joined to `stg_lops_sql__public_integrations_matter.external_id`, disambiguated by firm. This is the most reliable join — it works for all SDR cases, regardless of whether `lops_id` is populated.

```sql
WITH ci_matters AS (
    SELECT * FROM {{ ref('stg_lops_sql__public_integrations_matter') }}
),

sdr_firms AS (
    SELECT id AS sdr_firm_id, CAST(auth_service_id AS INT) AS firm_id
    FROM {{ ref('stg_prod_sdr_sql__public_integration_firm') }}
)

SELECT
    ci_matters.matter_id,
    sdr.id AS sdr_case_id
FROM ci_matters
INNER JOIN {{ ref('stg_prod_sdr_sql__public_integration_case') }} AS sdr
    ON ci_matters.external_id = sdr.ext_id
INNER JOIN sdr_firms AS f
    ON sdr.firm_id = f.sdr_firm_id AND ci_matters.firm_id = f.firm_id
```

To get files for a `matter_id`, extend this join: `integration_file.case_id → integration_case.id`.

### Fallback: Fuzzy match for non-portal SDR cases

When `lops_id IS NULL` and the `ext_id` join yields no match, use fuzzy matching:
- Same firm (via `integration_firm.auth_service_id`)
- Same `date_of_incident`
- Same plaintiff last name + first 3 characters of first name

This is implemented in `stg_sdr_evenup_fuzzy_match`. The match is deduped by latest `date_requested` if multiple Portal cases match the same plaintiff + DOI + firm.

### Why not `lops_id`?

`lops_id` is the old integer `case_id` from Portal — **not** the `matter_id` UUID. It only exists for cases that had expert demand workflows, which is a subset of all matters. Many SDR cases will have `lops_id IS NULL`. Use the `ext_id` join above instead.

### Firm mapping

`integration_firm.auth_service_id` (cast to int) = Portal firm ID. Always join through `integration_firm` when mapping SDR firms to Portal/LOPS firm IDs.

---

## Downstream Models

| Model | Description |
|---|---|
| `settlement_policies` | Canonical settlement output: joins SDR settlements + insurance policies + LOPS policy info + carriers + first offer. |
| `stg_sdr_evenup_fuzzy_match` | Fuzzy matches all SDR cases (without `lops_id`) to Portal cases using firm + DOI + plaintiff name. |
| `intermediate_sdr_feature_flag` | Computes `sdr_enabled_date` per firm (proxied by earliest file/case creation in SDR). Used in `fact_firm_products_enabled` for the `sdr_enabled` flag. |
| `sdr_search_estimates` / `sdr_estimate_pageviews` | Amplitude-tracked user activity for the settlement estimate search feature. |
| `sdr_annotation_diff_metrics` | Computes diffs between pre/post annotation entity sets per SDR case (providers, charges, ICD/CPT codes, dates of service). |

---

## Data Quality Considerations

- Not every SDR case has a corresponding Portal matter, and not every Portal matter exists in SDR.
- `lops_id IS NULL` is common and expected — use `ext_id` join as the primary Portal linkage strategy.
- Settlement data may use inferred amounts/policies when direct policy links are unavailable.
- `dim_matters` and annotation tracking models **exclude SDR** — SDR annotation types are filtered out.
- SDR-enabled date is a proxy (first file/case creation), not an exact engineering enablement timestamp.
