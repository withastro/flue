# Bills Summary - SQL Development Guide

## Overview

Medical Bills Summary provides total medical bill charges and provider-level breakdowns for personal injury cases. This document covers the data model, business logic, and SQL patterns needed for analytics and reporting.

## Feature Flags

Bills Summary availability depends on:
- `case_medical_bill_summary`
- `case_financials_widget_pre_demand`

Query `fact_firm_products_enabled` to identify firms with Bills Summary enabled.

## Core Business Logic

### Charge Inclusion Rules
1. **Date filtering:** Charges before incident date are automatically excluded
2. **System status:** Only charges with `system_status = 'Included'` and `system_assessment = 'Valid'` are counted
3. **Deduplication:** AI automatically deduplicates charges
4. **Unrelated charges:** AI detects and excludes unrelated charges (on roadmap for auto-exclusion)
5. **User editability:** Users can manually edit charge values, provider assignments, and include/exclude toggles

### Charge Amount Logic

Bills Summary uses a hierarchical charge structure with **two levels:**

1. **Table-level charges:** Parent-level bill line items with `level = 'Table'`
2. **Itemized charges:** Child-level detailed charges with `level = 'Charge'` and a `parent_id`

**Effective Amount Calculation:**
```
IF there are excluded itemized children:
    effective_amount = sum(included itemized children amounts)
ELSE:
    effective_amount = table_annotated_amount OR sum(itemized children amounts)
```

This logic ensures that user exclusions are respected while falling back to table-level amounts when no exclusions exist.

### Data Sources

Bills Summary pulls from two sources:
- **Human-annotated:** Bill line items without a `snapshot_id` (uses `min(created_at)` as snapshot time)
- **CLP-generated (AI):** Bill line items with a `snapshot_id` linked to `entities_snapshot` table

The system uses the **latest snapshot** per matter (ranked by `snapshot_created_at desc`).

## Data Model Architecture

### Core Tables

#### `bills_summary_initial_table_charges`
Foundation table containing all table-level charges with effective amounts.

**Key columns:**
- `matter_id`: Case identifier
- `provider_id`, `name`: Provider information
- `bill_lineitem_id`: Table-level charge ID
- `table_annotated_amount`: Original table-level amount
- `sum_included_itemized_children`: Sum of non-excluded child charges
- `num_included_itemized_children`: Count of included children
- `num_excluded_itemized_children`: Count of excluded children
- `effective_amount`: Final amount used in totals (see logic above)

**Business rules:**
- Only includes charges from cases created after April 1, 2025
- Uses latest snapshot per matter
- Table-level charges must have `system_status = 'Included'` and `system_assessment = 'Valid'`

#### `fact_bills_summary_usage_by_date`
Daily usage tracking for bills summary feature.

**Key columns:**
- `summary_date`: Date of usage
- `matter_id`, `firm_id`, `user_id`: Entity identifiers
- `is_internal_user`: Staff vs external user flag
- `time_on_page`: Seconds spent viewing (minimum 10 seconds)

**Business rules:**
- Only counts modal opens on `/cases/{matter_id}/medical-bills` route
- Filters out accidental clicks (< 10 seconds)
- Aggregates to user-date-matter grain

#### `mart_bills_summary_usage_summary`
Aggregated usage metrics by matter.

**Metrics:**
- `internal_user_modal_view_count/time`: Staff engagement
- `external_user_modal_view_count/time`: Customer engagement

#### Evaluation Tables

**`fact_bills_summary_lops_gt_case_totals`**
Ground truth data from LOPs (Legal Operations) team for evaluation.

**Key filters:**
- Only includes Standard, Basic+, Simple demand types
- Only matters with `first_completed_at_et` (completed demands)
- Only evaluates cases with `total_billed >= 1000`
- Uses `case_provider_info` as ground truth source

**`mart_bills_summary_case_totals_eval`**
Compares Bills Summary totals vs LOPs ground truth at case level.

**Metrics:**
- `bills_summary_total_charges`: AI-extracted total
- `lops_total_billed`: Human-verified total
- `pct_error`: (AI - Human) / Human
- `abs_pct_error`: Absolute percentage error

