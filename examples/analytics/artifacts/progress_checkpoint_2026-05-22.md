# Analytics Agent Progress Checkpoint

Updated: 2026-05-22 18:02:00 EDT

## What Is Built

- Flue-based agent stack exists in `examples/analytics` with these active agents:
  - `waiter`
  - `explorer`
  - `analytics`
  - `dbt-explorer`
- Role-based prompt structure is in place. Stable behavior lives in `.flue/roles/*.md`; TypeScript prompts are now mostly per-run envelopes.
- Waiter/explorer/station architecture is implemented:
  - waiter receives every user-initiated message
  - waiter can pass smooth mainline continuations directly to the active station without preflight
  - waiter owns routing, work-order drafting, and final review for new/flagged/disrupted turns
  - explorer is shared bounded research utility
  - analytics/knowledge/workflow/documentation are station roles
- Explicit turn/session management is implemented:
  - payload `turnType`: `mainline`, `side_question`, `rework`, `topic_switch`
  - payload `streamName` and `branchName` can pin a topic stream or side branch
  - every user turn reaches waiter first
  - unflagged mainline turns with an active route may skip preflight and continue the station session directly
  - waiter-mediated turns use detached per-run preflight explorer sessions
  - station sessions are stable for mainline/rework and branched for side questions/topic switches
- BigQuery native tools are implemented:
  - `run_bigquery`
  - `preview_bq_csv`
  - `get_distinct_values`
  - `bq_validate_query`
  - `bq_row_count`
  - `bq_date_range`
  - `bq_top_values`
- Manifest, Metabase, Slack, Google Drive, and Jira tool surfaces are ported.
- OAuth token bridge for local dev is implemented:
  - `examples/analytics/scripts/sync-oauth-tokens.mjs`
  - `npx pnpm@11.1.1 --dir examples/analytics run sync:oauth`
  - syncs `SLACK_USER_TOKEN` and `GOOGLE_USER_ACCESS_TOKEN` into `examples/analytics/.env.secrets`
- KB tasker was removed; explorer is now the single shared research path.
- Firestore/GCS persistence substrate is implemented:
  - semantic context tools: `user_context_read`, `user_context_upsert`, `project_context_read`, `project_context_propose_update`
  - `learnthis_save` is a convenience alias for explicit user memory saves
  - personal skill tools: `personal_skill_list`, `personal_skill_create`, `personal_skill_update`
  - semantic artifact tools: `report_local_write`, `report_local_read`, `report_local_edit`, `artifact_write`, `report_artifact_write`, `report_artifact_upload`, `artifact_read_metadata`, `artifact_get_link`
  - semantic workflow/trace tools: `workflow_state_get`, `workflow_state_put`, `workflow_state_append_event`, `trace_get`
  - defaults align to `dbt-explorer-api`: project `evenup-internal-tools`, dev database `dev-dbt-explorer-api`, dev bucket `evenup-internal-tools-dev-dbt-explorer-api`
  - GKE chart env overrides use database `dbt-explorer-api` and bucket `evenup-internal-tools-dbt-explorer-api`
  - cloud mode uses Google REST APIs via `google-auth-library`
  - local dev/test mode falls back to `/tmp/flue-analytics-persistence` or `FLUE_LOCAL_PERSISTENCE_DIR`
  - GCS paths match the current app: `dbt-explorer/{conversationId}/outputs/...` and `report-files/...`
  - report links use `https://dbt-explorer-api.apps.evenup.law/reports/doc/{docPath}`
  - report workflows should draft/edit locally first, then upload the final file to GCS

## Key Architecture Decisions

- Keep one shared `explorer` role.
- Preflight explorer remains strict and schema-validated in code via `runExplorerPreflight()`.
- Stations can use Flue `task` with `role: 'explorer'` for flexible bounded follow-up research.
- Keep dataset guidance in agent context, not in BigQuery helper enforcement.
- Preferred dataset guidance:
  - default: `evenup-bi.dbt_prod`
  - raw fallback: `evenup-bi.lops_sql`, `evenup-bi.prod_sow_alloy_sql`
  - use very sparingly: `evenup-bi.hightouch_destination`, `evenup-bi.prod_annotation_service_sql`
- Reuse existing `dbt-explorer-api` OAuth/token store rather than building a new local auth system.
- No nested explorer calls: runtime now blocks the explorer role from delegating through `task`.

## What Was Improved Recently

- Station harnesses now run with explicit roles.
- Analytics role was rewritten using dbt consultation workflow ideas from `dbt-explorer-api`.
- Explorer and knowledge roles were updated so Slack search hits plus permalinks count as valid evidence by default.
- Agents should no longer report Slack thread-depth/search truncation caveats unless they materially block the answer.
- Local token sync now falls back to the stored Google access token if refresh write-back to Firestore fails.
- Session collision mitigation is in place:
  - preflight uses a per-run session name
  - side-question/topic-switch stations use branch session names
  - session plan is returned in the agent response for debugging and client continuation
- `stream` was removed. FastAPI should invoke `waiter` for user-initiated messages.

## Current Known Gaps / Bugs

- Slack thread reading still uses bot-token path, while Slack search uses user-token path.
  - This can create mismatched access: search finds a thread, but full thread expansion may fail if the bot is not in the channel.
- Query interpretation for some analytics prompts is still too uncertain around business definitions.
  - Example: MDC “edit issues” needs stronger handling of proxy metrics and user-group identification.
- Local Google token refresh can read from Firestore but may fail to write back refreshed tokens due to local Firestore permissions.
  - Current workaround is acceptable for local dev, but not ideal.

## What Still Needs Work

- Validate session behavior through the FastAPI/web stream:
  - mainline continuation
  - `side_question` branch
  - `rework`
  - `topic_switch`
- Add clearer distinction in evidence handling between:
  - search hit found
  - full thread available
  - answer materially blocked
- Consider adding a user-token Slack thread reader for consistency with Slack search.
- Improve analytics station behavior around ambiguous business definitions:
  - what exactly counts as an event/action
  - how to identify user cohorts like EvenUp Ops
  - when to stop and ask a targeted clarification
- Add source-specific lazy references for explorer/stations if context size starts growing again.
  - likely shape: `references/explorer/{manifest,bigquery,kb,slack,drive,...}.md`
- Re-run and validate the Slack-heavy query that previously produced:
  - `"Slack channel access restrictions block full reading of longest SOW-related Slack threads."`
  after the Slack prompt change, using the original exact prompt.

## Local Dev Notes

- Local OAuth-backed Flue runs now depend on:
  - `SLACK_USER_TOKEN`
  - `GOOGLE_USER_ACCESS_TOKEN`
- Refresh/sync command:

```bash
npx pnpm@11.1.1 --dir examples/analytics run sync:oauth
```

- This script reads from the existing `dbt-explorer-api` token store for `DEV_IDENTITY_EMAIL`.

## Suggested Next Step

Fix the explorer session-collision bug first. It affects both preflight stability and station-side exploration, and it is a cleaner blocker than prompt tuning.
