# Support desk — the custom-hooks / state-machine model

This is the flagship example for Flue's **custom hooks** authoring model: an
agent as a plain function, composed from smaller hook functions, with a
durable phase recorded in `usePersistentState` — no workflow engine, no conditional
tool mounting.

## What it demonstrates

- **Everything is a hook.** `src/agents/support.ts`'s exported `Support`
  function is itself the agent — the `'use agent'` scan registers it, and its
  `useModel()` call gives it a model. `useGathering`, `useDrafting`,
  `useCommitting`, `useDone`, and `useRetention` are custom hooks it calls. Each is a plain sync function:
  `useTool()` calls in its body attach tools, and `useInstruction()` calls
  contribute its prose (the author formats headings and prose themselves).
- **All phases are always connected.** `useGathering(...)`, `useDrafting(...)`,
  `useCommitting(...)`, `useDone()`, and `useRetention(...)` all run on every
  render, unconditionally. Hook calls must never be conditional — the runtime
  enforces structural invariance across renders and fails the run if the
  mounted set changes. Nothing here "unlocks" a phase by mounting new tools;
  every tool exists for the agent's entire life.
- **Guards and trust replace tool mounting.** Instead of hiding
  `commit_approved_refund` until a "committing" phase begins, `useCommitting`
  mounts it always and wraps it with `guarded()` (`src/machine.ts`): the
  wrapped `run()` calls a `check()` prop first and returns a refusal string —
  which teaches, rather than a missing tool, which merely confuses — when the
  agent is in the wrong phase. The model is trusted to read the refusal and
  self-correct.
- **Transitions announce themselves via the transition tool's result.**
  `begin_draft`, `submit_for_execution`, and `complete` call
  `useMachine(...).enter(nextPhase)`, which writes the new phase and _returns_
  `You are now in the "drafting" phase.` as the tool's own result — the model
  reads its new phase from the tool outcome it just received, with zero
  framework support (this is pydantic's instructions-as-tool-result trick).
- **Durable phase and sentiment state via `usePersistentState`.** The current phase
  (`gathering` / `drafting` / `committing` / `done`) and the customer's
  sentiment (`neutral` / `churn-risk`) are both `usePersistentState` values: written by
  tool `run()` functions, persisted atomically with the tool call that wrote
  them, and read fresh — through freshly re-rendered closures — on every
  subsequent turn, including mid-run after a transition.
- **`useMachine` is userland, not framework.** `src/machine.ts` is a small
  hook built entirely out of public hooks (`usePersistentState`, `useInstruction`) —
  proof that authors can build their own conventions on top of custom hooks
  without needing anything from Flue itself. It stays out of `@flue/runtime`
  on purpose.

## Guided tour

- `src/agents/support.ts` — the `Support` agent. Read this first.
- `src/machine.ts` — `useMachine` (phase state + instruction) and `guarded`
  (wraps a tool with a phase check).
- `src/tools.ts` — demo domain tools (`draft_reply`, `draft_escalation`,
  `propose_refund`, `commit_approved_refund`, `send_reply`, `offer_credit`).
  Every `run()` is a stub: it returns descriptive text (`"Draft saved: ..."`)
  instead of touching a real ticketing or payments system.
- `src/app.ts` — mounts the agent at `/agents/support`.

## Running it

From the repository root, install workspace dependencies:

```bash
pnpm install
```

Set an API key — the agent calls `anthropic/claude-sonnet-5`:

```bash
export ANTHROPIC_API_KEY='<anthropic-api-key>'
```

From this example directory, start the Node dev server:

```bash
pnpm exec vite dev
```

Vite prints the local URL it serves (`http://localhost:5173` by default —
substitute yours below). Agent prompts are fire-and-forget: `POST` returns a
`202` admission, and a `GET` of the same URL streams the conversation.

```bash
curl -X POST 'http://localhost:5173/agents/support/case-1' \
  -H 'content-type: application/json' \
  -d '{"kind":"user","body":"Hi, my order #4821 never arrived and I am thinking about cancelling my subscription."}'
```

Build and typecheck without an API key:

```bash
pnpm run check:types
pnpm run build
```

## A note on tool-result formatting

Tool `run()` functions that return a plain string get JSON-serialized into
the outcome text, so `You are now in the "drafting" phase.` reads to the
model as `"You are now in the \"drafting\" phase."` — quoted. This is
acceptable today; it is flagged as a polish item for the framework, not
something this example works around.
