---
name: eng-history
trigger: "/history"
description: |
  Answer engineering-context questions about what's changed in a repo, product, squad, or feature. Covers recent merged GitHub PRs AND resolved Jira tickets by delegating to the jira-automation-api service.

  Use this skill whenever the user adds the <ENG_HISTORY> tag to their question — including questions about what shipped, what changed, which tickets were resolved, which PRs merged, what a squad has been working on, or when tracing a behavior change (more errors, more issues flagged, perf regression) back to a code or process cause.

  This is the ONLY way to pull GitHub or Jira context into dbt-explorer answers. The bot has no local git or Atlassian access. Always prefer this skill over guessing from model knowledge when the user asks about repo / product / squad / ticket activity.
---

# Engineering History

## When to invoke

Trigger only when the user's message contains the literal tag `<ENG_HISTORY>`. The tag is deliberate — without it, "what changed" questions belong to dbt model context, not engineering history.

## Why this skill exists

The dbt-explorer bot has no direct GitHub PAT or Jira credentials, and no local clones of non-dbt repos. It delegates to the `jira-automation-api` service, which:

- Holds the GitHub PAT and Jira API credentials.
- Exposes a self-describing REST API (discoverable via `GET /`, `GET /openapi.json`, `GET /tools/<group>`).
- Maintains the canonical product/squad → repos + Jira projects mapping.
- Answers natural-language questions over PR and Jira histories.

**Treat `jira-automation-api` as a black box.** Always hit the live endpoints. Never read its source files — they drift from the running service.

## Discovery first

Before doing anything clever, the authoritative contract is the running API. Three endpoints describe it:

- `GET /` — capability groups (ticket / query / knowledge, plus any future groups).
- `GET /openapi.json` — full request/response schemas.
- `GET /tools/<group>` — MCP-style tool catalogs where applicable (currently just `/tools/knowledge`).

If the user's request doesn't fit the wrappers bundled with this skill, re-discover via `curl` and call the endpoint directly. The API evolves — new capabilities (e.g. PR diffs, ticket detail, commit graphs) may appear. Don't assume the wrappers are exhaustive.

## Capability groups currently bundled as wrappers

| Wrapper | API endpoint | Purpose |
|---|---|---|
| `scripts/jira_automation/taxonomy.py` | `GET /knowledge/taxonomy` | List all known product tags, squad slugs, and Jira project keys. |
| `scripts/jira_automation/scope.py` | `GET /knowledge/{product\|squad}-scope` | Resolve a product or squad → GitHub repos + Jira projects. |
| `scripts/jira_automation/query.py` | `POST /query` | Natural-language Q&A over PRs and Jira tickets. |
| _(none — call directly)_ | `POST /create-pr` | Create a GitHub PR. Body: `repo` (org/repo), `title`, `head` (source branch), `body`, `base` (default `main`), `draft`, `labels`. Returns `number`, `url`, `html_url`. |

`/create-ticket` exists but is out of scope for this skill.

## Inputs to extract from the user's message

- **question** (required).
- **subject** (one of, if present):
  - **product tag** (e.g. `mdc`, `ai_playbooks`) → use `scope.py --product`.
  - **squad slug** (e.g. `doc-gen`, `ai-platform`) → use `scope.py --squad`.
  - **repo name** (e.g. `lops-backend`, `dbt`) → skip scope; pass directly as `--repo`.
  - *none explicit* → pass the question straight through; the endpoint's LLM does fuzzy matching against the GitHub org.
- **source**: pick explicitly based on wording.
  - "PRs", "merged", "shipped in code", "model/prompt change" → `--source pr`
  - "Jira tickets", "tickets resolved", "issues closed", "what did the team agree" → `--source jira`
  - "everything about X", cross-referencing → `--source both`
  - genuinely unclear → `--source auto` (but this is a last resort; explicit routing is more reliable).
- **timeframe**: translate natural language to ISO `start_date` / `end_date`:
  - *"last week"* → compute 7 days back; `--start-date <that date>`; omit `--end-date`.
  - *"first 2 weeks of March 2026"* → `--start-date 2026-03-01 --end-date 2026-03-14`.
  - *"since February"* → `--start-date 2026-02-01`; omit `--end-date`.

## Workflow

### Step 1 — Resolve scope (only if the subject is a product or squad)

```bash
python .claude/scripts/jira_automation/scope.py --product <tag>
# or
python .claude/scripts/jira_automation/scope.py --squad <slug>
```

