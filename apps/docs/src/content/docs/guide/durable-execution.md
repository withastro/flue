---
title: Durable Execution
description: Understand how Flue agents and workflows handle server restarts, interrupted connections, and other disruptions.
---

Durable execution is about recovering safely when running work is disrupted by a server restart, deployment, lost connection, or unexpected failure. Flue handles that recovery differently for continuing agents and finite workflows.

## Durable Agents

Agents are continuing, stateful contexts. Each agent instance is a single conversation that records history so later operations can continue from where earlier work ended. The next message may arrive immediately or months later.

Direct prompts and asynchronous `dispatch(...)` inputs are operations inside the continuing agent instance. They are not workflow runs. When you need to send application-owned events such as webhooks or chat messages to an agent, see [Routing](/docs/guide/routing/) for application-owned ingress.

```txt
agent input → stored session history → operation completes
                     ↓
later input → reopens the same session → continues with earlier context
```

### Persist session history

A stored session includes messages and compacted context needed to reopen the conversation later. This makes the session history the durable record that lets an agent continue working after an earlier operation has finished.

To store session history in an application-controlled database, create a `src/db.ts` (or `.flue/db.ts`) file that default-exports a `PersistenceAdapter`. See [Database](/docs/guide/database/) for setup and [Data Persistence API](/docs/api/data-persistence-api/) for the public storage contract.

### Durable Agents on Cloudflare

On Cloudflare, generated Durable Object-backed agents store session history in SQLite by default. They also protect accepted agent input while it is being processed. Direct HTTP prompts and asynchronous `dispatch(...)` inputs enter the same durable queue. Inputs keep their accepted order.

```txt
direct HTTP prompt ─────────────────────┐
                                        ├→ durable per-instance queue → stored session history
dispatch(...) input ────────────────────┘
```

The connection that submitted a prompt observes the work but does not own it. If an HTTP response closes after Cloudflare accepts the prompt, the backend work can continue. Agent events are durably stored and can be replayed from any offset via the Durable Streams protocol.

When the Cloudflare runtime is interrupted, Flue checks the stored input and session history before deciding what to do next. It starts work again only when it can prove that the input was not applied. If a completed response was already stored, Flue recognizes that completion. When the outcome is uncertain, Flue records a visible interruption message in the session instead of blindly repeating model or tool activity.

This recovery is intentionally conservative. Once model or tool activity may have started, repeating it could duplicate external effects such as creating a ticket, posting a reply, or sending a payment request. Use application-owned idempotency keys where repeated effects would be harmful. For dispatched input, use `dispatchId` to correlate one accepted delivery with application records.

See [Deploy Agents on Cloudflare](/docs/ecosystem/deploy/cloudflare/) for Durable Object configuration, migrations, and platform-specific recovery details.

### Durable Agents on Node.js

On Node.js, sessions and accepted input live in process memory by default. Restarting the process loses all in-flight work and session history.

Both direct HTTP prompts and asynchronous `dispatch(...)` inputs go through the same ordered submission lifecycle with SQL admission, FIFO ordering, and journal tracking. Inputs keep their accepted order. The connection that submitted a direct prompt observes the work but does not own it — accepted backend work continues through the durable lifecycle regardless of transport state.

```txt
direct HTTP prompt ─────────────────────┐
                                        ├→ durable per-instance queue → stored session history
dispatch(...) input ────────────────────┘
```

Because the default backing store is in-memory SQLite, this lifecycle tracking protects against concurrent access within a running process but does not survive a restart. To persist session history and submission state across restarts, create a `src/db.ts` that exports a `PersistenceAdapter` such as `sqlite()` (file-backed) or `postgres()`.

With a durable adapter, Node can recover interrupted work with the same conservative reconciliation rules as Cloudflare: it requeues only when canonical input is provably absent, recognizes already-completed canonical output, and terminalizes uncertain work instead of replaying it blindly. Node does not get Cloudflare's automatic Durable Object wake and Fiber recovery. A replacement Node process must start successfully and run startup reconciliation before interrupted work is examined. The coordinator also scans for expired leases periodically, so submissions stranded by a fast restart are eventually reclaimed even if the replacement process started before the old lease expired.

On graceful shutdown (SIGINT/SIGTERM), active submissions are aborted at the turn boundary and left in a reclaimable state — they are not permanently settled. Their leases expire naturally and are reclaimed on next startup. Agent events are durably stored and can be replayed from any offset via the Durable Streams protocol after a restart.

