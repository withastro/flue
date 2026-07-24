---
title: Durability
description: The accepted-work contract — what survives crashes, restarts, and redeploys, and how interrupted agent work recovers.
lastReviewedAt: 2026-07-21
---

Durability is Flue's contract for accepted work: once an input is admitted, the runtime owes that conversation a durable terminal outcome — through process crashes, restarts, and redeploys. Where that state is stored is the [Database](/docs/guide/database/) guide's topic. This guide covers submissions and the accepted-work contract, what recovery replays after an interruption, durable tools and delegated tasks, persisted state, per-target recovery behavior, and what is deliberately not durable.

## Submissions and the accepted-work contract

Every input that reaches an agent — a direct HTTP prompt, a [`dispatch(...)`](/docs/guide/building-agents/#dispatch) call, an [`init()` handle](/docs/reference/agent-api/#init)'s `dispatch(...)`, a [channel](/docs/guide/channels/) delivery, a [scheduled](/docs/guide/schedules/) trigger — is admitted as a **submission**: the payload is recorded durably _before_ any model work begins. That admission record is what the `202` response and the dispatch receipt attest to, and it carries an obligation:

> Every accepted submission reaches exactly one durable terminal outcome — `completed`, `failed`, or `aborted` — no matter how many crashes happen in between.

The outcome is written as a `submission_settled` record in the conversation's canonical stream, so anything waiting on the work observes it even across its own reconnects: the Flue Agent SDK's [`wait()`](/docs/sdk/flue-client/#wait) resolves or rejects from that record, and an awaited `init().read(...)` resolves with the settled reply or rejects with the settled error.

Submissions for one conversation form a durable queue processed in admission order: one submission runs at a time, messages that arrive while the agent is busy either join the live response at a turn boundary or wait their turn, and a queued message is never lost — a delivery that misses the live response runs as its own submission. Processing happens in **attempts**: a coordinator claims the submission, runs it, and settles it. An interruption consumes the attempt; recovery claims a new one, up to the [retry budget](#retry-budget-and-timeout).

Aborts follow the same discipline. `POST /:id/abort` (or the SDK's `abort()`) records a durable abort intent on every unsettled submission for the conversation; each one then settles with the distinct `aborted` outcome through the normal attempt machinery — even when the process that was running the work is already gone. Work that already completed is unaffected: an abort that arrives after a finished response settles `completed`.

## Recovery after an interruption

A crash leaves no record of itself — the dead process stops writing. Recovery runs when a replacement owner wakes ([how that happens is per-target](#recovery-by-target)) and works exclusively from durable evidence: the canonical conversation records, the submission's admission row, and its attempt bookkeeping.

Recovery proceeds in two phases. First it **converges** the stream: any partially streamed assistant output the dead attempt persisted is closed out as an aborted entry — unconditionally and idempotently, so no crash shape can leave the conversation looking mid-stream. The partial output stays preserved in history. Then it **classifies** what the records prove and continues from there:

| Durable evidence after the input                | What recovery does                                                                  |
| ----------------------------------------------- | ----------------------------------------------------------------------------------- |
| The input was never persisted                   | Requeues the submission for a clean first attempt.                                  |
| A completed assistant response                  | Settles `completed` — finished work is never discarded, even past the retry budget. |
| A partial response with text or reasoning       | Tells the model its stream was interrupted and continues from the durable partial.  |
| A tool turn with unresolved calls               | Repairs the tool batch (below), then continues the turn loop.                       |
| A transient provider error (rate limit, outage) | Retries the turn after a backoff, under a bounded error budget.                     |
| A context-overflow response                     | Compacts the conversation and retries the turn.                                     |
| A durable abort intent                          | Settles `aborted`.                                                                  |

Tool-batch repair is deliberately conservative. Results that were recorded before the crash are preserved exactly — those calls never run again. An unresolved ordinary call is _not_ re-executed, because the runtime cannot know which of its side effects already happened; instead it settles with an explicit unknown-outcome error that the model sees and can react to. Two kinds of calls resolve real outcomes instead of markers: [`durable: true` tools](#durable-tools-and-stepdo) re-execute with their completed steps replaying from records, and in-flight [delegated tasks](#delegated-tasks) resume from their own transcripts.

The overall discipline is **at-least-once execution over exactly-once recording**. Work that committed durably — recorded responses, recorded tool results, committed state writes — never re-runs. Work that was interrupted before committing re-runs on the next attempt, which includes your [event hook](/docs/guide/agent-hooks/#event-hooks) callbacks: their durable effects commit atomically and never duplicate, but an external side effect inside one (an email, a page) may rarely happen twice. Guard anything that must not repeat with [persistent state](#persisted-state) or application-level idempotency.

A recovered conversation always comes to rest in a state where the next message processes normally — an interrupted submission cannot wedge the queue behind it. The interruption stays visible in the timeline: the aborted partial, any interrupted-tool markers, and (on a failed settlement) a terminal advisory signal.

## Retry budget and timeout

Each interruption consumes one attempt. When a submission exhausts its attempts, or exceeds its wall-clock timeout, recovery stops retrying: the conversation is settled to a rest state, a `submission_interrupted` advisory lands in the timeline, and the submission settles `failed` — waiters reject with the structured error, including which tool calls were left with unknown outcomes.

The defaults are 10 attempts and one hour per submission. Override them per agent with the `durability` static:

```ts title="src/agents/issue-triage.ts"
'use agent';
import { useModel } from '@flue/runtime';

export function IssueTriage() {
  useModel('anthropic/claude-opus-4-6');
  return 'Triage the bound issue end-to-end.';
}

IssueTriage.durability = { maxAttempts: 5, timeoutMs: 7_200_000 };
```

The static is applied by the platform while the agent function is _not_ running, so it stays in force after a crash — including a crash in the agent's own render. The timeout is the total wall-clock budget from the first attempt's start; turn-boundary joins and response continuations do not extend it. Full field reference: [`DurabilityConfig`](/docs/reference/agent-api/#durabilityconfig).

## Durable tools and `step.do`

An ordinary tool call interrupted mid-flight settles with an unknown-outcome error on recovery. For work that must complete — a payment, a provisioning job, a multi-step sync — declare the tool `durable: true`: its `run` receives `step`, every side effect goes through `step.do(name, fn)`, and recovery re-executes the call instead of marking it interrupted:

```ts title="src/tools/provision-workspace.ts"
import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { billing, projects, DEFAULT_PROJECTS } from '../shared/provisioning.ts';

export const provisionWorkspace = defineTool({
  name: 'provision_workspace',
  description: 'Create the customer tenant, then seed each default project.',
  input: v.object({ customerId: v.string() }),
  durable: true,
  async run({ data, step }) {
    const tenant = await step.do('create-tenant', () => billing.createTenant(data.customerId));
    for (const project of DEFAULT_PROJECTS) {
      await step.do(`seed:${project.name}`, () => projects.seed(tenant.id, project));
    }
    return { tenantId: tenant.id };
  },
});
```

Each completed `step.do` durably records its returned value before resolving. On recovery the whole call re-runs, completed steps return their recorded values without executing, and execution continues from the first step that never finished. Step records are operational bookkeeping — the model sees only the tool's final result. They are keyed to the tool call id, so they carry across attempts of the same call — and are scoped to it, so a fresh invocation of the tool runs every step fresh.

Two boundaries of this contract:

- **Steps are exactly-once-recorded, at-least-once-executed.** A crash in the window between a step's function finishing and its record landing re-runs that one step, so steps around external effects should be individually idempotent.
- **A redeploy can withdraw the contract.** If recovery finds the current render no longer declares the tool — or no longer marks it `durable` — the call falls back to the ordinary interrupted-marker path rather than guessing.

The [Tools guide](/docs/guide/tools/#durable-tools) walks through writing durable tools; [`defineTool(...)`](/docs/reference/agent-api/#definetool) documents the full contract.

## Delegated tasks

A [subagent](/docs/guide/subagents/) task runs as a child session with its own durable conversation stream, so a crash mid-task loses none of the child's progress. When recovery repairs a tool batch containing an unresolved `task` call, it does not settle the call with a marker — it reattaches to the child's durable transcript, resumes the child to completion under the same recovery rules described above, and commits the child's real final result as the parent's tool outcome. This recurses: a child interrupted inside _its_ delegate resumes the grandchild first. Several tasks interrupted in one parallel batch are all resumed before the batch commits.

A delegate has no durability configuration of its own: resumed child work runs inside the parent's attempt, under the parent's retry budget and timeout.

Two edge cases:

- **A delegate removed by a redeploy.** If the subagent is no longer declared when recovery runs, that one call settles with an error outcome and the parent continues; a renamed or removed delegate cannot be resumed under any retry.
- **Terminal settlement.** When a submission exhausts its budget with a task still unresolved, the interrupted marker written for that call carries the child's conversation id, so the child's durable transcript remains inspectable.

## Persisted state

Every [`usePersistentState`](/docs/guide/agent-hooks/#persisted-state) write is a record in the conversation's canonical stream, which is why state survives restarts for the life of the conversation. Its recovery behavior follows from _when_ writes commit: a write becomes durable atomically with the unit of work that made it. A write from a tool commits with that turn's tool batch; a write from an event hook commits with the hook seam's checkpoint. If recovery settles the batch as interrupted, the write never happened — the re-attempt renders from the last committed state, exactly matching the work the model actually sees as done.

That atomicity is what makes persistent state the correct guard for at-least-once callbacks: a `sent` flag set by the same unit of work that sent the email cannot end up `true` while the work it guarded rolled back.

## Recovery by target

The durable records and the recovery decisions are identical on both targets. What differs is who owns a conversation's work and how a replacement owner wakes up.

### Node.js recovery

On Node, a coordinator inside your server process owns submission processing. Ownership is lease-based: each running submission carries a short lease that the owning process heartbeats while working. Recovery has two triggers:

- **Startup reconciliation.** A replacement process scans for interrupted work when it boots and requeues it, then begins serving immediately while that work settles in the background. Ordering is preserved per conversation — recovered work runs ahead of newly delivered work, so a restart never reorders a conversation's timeline.
- **Periodic lease scans.** While running, the coordinator scans for expired leases, so work stranded by a fast restart — where the new process boots before the old lease expires — is reclaimed within seconds rather than waiting for another restart.

Graceful shutdown aborts active submissions at the turn boundary and waits for them to settle; work that does not settle in time is left running with its lease intact, and the next startup reclaims it after expiry.

Two consequences for deployment:

- **Recovery is only as durable as the database.** With the in-memory default, accepted work survives interruptions within the process lifetime but a restart loses everything; cross-restart recovery requires a durable adapter in [`db.ts`](/docs/guide/database/).
- **One live owner per conversation.** A shared database lets a _replacement_ process recover accepted work, but it does not make two concurrent owners of the same conversation safe. Multi-replica deployments must route each conversation to one owner and avoid overlapping owners during replacement.

See the [Node.js target guide](/docs/guide/node-target/#state-and-durability) for the rest of the target's behavior.

### Cloudflare recovery

On Cloudflare, every agent conversation is a Durable Object with its own SQLite storage, so ownership is structural — the platform guarantees one live instance per conversation, and there is no lease protocol to operate. Recovery is wake-driven:

- **Wake on start.** Whenever the Durable Object starts — after an eviction, a code deploy, or a platform reset — Flue immediately flags any attempt that was running when the previous instance died and reconciles it before serving new work. The platform's fiber-recovery callback triggers the same reconciliation path.
- **A durable wake schedule.** While unsettled work exists, the object keeps a short self-renewing wake scheduled, so an interrupted submission recovers promptly even if no external request ever arrives to wake the object.

Abort intents, attempt bookkeeping, and settlement records all live in the object's own storage, so an abort requested while the object was evicted is honored on the next wake. See the [Cloudflare target guide](/docs/guide/cloudflare-target/#durable-agent-execution) for the target's execution model.

## What is deliberately not durable

### Keep workspace state separate

The conversation database does not store sandbox files. The [virtual sandbox](/docs/guide/sandboxes/#the-virtual-sandbox) is ephemeral by design — its filesystem is rebuilt fresh each time the runtime initializes the agent for new work, and a recovered attempt re-initializes the environment the same way, so files an interrupted attempt wrote to an ephemeral workspace are gone on resume.

Workspace persistence is a separate, independent choice from conversation persistence: a durable workspace comes from a [sandbox adapter](/docs/guide/sandboxes/#remote-sandboxes) that keys the provider workspace on the agent instance id, so every submission — including a recovery attempt — resolves back to the same filesystem. A durable database does not make a sandbox durable, and a durable workspace does not preserve conversation history. Keep knowledge the agent must not lose in [persistent state](#persisted-state); keep files that must last in a durable workspace.

### In-flight local promises

The promise returned by an awaited read — `init(...).read(...)` in a script, `client.wait(...)` in an application — is not itself durable. If the awaiting process exits, the accepted work continues under the configured store's recovery behavior; only the local promise is gone. To recover it, persist the `DispatchReceipt` that `dispatch(...)` resolved with — for example as a workflow step's durable result — and `read(receipt)` re-attaches from any process; if the submission already settled, it resolves immediately. For standalone scripts using [`start()`](/docs/guide/building-agents/#standalone-scripts), the `db` option decides whether accepted work outlives the script at all.

### Code outside the agent

Flue does not checkpoint arbitrary TypeScript execution and resume a function from its last completed line. The checkpoint boundary is the agent itself: _inside_ it, a [durable tool](#durable-tools-and-stepdo) gives application-controlled work resumable `step.do` checkpoints backed by the conversation's own durability. _Outside_ it — the endpoint, script, or cron job that drives the agent — use the workflow engine your platform provides (Cloudflare Workflows, Inngest, or plain re-runs) and treat Flue like any other service you call from it. Redelivering a message is a new submission in the conversation, and the durable record shows what the previous attempt completed. The [Workflows](/docs/guide/workflows/) guide shows these patterns.

### External side effects

Flue records that a tool ran and what it returned — never the effect itself. A payment API call, a row written to your application's database, a message posted to Slack: those live in your systems, outside the recovery model's reach. Recovery never blindly repeats uncertain effectful work, but at-least-once execution means an effect at the boundary can repeat; design external effects to be idempotent, key them on stable ids like `toolCallId` or `step.do` names, and guard one-shot actions with persistent state.

## Next steps

- [Database](/docs/guide/database/) — configure the durable store recovery depends on.
- [Tools](/docs/guide/tools/#durable-tools) — the durable-tool walkthrough and the full `step.do` rules.
- [Subagents](/docs/guide/subagents/) — delegated tasks and what a child session inherits.
- [Agent API](/docs/reference/agent-api/#durabilityconfig) — `DurabilityConfig`, agent statics, and the event-hook contracts.
- [Node.js](/docs/guide/node-target/) and [Cloudflare](/docs/guide/cloudflare-target/) — target-specific runtime behavior.
- [Observability](/docs/guide/observability/) — watch submissions, settlements, and recovery as they happen.
