# Flue

Framework where projects containing agents and workflows are compiled into deployable server artifacts.

## Terminology

```
Agent profile                 — one reusable `defineAgentProfile(...)` value
Agent definition              — one runtime initializer from `defineAgent(...)`
Agent module                  — `agents/<name>.ts`; default-exports an agent definition
└─ AgentInstance              — URL `<id>`; provided to `defineAgent(({ id }))`
   └─ Harness                 — runtime-initialized agent environment; defaults to name `"default"`
      └─ Session              — one `harness.session(name?)`; defaults to `"default"`
         └─ Operation        — one `session.prompt` / `skill` / `task` / `shell` call
            └─ Turn          — one LLM round-trip inside pi-agent-core
Workflow                     — `workflows/<name>.ts`; exports `run(...)`
└─ Workflow run/invocation    — unique `ctx.id === runId`; initializes local agent definitions via `init(agent)` when needed
```

Runs are workflow-only. Direct HTTP/WebSocket agent prompts and dispatched agent inputs operate within persistent sessions and must not be described as runs. `dispatch(...)` is identified by `dispatchId`; `/runs` and `flue logs` inspect workflow runs only.

Use `harness` as the variable name for the return value of `init()`. Agents have names; agent instances have ids; harnesses and sessions have names; operations have generated ids.

A blueprint is a Markdown implementation guide returned by `flue add`; its kind is `sandbox`, `database`, `channel`, or `tooling`. Use “sandbox adapter” for project-owned implementations and generated `src/sandboxes/` paths while preserving serialized/runtime API identifiers and Microsoft Bot Connector terminology.

## Project Structure

- `packages/runtime/` — Runtime library (`@flue/runtime`): sessions, agent harnesses, tools, and sandbox plumbing.
- `packages/cli/` — CLI and build/dev tooling (`@flue/cli`): Vite build graph, target integration, discovery, and configuration.
- `examples/hello-world/` — General runtime integration fixture.
- `examples/cloudflare/` — Cloudflare integration fixture.
- `examples/imported-skill/` — Packaged skill and release fixture.

Agent and workflow sources use either `<root>/.flue/` or `<root>/`; when `.flue/` exists, the bare `agents/` and `workflows/` layout is ignored.

## Development

Build runtime before CLI or examples:

```
pnpm run build          # in packages/runtime/
pnpm run build          # in packages/cli/
```

Type-check runtime changes with:

```
pnpm run check:types    # in packages/runtime/
```

When using `task` to delegate to subagents, you MUST include a notice that the subagent must not spawn its own subagents.

Treat `review` task feedback as input, not requirements. The primary agent is responsible for deciding whether to act: require a concrete correctness or durability risk within the user's requested scope, supported by a clear failure scenario or violated invariant and relevant `file:line` evidence. Do not accept a reviewer's severity label, proposed fix, or scope expansion at face value, and do not make changes solely to satisfy repeated reviews.

A single `review` task is enough review for most work. Additional reviews are allowed for complex work, but otherwise just spot-check your post-review fixes without doing an entirely fresh review. When performing additional reviews, remember that fresh subagents do not know prior findings/context outside of what the prompt includes; either restate each concern and the relevant expected behavior when asking for confirmation, or ask for an independent scoped review without implying it can confirm prior concerns.

When writing new plans to disk, write them to `plans/` (gitignored intentionally) with a `YYYY-MM-DD` filename prefix.

## Errors

Throw structured error classes from `packages/runtime/src/errors.ts` rather than ad-hoc `new Error('[flue] ...')`. If no existing class fits, add one following the structured-constructor pattern: machine-readable fields in `details`, developer-only guidance (filesystem paths, setup mechanics) in `dev` — never in the caller-visible message. Consumers distinguish failures via `instanceof` checks against exported classes and structured fields; error message strings are not API, and tests should assert on class and structured data rather than message text.

## Testing

Use `<package>/test/` for the intentional active suite and `<package>/test-legacy/` for archived tests. Do not add tests to `test-legacy/`, and do not use legacy tests as the source of truth when designing active coverage. Archived tests may remain wired to explicit integration scripts temporarily while equivalent intentional coverage is designed.

Design tests from observable contracts, not implementation structure. Prefer the highest practical public interface: user-facing behavior for public APIs and explicit consumer-facing behavior for stable internal subsystem boundaries. Do not test private helpers directly when their behavior is already exercised through a meaningful interface.

Do not add a regression test for every change. Before adding coverage, ask whether a reasonable suite designed from scratch would intentionally protect this behavior and whether the test is likely to catch a plausible future regression. Prefer tests for durable contracts and meaningful failure modes. Skip tests for incidental implementation details, rare edge cases, and fixes whose corrected form is already the natural result of the surrounding design. Every test makes a behavior harder to change before 1.0, so add one only when that constraint is valuable.

Use `describe('someFunction()')` or `describe('SomeManager')` for the subject under test. Nested `describe()` blocks may name methods or narrower interface states. Name every test with the explicit `it('X when Y')` format so the expected behavior and condition are clear. A reasonable internal refactor should not require test changes unless the observable contract changes.

Prefer explicit, self-contained `it()` blocks over deduplication. Copy-paste in tests is acceptable when it keeps each behavior readable in isolation and makes failures obvious. Avoid `it.each()` unless the cases are genuinely linear and remain clearer as a table. Avoid complex or nested helpers and dynamic test data flow.

Use small fixture helpers only for incidental plumbing that is not under test, such as creating a default environment or initializing a session harness. Do not introduce helpers merely to save a few repeated lines when they construct the subject under test, behavior-relevant inputs, or expected outputs. Keep those values inline in each `it()` block so a reviewer can understand the behavior without following indirection and later edits cannot silently change several tests at once.

Avoid extensive mocking, especially mocks of entire files, packages, or modules. Prefer testing through a real lightweight boundary, a small explicit fake for an injected interface, or a narrow transport fixture. If an existing design makes broad mocking unavoidable, treat that as a design smell: record the cleanup opportunity and document the temporary mock in the test.

When adding or redesigning coverage, create and review behavior stubs before implementing assertions. Do not map old tests one-for-one: retain only behaviors that protect an intentional contract. Do not add tests solely to preserve deprecated behavior, migration guidance, or backwards-compatibility shims unless explicitly requested.

Prefer changes that simplify the system over narrow patches that preserve accidental complexity. When fixing a bug or adding a feature, look for shared abstractions or obsolete branches that can be removed as part of the change, especially when this reduces distinct code paths or semantics. Do not expand into speculative redesign; call out meaningful user-facing behavior or migration tradeoffs before simplifying them away.
