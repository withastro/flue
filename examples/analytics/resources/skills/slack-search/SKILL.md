---
name: slack-search
trigger: "/slack"
description: |
  Semantic search across Slack channels with knowledge base context.

  Invoke when the user sends /slack or wants to search, find, or understand
  Slack conversations — regardless of exact phrasing.
---

# Slack Search

## Workflow

Step 1: UNDERSTAND THE QUERY
    Read .claude/docs/knowledge_base/ to resolve any domain terms in the
    user's query (product names, model names, acronyms, business concepts).
    Also run: python .claude/scripts/manifest_search/manifest_search.py search <keywords>

    This ensures the Slack search uses the right terminology and you can
    interpret results correctly.

Step 2: SEARCH SLACK
    python .claude/scripts/slack/slack_search.py "<query>" [--limit 10] [--after YYYY-MM-DD]

    If SLACK_USER_TOKEN is not set, stop and tell the user to connect
    their Slack account in the Resources tab.

Step 3: SYNTHESIZE
    Present what you found. Lead with Slack — that's what the user asked for.

    - Summarize key points from conversations, citing who said what and when
    - More recent messages carry more weight than older ones
    - Use your KB understanding to interpret the conversations correctly
    - If a Slack message contains a domain error (wrong terminology, confused
      concepts), flag it — don't propagate it

## Rules

- **KB informs, Slack answers.** The KB helps you understand the query and
  interpret results. Slack is the primary source the user is searching.
- **Slack first, KB fallback.** If Slack has a clear answer, lead with it.
  If Slack has partial or no coverage but the KB answers the question
  directly, use the KB answer. Don't leave the user empty-handed when
  the knowledge base has what they need.
- **Recency wins.** A message from yesterday outweighs one from 3 months ago.
- **Don't announce KB lookups.** The user asked to search Slack, not the KB.
  Use KB silently to be smarter about the search and interpretation.
- **Flag domain errors in Slack.** If someone in Slack confuses terms the KB
  defines clearly (plaintiff/defendant, model grain, product boundaries),
  note the discrepancy. Don't just repeat the error.
