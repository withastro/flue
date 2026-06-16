# Terminology

Use these names consistently. Do not rotate synonyms in implementation docs, tests, or generated code comments.

| Term | Meaning |
| --- | --- |
| Agent profile | One reusable `defineAgentProfile(...)` value. |
| Created agent | One runtime initializer returned from `createAgent(...)`. |
| Agent module | `agents/<name>.ts`; default-exports a created agent and may export `route`, `description`, or target extensions. |
| Agent instance | URL-selected `<id>` for one created agent; passed to `createAgent(({ id }))`. |
| Harness | Runtime-initialized agent environment returned by `init(agent)`. Use `harness` as the variable name. |
| Session | One `harness.session(name?)`; default name is `"default"`. |
| Operation | One `session.prompt`, `session.skill`, `session.task`, `session.shell`, or related bounded call. |
| Turn | One LLM round trip inside an operation. |
| Workflow | `workflows/<name>.ts`; exports `run(...)`. |
| Workflow run | One invocation of a workflow with `ctx.id === runId`. |

## Non-Negotiable Distinctions

- Runs are workflow-only.
- Direct HTTP/WebSocket prompts to an agent instance are operations in persistent sessions, not runs.
- `dispatch(...)` delivers asynchronous input to an agent session and is identified by `dispatchId`, not `runId`.
- `/runs`, `flue logs`, and SDK `client.runs.*` inspect workflow runs only.
- Agents have names; agent instances have IDs; harnesses and sessions have names; operations have generated IDs.
- A subagent is an agent profile used for delegated work, not a separately addressable agent endpoint.

## Preferred Wording

| Say | Avoid |
| --- | --- |
| "Initialize the agent and get a harness." | "Start a run for the agent." |
| "Dispatch input to the agent instance." | "Create a run from the webhook." |
| "Inspect the workflow run with `flue logs`." | "Inspect the prompt with `flue logs`." |
| "Open a session on the harness." | "Open an agent run session." |

