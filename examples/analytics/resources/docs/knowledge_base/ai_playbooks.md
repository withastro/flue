# AI Playbooks - SQL Development Guide

## Overview

AI Playbooks allow firms to define custom questions (prompts) to extract information from case files automatically. Playbooks can run on-demand or automatically when new files are added.

## Feature Flags

**Firm-level:**
- `ai_case_prompts`
- `ai_playbooks_view_results_in_portal`
- `enable_daily_digests_email` (default since 11/13)
- `disable_ai_playbooks_daily_digest_emails` (opt-out of digests)

**User-level:**
- `ai_playbooks_external_write_access` (editor access)

## Core Business Logic

### Promptset Status
- Playbooks can exist in draft or published status
- `is_published = true` (derived from `status = 'published'`): Published and can run on cases
- `is_deleted = true` (derived from `deleted_at_et is not null`): Deleted playbooks
- Test playbooks are excluded from all queries (`where not regexp_contains(name, r'(?i)\btest\b')`)

### Autorun Logic

**For CI firms:**
- Playbook runs if BOTH conditions are met:
  1. New file added to case
  2. External user (non-staff) views the case page after file upload
- Internal user page visits do NOT trigger autorun

**For non-CI firms:**
- Autorun playbook runs every night if new files have been added

**Limitations:**
- Only 1 playbook per case type can be set to autorun
- Manual run is recommended default
- 12 automated runs per playbook per case maximum

### Pinning
- Only 1 playbook per case type can be pinned to case page
- Pinned playbooks appear at bottom of case overview page
- If a 2nd playbook is pinned to same case type, first one gets unpinned

### Run Tracking
Each promptset result has:
- `run_id`: Unique identifier for each run
- `created_at_et`: When the run occurred
- `next_run_at_et`: When the next run occurred (or '9999-01-01' if last run)
- `is_automated_run`: Whether it was autorun vs manual

## Data Model Architecture

### Core Tables

#### `dim_ai_playbook`
Dimension table containing playbook configurations.

**Key columns:**
- `ai_promptset_id`: Unique playbook identifier
- `firm_id`, `firm_name`: Firm ownership
- `ai_promptset_name`: Playbook name
- `ai_promptset_description`: Playbook description
- `promptset_status`: Current status (e.g., 'published')
- `is_published`: Boolean derived from status
- `is_deleted`: Boolean derived from deleted_at
- `is_pinned`: Whether pinned to case page
- `is_automatic`: Whether playbook runs automatically
- `mode`: Playbook mode setting
- `is_template`: Whether this is a template playbook
- `template_ai_promptset_id`, `template_name`: Template source if copied from template
- `created_by_id`, `updated_by_id`, `deleted_by_id`: User tracking
- `published_at_et`, `created_at_et`, `updated_at_et`, `deleted_at_et`: Timestamps
- `query_instructions`, `text_style_instructions`: Advanced settings for prompt engineering
- `boosted_fields`: JSON object for search field boosting

**Business rules:**
- Test playbooks excluded via name pattern matching
- Templates identified by:
  1. Matching prompt text to known template IDs
  2. Name patterns containing 'Standard', 'Stage', or 'MVA Prep'

#### `dim_ai_playbook_matter_pairs`
Junction table linking playbooks to eligible matters.

**Key columns:**
- `ai_promptset_id`: Playbook identifier
- `matter_id`: Matter identifier
- `firm_id`: Firm (must own both playbook and matter)
- `playbook_created_at_et`: When playbook was created
- `matter_created_at_et`: When matter was created
- `pair_valid_from_et`: When the pair became valid (later of the two creation times)

**Business rules:**
- Matches based on same firm_id and same case_type
- A playbook applies to a matter if they share firm and case type

#### `fact_ai_playbook_promptset_result_actions`
Fact table combining playbook runs with user actions (views, downloads).

**Key columns:**
- `run_id`: Unique run identifier
- `promptset_result_id`: Result identifier
- `created_at_et`: When result was created
- `next_run_at_et`: When next run occurred (or '9999-01-01')
- `promptset_results_is_automated_run`: Boolean for autorun
- `ai_promptset_id`: Playbook identifier
- `matter_id`: Case identifier
- `firm_id`, `firm_name`: Firm information
- `is_template`, `template_ai_promptset_id`, `template_name`: Template tracking
- `promptset_status`, `is_published`, `is_deleted`: Playbook status
- `promptset_mode`, `promptset_is_automatic`: Playbook settings
- `event_time_et`, `event_type`: User action details
- `user_id`, `user_name`, `user_email`: User who performed action
- `is_staff`: Staff vs external user (filtered to false)

