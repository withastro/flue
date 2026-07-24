# Imported Skill Example

This example shows two supported contracts:

- `with-imported-skill` imports `src/skills/review/SKILL.md` with `{ type: 'skill' }`. The import is a lightweight `SkillReference`; the complete permitted skill directory, including `CHECKLIST.txt`, is packaged. Its files are readable during `session.skill(review)`, and during ordinary/session-by-name operations when the reference is registered in `skills: [review]`. Merely importing an unregistered reference does not expose its files to prompts.
- `with-custom-bash` imports `Bash` and `InMemoryFs` directly from `just-bash` to customize the virtual sandbox. Because application source imports it directly, `just-bash` is declared in this application's dependencies.

Both demos are agents whose deterministic bodies are model-callable actions. Run them one-shot with an Anthropic key:

```bash
pnpm exec flue run src/agents/with-imported-skill.ts --message "Run the review skill demo." --env ../../.env
pnpm exec flue run src/agents/with-custom-bash.ts --message "Run the custom bash demo." --env ../../.env
```

Or serve both over HTTP (they are mounted in `src/app.ts`):

```bash
pnpm exec vite dev
```