A file-backed SQLite adapter protects against process restart on the same host; surviving host loss requires storage outside that host, such as Postgres or another durable shared database.

See [Database](/docs/guide/database/) for session persistence setup and [Deploy Agents on Node.js](/docs/ecosystem/deploy/node/) for deployment guidance.

### Cloudflare and Node recovery compared

A Cloudflare Durable Object reset and a Node server restart are not equivalent by default. Cloudflare stores accepted submissions in the owning Durable Object's SQLite queue, restores a wake, and reconciles interrupted work when the object resumes. Node gets comparable recovery after an application supplies durable storage via `db.ts`.

| Failure case                                                | Cloudflare                                                                                          | Node without `db.ts`                              | Node with durable `db.ts`                                                                                           |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Machine or runtime process disappears while work is running | Durable Object SQLite retains accepted direct and dispatched submissions.                           | In-memory session and submission state disappear. | Persisted session and submission rows remain available.                                                             |
| Interrupted dispatch input                                  | Reconciled after Durable Object recovery with conservative replay rules.                            | Lost with process memory.                         | Reconciled on replacement-process startup with the same shared replay rules.                                        |
| Interrupted direct HTTP prompt                              | Remains queued after admission; the transport may disconnect, but backend work is still reconciled. | Lost when the server process exits.               | Reconciled on replacement-process startup. The transport disconnects, but persisted submission state is recovered.  |
| Recovery trigger                                            | Durable Object startup, scheduled wake, and recovered Fiber callbacks.                              | None after restart.                               | Startup reconciliation when the new server begins listening, plus periodic expired-lease scans.                     |
| Multi-replica continuity                                    | Per-agent Durable Object ownership gives one durable queue per agent instance.                      | Process-local only.                               | Depends on the adapter and deployment topology; use a shared durable store when another host must recover the work. |

Both targets use the same reconciliation code and conservative replay rules for durable submissions. The remaining difference is recovery ownership: Cloudflare makes accepted work durable by default inside the owning Durable Object with automatic wake and Fiber recovery, while Node requires an explicit durable adapter and relies on process startup and periodic lease scanning for recovery. In both targets, a completed or uncertain model/tool action is never assumed safe to replay, so application-owned idempotency keys remain necessary for external effects.

### Keep workspace state separate

Persisting a conversation does not make sandbox files durable. The default virtual sandbox is an in-memory workspace, even when the session history is stored in a database. Likewise, a durable remote workspace does not preserve conversation history by itself.

Use the [Sandboxes](/docs/guide/sandboxes/) guide to choose a workspace lifecycle separately from session persistence. Keep durable application data, such as customer records or ticket state, in your own data layer.

## Durable Workflows

Workflows are finite function invocations. Each invocation runs your authored `run(...)` function once and receives its own `runId`. A workflow may load data, call external services, initialize agents, and return a result or error.

Flue workflows are not resumable. If a workflow is interrupted, Flue does not checkpoint arbitrary TypeScript execution and continue the function from the last completed line or step. Your application decides whether starting the workflow again is appropriate.

Interrupted-run cleanup differs by target. On Cloudflare, recovery terminalizes an interrupted run as errored — emitting `run_resume` then `run_end` — and closes its event stream so readers see the end of the stream. Node.js currently has no equivalent recovery path: runs do not survive a process restart, a run orphaned by a crash is never terminalized, and its event stream is never closed. Live readers of that run's stream (long-poll, SSE, or `flue logs -f`) wait indefinitely; use a catch-up read to inspect the events persisted before the crash.

### Retry workflows explicitly

Design workflows so they can be invoked again when retry is appropriate, much like CI jobs. Make repeated steps safe where practical, and use application-owned idempotency keys around external effects whose earlier outcome may be unknown.

Starting a workflow again creates a new invocation. It does not continue the previous function call.

```txt
workflow invocation → run(...) → result or error

interrupted invocation
  └→ start a new invocation when retry is appropriate
```

If a job requires checkpointed steps that resume automatically after disruption, use a durable orchestration system appropriate to your deployment.

### Inspect workflow runs

Use a workflow's `runId` to inspect its recorded outcome and events independently of the connection that started it. This is useful for debugging, live progress, and operational tooling.

Agent prompts and dispatched agent input do not create workflow runs. Use agent operation observation for continuing agents, and reserve workflow history and `flue logs` for workflow invocations. See [Workflows](/docs/guide/workflows/) for authoring and run inspection, and [Observability](/docs/guide/observability/) for runtime events and telemetry.
