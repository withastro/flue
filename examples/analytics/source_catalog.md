# Source Catalog

The waiter uses this catalog to decide which sources the explorer should search.

## Knowledge Base (`kb`)

Stable product truth, definitions, data model explanations, known caveats, and maintained internal docs. Best for:

- Product and platform definitions.
- Stable behavior like FLP/CLP, MDC, SDR, billing credits, Workstation, AI Playbooks.
- Known caveats and maintained explanations.

## dbt Manifest (`manifest`)

Available warehouse models, columns, descriptions, and lineage. Best for:

- Finding which table/model/column contains a metric.
- Understanding dbt model lineage.
- Drafting analytics SQL from warehouse structure.

## BigQuery (`bigquery`)

Bounded warehouse validation after likely models/columns have been identified. Best for:

- Dry-running SQL to validate syntax, columns, and estimated bytes.
- Checking row counts, date ranges, non-null population, and top/distinct values.
- Confirming exact string/enum filter values before final SQL.
- Testing whether a candidate model can support the intended query shape.

Use manifest/dbt first for discovery. Use BigQuery for validation, not as the first-line source search.

## Metabase (`metabase`)

Existing cards, dashboards, SQL examples, and prior metric implementations. Best for:

- Checking if a dashboard/card already exists.
- Finding how a metric was previously calculated.
- Reusing visualization patterns.

## Slack (`slack`)

Recent discussions, rollout decisions, ownership, tribal knowledge, and unresolved debates. Best for:

- "What did we decide?"
- "Who owns this?"
- "Why did this change?"
- Recent operational context not yet documented.

## Google Drive (`drive`)

PRDs, specs, project plans, launch docs, and stakeholder-facing documents. Best for:

- Product specs.
- Launch plans.
- PM-authored docs.
- Project strategy docs.

## Repo (`repo`)

Implementation truth from source code and checked-in docs. Best for:

- Where behavior is implemented.
- Event emission details.
- API or service ownership.
- Code-level validation of product behavior.

## Jira Automation (`jira`)

Engineering history and workflow automation via `jira-automation-api`. Best for:

- Looking up recent PR/Jira history by product, squad, repo, or Jira project context.
- Resolving product/squad scope to GitHub repos and Jira project keys.
- Creating workflow tickets/PRs for specialized workflows after confirmation.

## Implementation Status

Currently implemented in this prototype:

- `kb`
- `manifest`
- `bigquery` dry-run, row count, date range, and top/distinct values
- `metabase` research/help, with card creation gated by policy
- `slack` search/thread reading
- `drive` search/list/read/download, with create/upload gated by policy
- `jira` taxonomy/scope/history query, with ticket/PR creation gated by policy

Planned harnesses:

- `repo`
