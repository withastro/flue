---
name: report-uploader
description: |
  Uploads an HTML report file to GCS and returns a shareable link into the
  Reports tab of the dbt Explorer web UI.

  Use this skill whenever a report needs to be uploaded and shared — whether
  triggered by another reporting skill or directly by a user asking to upload
  and share a report file. Covers both "upload this for me" and end-of-workflow
  upload steps.
---

# Report Uploader

## Inputs

- `local_path` — absolute path to the HTML file (e.g. `/tmp/ai_playbooks_report_20260406.html`)
- `gcs_path` — full path within the bucket, defined by the calling skill (e.g. `ai_playbooks/2026-04-06/ai_playbooks_report_20260406.html`)
- `display_name` — human-readable link label (e.g. `AI Playbooks Report – Apr 6, 2026`); if not provided, use the filename as the label

## Workflow

```
Step 1: UPLOAD
    gsutil -o GSUtil:default_project_id=evenup-internal-tools cp \
      {local_path} \
      gs://evenup-internal-tools-dbt-explorer-api/report-files/{gcs_path}

    If gsutil exits with an error, print the error message and stop.
    Do not generate a link for a failed upload.

Step 2: CONSTRUCT LINK

    public_url = https://dbt-explorer-api.apps.evenup.law/reports/doc/{gcs_path with .html extension stripped}

    This hits the backend directly and renders the report HTML/ipynb inline.
    No SPA wrapper needed.

Step 3: PRINT LINK (format depends on $ENV)

    Read the ENV environment variable and format accordingly:

      ENV=SLACK → Slack mrkdwn: <{public_url}|{display_name}>
      ENV=WEB or ENV=TERMINAL or unset → standard markdown: [{display_name}]({public_url})

    Print the formatted string inline in your response — the caller's
    interface (Slack mrkdwn renderer, react-markdown, or terminal) renders
    it natively.
```

## Rules

- `gcs_path` is fully determined by the calling skill — this skill does not impose any folder convention.
- Link format is `$ENV`-dependent (see Step 3). Do not hardcode one format.
