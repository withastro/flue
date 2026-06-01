---
name: learnthis
description: |
  Saves a fact, rule, or preference to the current user's personal context so
  future conversations remember it. Writes directly to the user's preferences
  in Firestore — no branch, no PR, no repo edits.

  **ALWAYS INVOKE when:**
  - The `<learnthis>` tag appears anywhere in the conversation
  - The user says something like "remember that…", "from now on…", "don't forget…"

  Do NOT trigger on questions about dbt or data that don't involve saving
  something. Do NOT use this skill to edit dbt models, schema .yml, the
  knowledge base, or any other repo file — those still go through a normal PR
  flow.
---

# learnthis — Save to Personal Context

The current user has a personal context (the **Context** tab in the web UI,
backed by Firestore `users/{email}.preferences`). Every entry is injected into
your prompt as `## User context` on the next conversation. Use this skill to
add or update one entry.

## Step 1 — Decide what to save

Capture only things that will be useful in *future* conversations. Each entry
should be:

- **Atomic and durable**: one fact, rule, or convention. Not a long story.
- **About the user or their domain**: their products, business rules, data
  quirks, preferred query patterns, terminology.
- **Plain English** a new analyst would understand.

Skip:

- One-off query parameters that won't apply next time
- Restatements of what the SQL or manifest already says
- Things already in the project knowledge base

> **⚠️ PHI PROHIBITION**
> Never store PHI (patient names, claim IDs, case IDs, diagnosis codes,
> injury details, medical records, settlement amounts tied to individuals,
> attorney names paired with case details). Generalize all examples with
> anonymized placeholders (`<case_id>`, `<claimant>`).

## Step 2 — Pick a key

A short slug, lowercase letters/digits/underscores only. Choose by topic so
related facts append to the same entry over time.

Examples: `mdc_business_rules`, `revops_terminology`, `my_team`,
`preferred_query_style`, `commercial_support_quirks`.

If the topic already exists in `## User context`, reuse the same key and
include the prior content with your addition — saving replaces the value, so
read-modify-write keeps history.

## Step 3 — Save it

Always pipe the value through stdin with a `'EOF'` (quoted) heredoc. This is
the only supported form — never use `--value "<text>"` inline, because the
shell will expand `$`, backticks, and unescaped quotes in the user's content
*before* `save.py` sees it, corrupting the saved entry.

```bash
cat <<'EOF' | python .claude/scripts/personal_context/save.py --key <slug> --value -
<the full content for this entry>
EOF
```

The script reads `$USER_ID` from the environment (the agent runtime sets it)
and writes to Firestore. It exits 0 on success and prints a one-line
confirmation.

## Step 4 — Tell the user what was saved

Keep it short:

```
Saved to your personal context as **<slug>**:
> <one-line summary of what's now stored>

You can edit or remove this on the Context tab.
```

## Quality bar

Good entry:
- A single atomic fact or rule
- Phrased so the agent can act on it without re-reading this conversation
- Generalizes beyond this one question

Bad entry:
- "User asked about X" (not actionable)
- "The SQL returned 0 rows" (one-off, not durable)
- A long narrative — keep it to the rule itself plus one line of why
