# Kili Annotation System

## Overview

**Kili** is a third-party annotation management platform used to coordinate human labelers for ground truth annotation work. Files uploaded to EvenUp are sent to Kili where human annotators label documents with structured data (entities, classifications, relationships, bounding boxes).

## Core Concepts

### Files and Shards

**File (Document):**
- A complete PDF uploaded to EvenUp for annotation
- Identified by `file_id` (UUID) in EvenUp systems
- Has a total `page_count` for the entire document
- Tracked in `mart_files_to_be_annotated` at the file level

**Shard:**
- Files are split into smaller chunks called "shards" for annotation processing
- Each shard is annotated independently by human labelers
- Shard identifier format: `{file_uuid}[shard_index]`
  - Example: `abc-123-def[0]`, `abc-123-def[1]`, `abc-123-def[2]`
- Each shard has its own `page_count` (subset of the full document)
- Tracked in `kili_data_union` at the event level

**Key relationship:**
- One file → Multiple shards
- One shard → Multiple events (as it progresses through workflow stages)

### Annotation Workflow Stages

Files move through Kili in stages, tracked by `label_type` field:

**1. DEFAULT - Initial Labeling**
- Human annotator actively labels the shard
- Extracts entities, classifications, relationships, draws bounding boxes
- Multiple DEFAULT events can occur if work is modified/resubmitted

**2. REVIEW - Quality Review**
- Reviewer verifies the labeler's work
- Makes corrections if needed
- Can send work back for corrections (see Sent Back below)

**Additional label types:**
- **AUTOSAVE**: Auto-saved work in progress (not a complete submission)
- **PREDICTION**: Pre-populated predictions from ML models
- **Sent Back**: When `document_state = 'sent_back'` and `label_type = 'DEFAULT'`, means reviewer rejected the work and sent it back to the labeler

### Data Models

**`mart_files_to_be_annotated`** (File-level view)
- One row per file in the annotation queue
- Shows when file was uploaded to Kili: `file_uploaded_to_kili_at_et`
- Contains `annotation_type` (Standard, Basic+, etc.)
- Contains `kili_project` (project name in Kili)
- **Does not track sharding or shard-level status**

**`kili_data_union`** (Event-level data)
- One row per annotation event (labeling or review action)
- Each shard generates multiple events as it moves through stages
- Key fields:
  - `document_uuid`: The file UUID (parsed from `document` field)
  - `document`: Full shard identifier with format `{uuid}[shard_index]`
  - `document_shard_index`: Just the shard number (0, 1, 2, etc.)
  - `label_type`: Stage of annotation (DEFAULT, REVIEW, AUTOSAVE, PREDICTION)
  - `page_count`: Pages in this specific shard
  - `start_time`, `end_time`: When the labeling/review occurred
  - `time_spent`: Time annotator spent on this work
  - `author`: Who performed the work
  - `time_retrieved`: When the Kili stats job pulled this event data
  - `document_state`: Asset state in Kili (e.g., 'sent_back')

**`kili_file_state_by_shard`** (Derived shard status)
- Pivots shard events to show latest status per shard
- One row per shard showing:
  - `label_timestamp`, `label_time_spent`, `label_author`: When/how long/who did initial labeling
  - `review_timestamp`, `review_time_spent`, `review_author`: When/how long/who did review
  - `sent_back_timestamp`: If work was rejected and sent back

**`latest_kili_shard_status`** (Most recent status)
- One row per shard showing the most recent non-autosave status
- Useful for determining current state of each shard

## Important Data Characteristics

### Event-Based Tracking
- `kili_data_union` contains event history, not current state
- Multiple events exist for the same shard as it progresses
- Use `time_retrieved` to identify the latest event
- AUTOSAVE and PREDICTION events should be filtered out for workflow status tracking

### File vs Shard Granularity Gap
- `mart_files_to_be_annotated` shows what files are queued
- `kili_data_union` shows shard-level progress
- A file may have some shards complete and others still in progress
- A file may be in `mart_files_to_be_annotated` but have no shards in `kili_data_union` yet (uploaded but not yet assigned)

### Multiple Events Per Stage
- A shard can have multiple DEFAULT events (corrections, resubmissions)
- A shard can have multiple REVIEW events (multiple reviewer passes)
- Use `time_retrieved DESC` to get the latest event for each stage

## Common Query Patterns

### Check shard-level status
```sql
SELECT
  document_uuid,
  document as shard_identifier,
  CASE
    WHEN MAX(CASE WHEN label_type = 'REVIEW' THEN 1 ELSE 0 END) = 1 THEN 'reviewed'
    WHEN MAX(CASE WHEN label_type = 'DEFAULT' THEN 1 ELSE 0 END) = 1 THEN 'labeled'
    ELSE 'unknown'
  END as shard_status
FROM {{ ref('kili_data_union') }}
WHERE label_type NOT IN ('AUTOSAVE', 'PREDICTION')
GROUP BY 1, 2
```

### File-level aggregation
```sql
-- Join files to their shards to see overall progress
SELECT
  f.file_id,
  f.filename,
  COUNT(DISTINCT k.document) as total_shards,
  SUM(CASE WHEN k.label_type = 'REVIEW' THEN 1 ELSE 0 END) as reviewed_shards
FROM {{ ref('mart_files_to_be_annotated') }} f
LEFT JOIN {{ ref('kili_data_union') }} k
  ON f.file_id = k.document_uuid
GROUP BY 1, 2
```

---

**Last Updated:** 2026-02-03
