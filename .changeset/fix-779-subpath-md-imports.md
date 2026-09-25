---
'@flue/vite': patch
---

Markdown and skill imports written as Node subpath imports (package.json `imports`, e.g. `import core from '#src/prompts/core.md'`) now transform like relative and package specifiers in both dev and production builds: `.md` imports load as markdown text and `SKILL.md` imports package the skill directory. Previously the leading `#` was mistaken for a fragment marker, the import was left untransformed, and Vite tried to parse the Markdown file as JavaScript. Queried forms (`?raw`, `?url`, ...) continue to be delegated to Vite.