**Business rules:**
- Only compares when demand was completed within 14 days of bill summary creation

**`mart_bills_summary_provider_totals_eval`**
Evaluates provider-level accuracy using precision/recall.

**Metrics:**
- `num_bs_providers`: Provider count from Bills Summary
- `num_gt_providers`: Provider count from ground truth
- `num_provider_matches`: Exact matches (same provider name AND same total)
- `provider_recall`: Matches / Ground truth providers
- `provider_precision`: Matches / Bills Summary providers

## Key Product Concepts

### Provider
Medical provider that issued bills. Each provider is identified by:
- `provider_id`: Unique identifier for the provider within a matter
- `name`: Provider name
- **Multiple provider IDs exist:**
  - `annotated_provider_id`
  - `user_provider_id`
  - `reconciled_provider_id`

### Date of Service
Found in `date_of_service` column.
- Charges before the incident date are automatically excluded
- Some bills may have aggregated dates when itemized dates couldn't be detected

### Charge Amounts

**Multiple amount fields exist in bill line items:**

- `charge_amount`: Original billed amount
- `total_amount`: Total after adjustments
- `adjusted_amount`: Amount after insurance/adjustments applied
- `amount`: AI-extracted amount from PDF
- `annotated_amount`: Final amount after AI annotation (primary field for calculations)
- `user_amount`: User-edited override amount
- `annotated_write_off`: Write-off amount from AI
- `user_edited_write_off`: User-edited write-off

**The effective amount logic** (used in `bills_summary_initial_table_charges`):
- Prioritizes itemized child sums when exclusions exist
- Falls back to table-level `annotated_amount` otherwise
- This ensures user exclusions are respected

### Bill Line Item Hierarchy

**Two levels of charges:**

1. **Table-level (`level = 'Table'`)**: Parent bill line items representing an entire bill or date range
2. **Charge-level (`level = 'Charge'`)**: Child itemized charges with a `parent_id` linking to table-level

Some bills only have table-level amounts (no itemization detected by AI).

**Only charges with `system_status = 'Included'` AND `system_assessment = 'Valid'` count toward totals.**

### Snapshots

Bills Summary data comes from snapshots:
- `snapshot_id`: Links to `entities_snapshot` table (CLP/AI-generated bills)
- Bills without `snapshot_id`: Human-annotated bills
- **Latest snapshot per matter is used** (most recent `snapshot_created_at`)

Each time AI processes bills, it creates a new snapshot. The system always uses the most recent one.

### Usage Tracking

Users interact with Bills Summary by opening a modal, which is how product usage KPIs are tracked.

**Amplitude events tracked:**
- Modal opens on `/cases/{matter_id}/medical-bills` route
- Time modal is open (minimum 10 seconds to filter accidental clicks)
- User type: `is_internal_user` (staff) vs external users (customers)

Found in `fact_bills_summary_usage_by_date` and aggregated in `mart_bills_summary_usage_summary`.

### Ground Truth Source

**`case_provider_info`**: Human-verified provider charges from LOPs (Legal Operations) team
- Most reliable source for evaluation and reconciliation
- Used to measure Bills Summary AI accuracy

## Data Quality Considerations

**Important for SQL queries:**

1. **Only available for cases created after April 1, 2025** - Always filter `created_at >= '2025-04-01'`

2. **No sync between Bills Summary and Express Demand:** User edits in Bills Summary don't sync to Express Demand (as of Oct 14, 2025). Provider name edits also don't sync with MDC or Treatment Timeline.

3. **Bills Summary vs Demand data source differences:**
   - **Bills Summary:** AI-generated from all currently uploaded files
   - **Demand (`case_provider_info`):** Human-verified by LOPs team, most reliable ground truth

4. **Unrelated charges during treatment period:** Charges before incident date are auto-excluded, but unrelated charges occurring during treatment period are NOT automatically excluded (user must manually exclude)

5. **Adjustments visibility:** Controlled by firm setting "collateral source rule" (must be `On`)
