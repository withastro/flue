---
name: dbt
description: |
  dbt project assistant for the EvenUp data warehouse.

  **ALWAYS INVOKE when Claude is activated in the dbt project directory OR <critical> tag is in the prompt**

  Use this skill for ANY work with any analytics task. Handles:
  (1) Building/modifying dbt models, tests, and .yml files (SQL development),
  (2) Answering data questions and drafting queries (ad hoc analysis — also /sql),
  (3) Creating product documentation in .claude/docs/knowledge_base/,
  (4) Building Metabase cards or custom reports (/metabase),
  (5) Searching and interacting with Google Drive (/gdrive),
  (6) Semantic search across Slack channels (/slack)

  Also invoke when the user sends /metabase, /gdrive, /slack, or /sql.
  Works with BigQuery and maintains SQL style guides.
---

# dbt Assistant

## General Agent Workflow

```
Step 1: DETERMINE MODE [MANDATORY]
    See Mode Selection table below and make a best guess user intention
    If unclear, ask user
    ↓
Step 2: RESEARCH AND CLARIFICATION
    See Core Principles #1: Multi-Source Research
    - Launch parallel searches
    - Ask clarifying questions in plain text if needed
    - Synthesize findings before proceeding
    ↓
Step 3: EXECUTE MODE-SPECIFIC WORKFLOW
    Follow the workflow in the loaded reference file
    ↓
Step 4: VALIDATE ASSUMPTIONS [MANDATORY WHEN SQL IS GENERATED]
    Challenge your work. Verify rather than assume.

    **Key validation checklist:**
    - Use bq_explore to verify query produces reasonable results; dry run if query exceeds 20GB
    - Column values: especially when a string value is used in sql `equal` or `like`, validate with bq_explore
    - Business logic: align with knowledge_base?

    Revise if issues found before presenting to user.
    Be honest with dbt-workflow-enforcer. If you have any doubt, lay it out; no answer is preferred over wrong answer
```

## Mode Selection

Determine which mode applies based on user intent:

| User Intent | Mode | Read This File |
|-------------|------|----------------|
| Build/modify/fix dbt models or .yml files | **Development** | `references/development.md` |
| Answer data questions, draft queries (read-only) | **Consultation** | `references/consultation.md` |
| Create product documentation in .claude/docs/knowledge_base/ | **Documentation** | `references/documentation.md` |

Then **read the appropriate references file** and follow its workflow.

## Core Principles (All Modes)

### 1. Multi-Source Research

**When questions involve models/tables/columns/business logic:**

1. Search `.claude/docs/knowledge_base/*.md` for business context
2. Use explore subagent to run `manifest_search.py` to find candidate models (see `references/manifest_search.md`)
3. Read `.sql` / `.yml` only if manifest output doesn't give enough detail

**Completeness check:**
- Knowledge base searched
- Manifest searched
- Synthesize findings before proceeding

### 2. Ask Questions Proactively

Never assume. When research exhausts uncertainty, ask the user for context instead of guessing.

### 3. Use tools
- `.claude/scripts/manifest_search/manifest_search.py` - Primary way to discover relevant models
- `.claude/scripts/bq_explore/` - BigQuery data exploration scripts
- `.claude/scripts/metabase/` - Metabase card creation and research (run `metabase-cli.py --help`)


## Resources
- `.claude/docs/knowledge_base/*.{md, qmd}` - Accumulated business logic and data knowledge
- `.claude/styleguide.md` - SQL style, naming conventions, layer decision tree
