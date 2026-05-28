# Analytics Flue Example

Local analytics self-serve agent for dbt manifest discovery, BigQuery exploration, and Metabase card workflows.

## Setup

```bash
cd examples/analytics
pnpm install
cp .env.secrets.example .env.secrets
```

`DBT_MANIFEST_PATH` defaults to `/Users/billgu/Workspace/dbt/target/manifest.json`.
Put provider keys and local overrides in `.env.secrets`; it is ignored by git.

The local dbt manifest can be compiled against a personal target schema such as
`dbt_bgu`. Before uploading it for the agent, run the local publish script; it
checks out `main`, pulls latest, compiles dbt, writes a normalized manifest with
EvenUp dbt schemas rewritten to `dbt_prod`, and uploads that normalized artifact
to GCS.

```bash
pnpm manifest:publish
```

By default this runs in `/Users/billgu/Workspace/dbt`, reads
`target/manifest.json`, writes `target/manifest.dbt_prod.json`, and uploads to
`gs://$GCS_BUCKET/dbt-explorer/manifest/manifest.json`. Override with
`--dbt-dir`, `--schema`, or `--gcs-uri`.

The Python script locations default to:

- `/Users/billgu/Workspace/evenup-internal-tools/apps/dbt-explorer-api/claude-copy/scripts/bq_explore/bq_explore.py`
- `/Users/billgu/Workspace/evenup-internal-tools/apps/dbt-explorer-api/claude-copy/scripts/metabase/metabase-cli.py`

Override them with `BQ_EXPLORE_SCRIPT` and `METABASE_CLI_SCRIPT`.

The model defaults to `openai/gpt-4.1-mini`. Override it with `ANALYTICS_MODEL`.

Persistence defaults are aligned to `dbt-explorer-api` local dev:

- `GCP_PROJECT=evenup-internal-tools`
- `FIRESTORE_DATABASE=dev-dbt-explorer-api`
- `GCS_BUCKET=evenup-internal-tools-dev-dbt-explorer-api`

In GKE, the internal-tools chart injects the production values from the app namespace. Set `FLUE_PERSISTENCE_MODE=local` to force local filesystem persistence under `/tmp/flue-analytics-persistence`.

Report workflows can draft files locally, edit them, then upload the final artifact:

- local drafts default to `/tmp/flue-analytics-reports` or `FLUE_REPORT_WORK_DIR`
- `report_local_write` creates a bounded draft file
- `report_local_edit` applies exact string edits
- `report_artifact_upload` uploads to `report-files/...` and returns the existing report viewer URL

Personal context and skills use the existing `dbt-explorer-api` Firestore layout:

- `users/{email}.preferences`
- `users/{email}/skills/{skillId}`
- `users/{email}/reports/{reportId}`

Model selection precedence:

1. Payload `model`
2. `ANALYTICS_MODEL`
3. `openai/gpt-4.1-mini`

Examples:

```bash
node ../../packages/cli/bin/flue.mjs run analytics --target node --id local \
  --env .env.secrets \
  --payload '{"message":"Find the best model for case volume by month","model":"openai/gpt-4.1-mini"}'
```

```bash
node ../../packages/cli/bin/flue.mjs run analytics --target node --id local \
  --env .env.secrets \
  --payload '{"message":"Find the best model for case volume by month","model":"anthropic/claude-haiku-4-5"}'
```

## Run

Direct analytics kitchen station:

```bash
node ../../packages/cli/bin/flue.mjs run analytics --target node --id local \
  --env .env.secrets \
  --payload '{"message":"Find the best model for case volume by month"}'
```

Explorer kitchen station:

```bash
node ../../packages/cli/bin/flue.mjs run explorer --target node --id local \
  --env .env.secrets \
  --payload '{"query":"Find dbt models related to case volume by month"}'
```

Waiter-orchestrated flow:

```bash
node ../../packages/cli/bin/flue.mjs run waiter --target node --id local \
  --env .env.secrets \
  --payload '{"message":"Find the best model for case volume by month"}'
```

Omnipotent dbt-explorer flow:

```bash
node ../../packages/cli/bin/flue.mjs run dbt-explorer --target node --id local \
  --env .env.secrets \
  --payload '{"message":"Find the best model for case volume by month","model":"openai/gpt-5.4"}'
```

Allow card creation only when you explicitly want it:

```bash
node ../../packages/cli/bin/flue.mjs run analytics --target node --id local \
  --env .env.secrets \
  --payload '{"message":"Create a Metabase line chart for monthly case volume","allowMetabaseCreate":true}'
```
