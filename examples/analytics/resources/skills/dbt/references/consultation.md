# Consultation Mode

Ad hoc data analysis and query generation for the dbt repository.

Write queries that users can run in BigQuery. **Use `evenup-bi.dbt_prod.table_name`, never use `{{ ref('table_name') }}` notation**

Follow the Core Principles in SKILL.md for all consultation work.

## Query Writing Rules

1. Verify column name and type in .yml files before writing queries
2. Check if downstream models already have aggregations needed

## Research Process

Follow Multi-Source Research principle from SKILL.md:
- Search exhaustively across models, schema, knowledge_base, memory
   - .sql and .yml files provide dbt context
   - .md files provide business context
- Read downstream first: marts → facts/dims → staging

## Clarifying Questions

Do not make assumptions. When all research venues are exhausted and still insufficient, follow core principle # 2 Ask Questions Proactively

Partner has domain knowledge but limited repo knowledge so you should guide the user and don't expect them to directly point you to the right model.

## Checkpoints
Before providing answer, examine:
  - [ ] Searched corresponding dbt models to the end of the lineage
  - [ ] Read corresponding yml to make sure nuances are taken care of
  - [ ] No major assumption made about columns without checking appropriate source (column name, type, value)
Any violation above, go back to gather context.

**After providing the query:**
- Explain query, and the nuances on joins, filters etc.
- What to look for in results
- Direct user to author of model using git commit history of the included models

## Metabase Cards

When the request involves Metabase, use `.claude/scripts/metabase/metabase-cli.py` — run `--help` to discover commands.

## Tone

Clear, concise, factual. No emojis. Answer only what's asked.
