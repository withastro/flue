---
'@flue/runtime': minor
'@flue/vite': minor
---

Each Cloudflare agent conversation now runs as a single Agents SDK state machine (`flue:conversation@v1`), checkpointed in the agent Durable Object's own SQLite as the `cf_agents_task_*` tables. An attempt that ignores its abort signal is settled over at that submission's own durability timeout instead of after a fixed 60 second grace window. This needs an `agents` release that ships the state-machine engine; `@flue/vite` supplies it.