Returns JSON:
```
{
  "github_repos": ["evenup-ai/..."],
  "jira_projects": ["KEY1", "KEY2", ...],
  "cross_cutting_jira_projects": ["TRI", "VUL"]   # products only
}
```

How to use the result:

- **Pick one repo** from `github_repos` for `--repo`. For model / logic / prompt questions, pick the backend repo. For UI / UX questions, pick the frontend.
- **Enrich the question text** with `(Jira projects: KEY1, KEY2, KEY3)` when `--source jira` or `both`. The server's LLM uses this to build a proper JQL `project in (...)` clause. Ambiguous acronyms especially benefit — see Pitfalls.
- **Include `cross_cutting_jira_projects`** only when the question is about security or triage flow.

If the product / squad name is unknown or ambiguous:

```bash
python .claude/scripts/jira_automation/taxonomy.py
```

Then ask the user to pick. `scope.py` also returns a `known_products` list in its 404 body — surface that.

### Step 2 — Query

```bash
python .claude/scripts/jira_automation/query.py \
  --question "<question, optionally enriched with Jira project keys>" \
  --source pr|jira|both|auto \
  [--repo <repo>] \
  [--start-date YYYY-MM-DD] \
  [--end-date YYYY-MM-DD] \
  [--limit <N>]
```

Default `--limit` is 50 (server cap: 200). Default source is `auto`.

### Step 3 — Render for Slack

Return the answer using the Slack mrkdwn conventions in `CLAUDE.md`. Preserve PR and Jira URLs as clickable markdown links.

## Handling thin or truncated results

If the answer is brief, misses the window, or says `truncated: true`, iterate rather than accepting the first pass:

1. **Narrow the date window** — tighter dates remove noise and let the server reach further back without saturating.
2. **Bump `--limit`** — up to 200.
3. **Switch source** — `pr` found nothing relevant? Try `jira` (ticket history often explains *why* something shipped). And vice versa.
4. **Re-run with `--json`** — exposes `prs[]`, `jira_issues[]` structured data, the exact `jql` the server used, and the `truncated` flag. Invaluable when the natural-language summary looks off and you need to see what the endpoint actually searched.

## Deep dives

The `/query` answer is a summary. When the user needs more (what specific lines changed, what the ticket's comment thread discussed, linked subtasks, commit graphs, etc.):

1. **Re-discover the API first.** `curl https://jira-automation-api.apps.evenup.law/` and check `/openapi.json`. New deep-dive endpoints (PR diff, ticket detail, etc.) may now exist that weren't here when this skill was last updated.
2. **If a relevant endpoint exists, call it directly** (via `curl` embedded in a short Bash block, or add a wrapper to `scripts/jira_automation/` if you're doing this repeatedly).
3. **If no endpoint exists, report the summary** to the user and flag that a deeper view would require adding the capability to `jira-automation-api`. Do not bypass that service to call GitHub or Atlassian directly — this skill is intentionally thin.

This forward-looking posture matters because the service owner is iterating the API precisely so consumers stay lean.

## Common pitfalls

- **Ambiguous acronyms** — e.g. "MDC" = *Missing Document Check* in this org; = *Mapped Diagnostic Context* in Java logging. The server's LLM sometimes expands incorrectly. Always pass project keys from `scope.py` in the question text when the subject is an acronym or a non-obvious product name.
- **Relative dates in the payload** — the API expects ISO absolute dates. Always translate "last week", "March", etc. before calling.
- **Missing date window on busy repos** — omitting `start_date` / `end_date` lets the server pick a default that can saturate on high-velocity repos (e.g. `lops-backend` merges ~8 PRs/day). Always pass explicit dates when reaching back more than ~1 week.
- **Assuming the schema is stable** — the running API is the source of truth. If a call returns an unexpected shape, re-fetch `GET /openapi.json` before patching code around the old shape.
- **Stale worktree source** — files under `apps/jira-automation-api/` in any local checkout are NOT authoritative. They will drift. Always query the running service.

## Error handling

- Any wrapper script exits non-zero → surface stderr to the user verbatim, do not retry silently, do not invent a fix.
- 404 from `scope.py` → run `taxonomy.py`, show the user the valid list, ask them to pick.
- 4xx / 5xx from `/query` → surface the error, stop. If the service is mid-deploy, a short wait and retry may be warranted — but get the user's ack first.