**Business rules:**
- Only external users (is_staff = false)
- Events matched to promptset results by checking if event time falls between result creation and next run
- Test results excluded (is_test = false)

#### `fact_amplitude_ai_playbook_events`
Raw Amplitude events for AI Playbooks.

**Key columns:**
- `event_time_et`: When event occurred
- `event_type`: Type of event (all start with '[AI Playbooks]')
- `event_properties`, `user_properties`: JSON objects with event details
- `ai_promptset_id`, `ai_promptset_name`: Playbook identifiers
- `matter_id`: Case identifier
- `user_id`, `user_name`, `user_email`: User who triggered event
- `ai_prompt_result_id`, `ai_prompt_name`: Individual prompt details
- `firm_id`, `firm_name`: Firm information
- `is_staff`: Staff vs external user

**Filtered event types:**
- All events where `event_type like '[AI Playbooks]%'`

## Key Product Concepts

### Promptset = Playbook = AI Playbook
A collection of prompts (questions) configured to run together on specific case types.
- **Terms are synonymous:** AI Playbook = Promptset
- `ai_promptset_id`: Unique identifier
- Each promptset belongs to one firm
- Can be set to manual or automatic run
- When a playbook runs, all its prompts run together
- Maximum 100 prompts per case type

### Prompt = Sub-question
Individual question within a playbook.
- A prompt is a sub-question within a promptset
- Each prompt has `prompt_text` (the actual question)
- Results stored per prompt per case
- Prompts can have prioritized sources and advanced settings
- All prompts in a playbook execute together when the playbook runs

### Template
Pre-built playbooks that firms can duplicate and customize.
- Stage-specific templates (1-5)
- Pinned playbook template
- Templates identified by:
  - Exact prompt_text matches to known template IDs
  - Name patterns ('Standard', 'Stage', 'MVA Prep')

### Run Modes
- **Manual**: User clicks "Run" button to execute (recommended default)
- **Automatic**: Runs based on triggers (file upload + page view for CI, nightly for non-CI)

### Case Type
Playbooks are configured to apply to specific case types (e.g., Motor Vehicle Collision, Medical Malpractice).
- Playbooks only run on matters matching their configured case types
- A playbook can apply to multiple case types

### Pinned Playbook
A playbook displayed at the bottom of the case overview page.
- Only 1 playbook per case type can be pinned
- Pinning a 2nd playbook to same case type unpins the first

## User Engagement Tracking

### Amplitude Event Types

All events prefixed with `[AI Playbooks]`:

1. **`[AI Playbooks] View AI Playbook`**: User viewed the playbook configuration or settings
2. **`[AI Playbooks] View AI Playbook Result`**: User viewed playbook results in the AI Playbooks tab
3. **`[AI Playbooks] View Pinned AI Playbook Result`**: User viewed pinned playbook results on case overview page
4. **`[AI Playbooks] Download AI Playbook Docx`**: User downloaded playbook results as Word document

**Event properties contain:**
- `ai_playbook_id`: Promptset identifier
- `ai_playbook_name`: Promptset name
- `case_id`: Matter identifier
- `prompt_id`: Individual prompt result identifier (if applicable)
- `prompt_name`: Individual prompt name (if applicable)

### Engagement Metrics

**`fact_ai_playbook_promptset_result_actions`:**
- Joins promptset result runs with user actions (events 2-4 above)
- Only external users (`is_staff = false`)
- Events matched to runs by time window

**`fact_workflow_and_insight_case_external_usage_by_date`:**
- Daily engagement count: `ai_playbook_engagement_count`
- Includes all view and download events per matter/user/date
- Part of W&I product bundle usage tracking

## Data Quality Considerations

**Important for SQL queries:**

1. **Test playbooks excluded**: Always filter with `where not regexp_contains(name, r'(?i)\btest\b')` or use `dim_ai_playbook` which already excludes tests

2. **Template identification is heuristic**:
   - Based on matching prompt text to known template IDs
   - Name pattern matching ('Standard', 'Stage', 'MVA Prep')
   - Not a perfect system, may have false positives/negatives

3. **Event-to-result matching window**:
   - Events matched to results by time window (between created_at_et and next_run_at_et)
   - If multiple runs occurred, event is attributed to the run it falls within

4. **High-volume firms**: Some firms are on a high-volume list and require engineering monitoring before enabling autorun

5. **Limitations**:
   - 100 prompts per case type maximum
   - 12 automated runs per playbook per case
   - Not suitable for Mass Torts (no dashboard/docket view for triaging)

6. **Email notifications**: Daily digest is default since 11/13; individual emails available via opt-out flag
