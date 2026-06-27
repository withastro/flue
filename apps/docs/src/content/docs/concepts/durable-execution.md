---
title: Durable Agents
description: Understand how Flue agents and workflows handle server restarts, interrupted connections, and other disruptions.
lastReviewedAt: 2026-06-26
---

Durable execution is about recovering safely when running work is disrupted by a server restart, deployment, lost connection, or unexpected failure. Flue handles that recovery differently for continuing agents and finite workflows.

## Durable Agents

Agents are continuing, stateful contexts. Each persistent agent instance owns one canonical conversation stream. Sessions within the instance select conversations from that stream, and later operations rebuild model context from the same durable records that recovery and clients read.

Direct prompts and asynchronous `dispatch(...)` inputs are operations inside an agent instance. They are not workflow runs. For application-owned ingress such as webhooks or chat messages, see [Routing](/docs/guide/routing/).

```txt
agent input → canonical conversation stream → operation completes
                         ↓
later input → rebuilds context → continues the conversation
```

### Persist conversations

The canonical stream records model-visible messages, assistant output, tool calls and results, compaction, topology, and recovery facts. Attachment bytes live in a separate immutable attachment store and are referenced from canonical records. Mutable submission claims, leases, and turn journals remain operational state rather than a second transcript.

To persist this state in an application-controlled database, create a `src/db.ts` or `.flue/db.ts` file that default-exports a `PersistenceAdapter`. See [Database](/docs/guide/database/) for setup and [Data Persistence API](/docs/api/data-persistence-api/) for the storage contracts.

### Durable Agents on Cloudflare

Generated Cloudflare agents use one Durable Object per agent instance. Durable Object SQLite stores the canonical stream, attachment bytes, and accepted submissions. Direct HTTP prompts and asynchronous `dispatch(...)` inputs enter the same ordered queue.

```txt
direct HTTP prompt ─────────────────────┐
                                        ├→ durable queue → canonical stream
dispatch(...) input ────────────────────┘
```

The connection that submitted a prompt observes the work but does not own it. If the response closes after Cloudflare accepts the prompt, backend processing can continue. Clients can reconnect to the canonical agent stream from a durable offset.

After interruption, Flue compares canonical conversation progress with the operational turn journal. It recognizes already-completed output, retries only when it can prove the provider was not reached, and continues usable partial output from durable deltas. Completed tool results are reused. A tool call with no durable result is represented as interrupted with an unknown outcome rather than run again automatically.

This recovery is intentionally conservative because repeating model or tool activity can duplicate external effects. Use application-owned idempotency keys where repeated effects would be harmful. See [Deploy Agents on Cloudflare](/docs/ecosystem/deploy/cloudflare/) for platform configuration and migrations.

### Durable Agents on Node.js

Without `db.ts`, Node uses process-local in-memory SQLite. Restarting the process loses conversations, accepted submissions, and workflow records.

A durable adapter persists canonical conversations and submission coordination across process or host replacement. Startup reconciliation and periodic lease scans reclaim interrupted submissions using the same conservative recovery policy as Cloudflare. Node does not receive Durable Object wake or Fiber recovery, so a replacement process must start before recovery can continue.

Node requires **one live process to own a given agent instance**. A shared database supports restart or host-replacement recovery; it does not make active-active processing, round-robin routing, or concurrent ownership of the same instance safe. Deployments with multiple Node replicas must route each instance to one live owner and avoid overlapping owners during replacement.

On graceful shutdown, active submissions stop at a turn boundary and remain reclaimable. On restart, durable partial output and completed tool results are reused. A tool call that may have started without producing a durable result is not repeated automatically.

Waiting for `?wait=result` is best-effort and process-scoped. If that process disappears, observe the canonical conversation with `client.agents.observe()` to receive durable settlement. `history()` and `updates()` remain lower-level primitives for applications that manage their own materialized state.

A file-backed SQLite adapter protects against restart on the same host. Surviving host loss requires external durable storage such as Postgres, while still preserving the single-live-owner rule. See [Database](/docs/guide/database/) and [Deploy Agents on Node.js](/docs/ecosystem/deploy/node/).

### Cloudflare and Node recovery compared

| Failure case | Cloudflare | Node without `db.ts` | Node with durable `db.ts` |
| --- | --- | --- | --- |
| Process disappears during agent work | Durable Object storage retains accepted work and canonical records. | Process-local state is lost. | Durable stores retain work for replacement-process recovery. |
| Recovery trigger | Object startup, scheduled wake, and Fiber callbacks. | None after restart. | Replacement-process startup and periodic expired-lease scans. |
| Ownership | Durable Object routing provides one owner per instance. | One process-local owner. | One live Node owner per instance; shared storage supports replacement, not active-active ownership. |
| Interrupted workflow | Recovery terminalizes the run and closes its stream. | The run is lost with memory. | The stored run remains orphaned and active. |

### Keep workspace state separate

Persisting a conversation does not make sandbox files durable. The default virtual sandbox is an in-memory workspace, while a durable remote workspace does not preserve conversation records by itself. Choose workspace and conversation persistence independently. See [Sandboxes](/docs/guide/sandboxes/).

## Durable Workflows

Workflows are finite function invocations. Each invocation runs the authored `run(...)` function once, receives its own `runId`, and owns execution-scoped canonical conversation state for its harness and sessions. That state is not a persistent agent conversation shared with another workflow run. Flue does not checkpoint arbitrary TypeScript execution and resume the function from its last completed line.

On Cloudflare, recovery terminalizes an interrupted workflow run and closes its event stream. Node currently has no equivalent workflow recovery path. With a durable adapter, the run record and events survive, but an interrupted run remains listed as `active` and live readers wait indefinitely. Use `client.runs.events()` or a catch-up read to inspect events persisted before the crash.

### Retry workflows explicitly

Your application decides whether starting the workflow again is safe. A retry creates a new invocation rather than continuing the previous function call.

```txt
workflow invocation → run(...) → result or error

interrupted invocation
  └→ start a new invocation when retry is appropriate
```

Use application-owned idempotency keys around external effects whose earlier outcome may be unknown. If a job requires resumable checkpointed steps, use a durable orchestration system suited to that requirement.

### Inspect workflow runs

Use a workflow's `runId` to inspect its recorded outcome and events independently of the connection that started it. HTTP and SDK inspection requires the workflow to expose and authorize its run resources.

Agent prompts and dispatched inputs do not create workflow runs. See [Workflows](/docs/guide/workflows/) for workflow authoring and [Observability](/docs/guide/observability/) for runtime telemetry.
