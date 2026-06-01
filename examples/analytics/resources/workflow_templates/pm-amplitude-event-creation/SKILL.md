---
name: pm-amplitude-event-creation
trigger: "pm-amplitude-event-creation"
description: |
  Only invoke this skill when the user types the exact phrase "pm-amplitude-event-creation".
  Do not invoke for general questions about Amplitude, tracking, analytics, or events.
---

# PM Amplitude Event Creation

**Interview instructions**: See `references/interview.md`
**Implementation patterns**: See `references/best-practices.md`
**Existing events inventory**: See `references/events-inventory.md`

---

## Full Workflow

### Codebase root
All codebase search and implementation work should be targeted at the
`lops-frontend` repo, not the analytics/dbt repo.

Resolution order:
1. Use an explicit repo path supplied by the orchestrator or user.
2. Use `LOPS_FRONTEND_PATH` if set.
3. In local Flue development, prefer `../lops-frontend` relative to the Flue repo root if it exists.
4. In deployed/stateless runs, clone or pull `https://github.com/evenup-ai/lops-frontend.git`
   into the controlled workflow workspace, then use that clone as the root.

Search narrowly first:
- Frontend SOW app: `apps/sow/src`
- SOW backend/service code: `services/sow/src`
- Task/event implementation should usually live under `apps/sow/src/features/...`

Use `rg` from the repo root for code search. Avoid broad whole-repo scans unless
the targeted SOW paths do not answer the question.

### Step 1 — Clone the repo
Clone the lops-frontend repo. The `git.py` helper from the app root injects `GITHUB_PAT` automatically:

```bash
# If running from dbt/ (API context), add parent to path first
export PYTHONPATH="../:$PYTHONPATH"

# Then clone using Python (git.py is one level up)
python -c "
import sys
sys.path.insert(0, '..')
from git import clone_repo, pull_repo
from pathlib import Path

repo_path = Path('lops-frontend')
if repo_path.exists():
    pull_repo(repo_path)
else:
    clone_repo('https://github.com/evenup-ai/lops-frontend.git', repo_path, branch='main')
"

cd lops-frontend
```

Required to search the codebase during the interview and implementation phases. Note the absolute path — all codebase searches and file edits in subsequent steps use this directory as the root.

### Step 2 — Refresh the events inventory
Check the last audited PR number from the Refresh Log in `references/events-inventory.md`, then scan merged PRs since then for new tracking:

```bash
# Get merged PRs since the last audited PR (run from inside lops-frontend)
gh pr list --state merged --base main --json number,title,files \
  | jq '.[] | select(.number > <last-pr-number>)'
```

For any PR in that range, check if it touches files containing `track(` or `amplitude`:
```bash
gh pr diff <pr-number> | grep -E '^\+.*track\(|^\+.*amplitude'
```

If new `track()` calls are found, add them to `references/events-inventory.md` before continuing.

If the event the PM wants already exists, stop here and tell them.

### Step 3 — Explore the codebase (automatic, before interview)
Before asking any interview questions, research the actual feature in the codebase to understand:
- Where the feature is implemented (which pages, components, screens)
- What UI elements exist (button labels, modal titles, form fields)
- What data is available on objects being tracked
- What backend operations occur

Document findings in plain language for the PM (no jargon). See `references/interview.md` → "Codebase Research" for detailed instructions. **Only propose options that exist in the code.**

### Step 4 — Run the interview
Run the interview defined in `references/interview.md`. Do not proceed until the EVENT BRIEF is complete and confirmed by the PM.

Key rules:
- Ask one topic at a time
- The baseline payload is always included — do not ask the PM about it
- For additional properties: propose a list based on codebase research findings, let the PM confirm or trim
- Ground all questions in what you found during codebase exploration — no guessing

### Step 5 — Create a Jira ticket
Call jira-automation-api to create a task in the DA project:

```bash
curl -X POST https://jira-automation-api.apps.evenup.law/create-ticket \
  -H "Content-Type: application/json" \
  -d '{
    "summary": "[Amplitude] <event name>",
    "description": "EVENT BRIEF from interview (above)",
    "project": "DA",
    "issue_type": "Task",
    "confirmed": true
  }'
```

Response will include `ticket_key` (e.g., `DA-1234`) and `ticket_url`.

**Use the ticket key in:** branch name and commit message — e.g., `DA-1234: [Amplitude] Task marked complete`

### Step 6 — Implement
Create a branch and implement the tracking inside `lops-frontend`:

1. Create branch: `git checkout -b <your-name>/amplitude-<event-slug>`
2. **Find the FE trigger** — use the user action + exact button label from the brief to locate the component. Trace: screen name → `apps/sow/src/pages/` → feature → button/mutation
3. **Check for an existing analytics file** — look for `<feature>.analytics.ts` next to the component; create one if absent following `references/best-practices.md`
4. **Implement** — add event to the typed union, add method to the hook, wire at the feature root, include baseline + extra props, respect exclusions
5. Commit: `git commit -m "<TICKET>: [Amplitude] <event name>"`

### Step 7 — Update the inventory and push
Return to the skill directory to update the inventory (it lives in the skill, not in lops-frontend):

```bash
cd ..  # back to dbt-explorer-api

# Update references/events-inventory.md from this directory:
# - Add the new event to the appropriate feature section
# - Update the Refresh Log table with today's date and the lops-frontend PR number
# (Do not push these changes — they're for the next skill run)

# Push the lops-frontend branch from there:
cd lops-frontend
git push -u origin <your-name>/amplitude-<event-slug>
```

### Step 8 — Open a PR

```bash
curl -s -X POST https://jira-automation-api.apps.evenup.law/create-pr \
  -H "Content-Type: application/json" \
  -d '{
    "repo": "evenup-ai/lops-frontend",
    "title": "<TICKET>: [Amplitude] <event name>",
    "head": "<your-name>/amplitude-<event-slug>",
    "body": "<EVENT BRIEF from interview above>"
  }'
```

---

## Tools

- **Codebase search**: Grep/Glob inside the `lops-frontend` directory cloned in Step 1
- **PR scan**: `gh pr list` + `gh pr diff` (run from inside `lops-frontend`)
- **BQ spot-check** (optional): `python /app/claude-copy/scripts/bq_explore/bq_explore.py "SELECT ..."` — only if you want to verify a new event is firing after the PR merges

---

## Troubleshooting

### Cannot create PR (GitHub blocks IP, permission denied, or network issues)

If `gh pr create` fails with a network or permission error, the branch has already been pushed. Share these links with an engineer:

- **JIRA ticket**: `https://jira.evenup.ai/browse/<TICKET>`
- **GitHub branch**: `https://github.com/evenup-ai/lops-frontend/tree/<branch-name>`

Engineer should:
1. Open the GitHub branch link
2. Click "Compare & pull request"
3. Use JIRA ticket title as PR title (e.g., `<TICKET>: [Amplitude] <event name>`)
4. Copy event brief from JIRA description into PR body
