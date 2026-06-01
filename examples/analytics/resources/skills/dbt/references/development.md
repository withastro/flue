# Development Mode

SQL/dbt development work for building features, fixing bugs, and refactoring code.

Follow the Core Principles in SKILL.md and `.claude/styleguide.md` for all sql development work.

## Development Workflow

1. **Research Before Building** - Search for existing models before creating new ones
2. **Propose Plan** - Explain which models you'll create/modify and why, wait for approval
3. **Implement** - Write SQL following styleguide rules
4. **Documentation** - Propose accompanying .yml. Focus on:
    - Only include FACTS you are 100% sure of
    - Facts that will help future readers (LLM or human) understand the model
    - In key columns, add possible values to description using `.claude/scripts/bq_explore/bq_explore.py`
5. **Prompt Testing** - Ask developer to test with reconciliation if branch has model change.

**Important:** Do NOT run `git` commands

