---
title: Schedules
description: Deliver input to your agents on a cron schedule, on Node.js and Cloudflare.
lastReviewedAt: 2026-07-21
---

A schedule delivers agent input at a fixed cadence: a cron trigger fires, and your code calls [`dispatch(...)`](/docs/guide/building-agents/#dispatch) with a message for an agent conversation. Flue has no scheduler of its own — each target pairs its cron mechanism with the same dispatch surface every other delivery uses. This guide covers declaring a schedule on Node.js and Cloudflare, the message a fire delivers, choosing the conversation id, awaiting a run's result, and the operational behavior around missed fires, overlap, and durability.

## How a schedule works

A schedule has three parts:

1. **A trigger.** On Node.js, an in-process cron library in `app.ts`; on Cloudflare, a Worker Cron Trigger; on managed platforms, the platform's own cron service calling your HTTP surface.
2. **A delivery.** The trigger's callback calls `dispatch(agent, { id, message })`. Dispatch resolves when the message is durably admitted to the conversation's queue — it does not wait for the model to run. Because dispatch addresses the registered agent function directly, a scheduled agent needs no HTTP mount at all (see [Dispatch-only agents](/docs/guide/routing/#dispatch-only-agents)).
3. **A conversation.** The `id` you pass names the conversation that receives every fire. Whether that is one continuing conversation or a fresh one per run is a design choice covered [below](#choosing-the-conversation-id).

The agent itself is ordinary — nothing in the agent function marks it as scheduled:

```ts title="src/agents/reporter.ts"
'use agent';
import { useModel } from '@flue/runtime';

export function Reporter() {
  useModel('anthropic/claude-sonnet-4-6');
  return 'Complete scheduled tasks autonomously.';
}
```

When the scheduled work involves application-controlled steps — reading a data source, writing a report, calling an external API — put those steps behind a [harness tool](/docs/guide/tools/#harness-tools) so they behave the same way on every fire.

## Scheduling on Node.js

On the Node target, the server process is long-lived, so an in-process cron library in `app.ts` module scope is the simplest trigger. The [`croner`](https://www.npmjs.com/package/croner) package is what Flue's own example uses:

```ts title="src/app.ts"
import { dispatch } from '@flue/runtime';
import { Cron } from 'croner';
import { Hono } from 'hono';
import { Reporter } from './agents/reporter.ts';

const app = new Hono();

new Cron(
  '0 9 * * *',
  {
    timezone: 'America/New_York',
    protect: true,
    catch: (error) => console.error('Scheduled dispatch failed', error),
  },
  async () => {
    await dispatch(Reporter, {
      id: 'daily-summary',
      message: {
        kind: 'signal',
        type: 'schedule',
        body: 'Review recent activity and prepare the daily summary.',
        attributes: { scheduledAt: new Date().toISOString() },
      },
    });
  },
);

export default app;
```

The `Cron` instance is created when the module loads, so the schedule starts with the server — `node dist/server.mjs` in production and `vite dev` during development. Because it also fires under `vite dev`, gate construction on an environment variable when development fires are unwanted. An in-process schedule also runs in every replica of the server: past one instance, gate the trigger to a single replica or move it to a platform scheduler.

Cadence and timezone belong to the cron library: croner takes a standard five-field cron pattern (with an optional seconds field), an IANA `timezone` option, `protect: true` to skip a fire while the previous callback is still running, and a `catch` handler for callback errors. Any in-process scheduler works the same way — the only Flue-specific part is the `dispatch(...)` call.

A runnable version of this pattern is available in [`examples/node-schedules`](https://github.com/withastro/flue/tree/main/examples/node-schedules).

## Scheduling on Cloudflare

On the Cloudflare target, the Worker is not a long-lived process, so the platform owns the trigger. Declare the cadence as a [Cron Trigger](https://developers.cloudflare.com/workers/configuration/cron-triggers/) in `wrangler.jsonc`:

```jsonc title="wrangler.jsonc"
{
  "triggers": {
    "crons": ["0 9 * * *"],
  },
}
```

Cloudflare evaluates cron expressions in **UTC**; there is no timezone option.

The fire arrives as a Worker [`scheduled` event](https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/). Contribute the handler from the default export of [`src/cloudflare.ts`](/docs/guide/cloudflare-target/#extending-cloudflarets-entrypoint) — Flue merges it into the generated Worker entry — and call `dispatch(...)` inside it:

```ts title="src/cloudflare.ts"
import { dispatch } from '@flue/runtime';
import { Reporter } from './agents/reporter.ts';

export default {
  async scheduled(controller) {
    await dispatch(Reporter, {
      id: 'daily-summary',
      message: {
        kind: 'signal',
        type: 'schedule',
        body: 'Review recent activity and prepare the daily summary.',
        attributes: {
          cron: controller.cron,
          scheduledAt: new Date(controller.scheduledTime).toISOString(),
        },
      },
    });
  },
};
```

`dispatch(...)` works in a `scheduled` handler exactly as it does in an HTTP route: it needs no mount, bypasses HTTP middleware, and durably admits the message to the agent's Durable Object before resolving. A Worker has one `scheduled` handler; when `crons` lists several patterns, `controller.cron` identifies which one fired.

For a schedule that belongs to one _existing_ conversation rather than to the application — a follow-up timer inside a running agent's Durable Object — the Agents SDK `schedule()`/`scheduleEvery()` APIs are available through the per-module `extend()` extension point instead. See [Extending Agents on Cloudflare](/docs/guide/cloudflare-target/#extending-agents-on-cloudflare). Those callbacks share the conversation's Durable Object with agent execution, so one that comes due while a response is running fires after it settles. A Cron Trigger is the right tool when the schedule must address or create conversations from outside — it runs in the Worker, independent of any conversation's activity.

## What a fire delivers

A scheduled fire is a structured event, so deliver it as a `kind: 'signal'` message: a caller-defined `type`, the instruction in `body`, and flat string metadata in `attributes`. The signal renders into the model conversation as an XML-tagged block:

```
<signal type="schedule" scheduledAt="2026-07-17T13:00:00.000Z">
Review recent activity and prepare the daily summary.
</signal>
```

Hooks and tools read the same delivery in code with [`useDelivery()`](/docs/reference/agent-hooks-api/#usedelivery), so a tool can consume `attributes` values directly instead of relying on the model to echo them. The full message shape, including the `tagName` override, is documented at [`DeliveredMessage`](/docs/reference/agent-api/#deliveredmessage).

## Choosing the conversation id

The `id` decides what a fire means to the agent:

| Id choice                           | Behavior                                                                                                                                                                   |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fixed (`'daily-summary'`)           | Every fire continues one conversation. The agent sees its previous runs and keeps [persistent state](/docs/guide/agent-hooks/#persisted-state) across them.                |
| Per fire (`` `daily-${isoDate}` ``) | Each fire creates a fresh conversation with bounded context. Pair with `initialData` to seed the new instance; see [`dispatch(...)`](/docs/reference/agent-api/#dispatch). |

A fixed id suits recurring work that builds on its own history — the agent can compare today against yesterday without re-fetching it. Per-fire ids suit independent runs where an ever-growing transcript is a cost, and they leave each run individually inspectable.

## Awaiting a scheduled run

`dispatch(...)` is fire-and-forget. When the schedule needs the run's result — to post a summary to Slack, for example — use the [`init()` handle](/docs/reference/agent-api/#init): `dispatch()` admits the message and resolves with a receipt, and `read()` awaits the settled reply. It works inside a cron callback in `app.ts` and in a `scheduled` handler alike:

```ts
import { init } from '@flue/runtime';
import { Reporter } from './agents/reporter.ts';

const reporter = init(Reporter, { id: `daily-${isoDate}` });
const receipt = await reporter.dispatch('Review recent activity and prepare the daily summary.');
const reply = await reporter.read(receipt);
await postSummary(reply.text);
```

The `read()` promise is not itself durable: if the process dies mid-await, the run still settles, but anything after the `await` is gone — so side effects that must not be lost belong inside the agent (a tool call), not after the read. For orchestration that must survive crashes, see [Workflows](/docs/guide/workflows/#durable-workflows).

For schedules that live outside a Flue application entirely — a standalone cron script on another machine — boot the runtime with [`start()`](/docs/guide/building-agents/#standalone-scripts) and use the same handle.

## External schedulers

When the platform provides cron as a service — Fly scheduled Machines, Render cron jobs, Railway cron schedules — trigger the deployed application over HTTP instead of running a second process. The scheduler `POST`s a signal to the mounted [conversation URL](/docs/guide/routing/#sending-a-message):

```http title="Platform cron → deployed application"
POST /agents/reporter/daily-summary HTTP/1.1
Content-Type: application/json
Authorization: Bearer <scheduler-token>

{
  "kind": "signal",
  "type": "schedule",
  "body": "Review recent activity and prepare the daily summary."
}
```

The server responds `202` at admission, exactly like `dispatch(...)`. This path requires the agent to be mounted, and a mounted agent has no built-in authentication — put the mount behind middleware that verifies the scheduler's credential, as described in [Protecting your agents](/docs/guide/routing/#protecting-your-agents). The [Fly](/docs/ecosystem/deploy/fly/), [Render](/docs/ecosystem/deploy/render/), and [Railway](/docs/ecosystem/deploy/railway/) deploy pages cover each platform's scheduler and its limits.

## One-shot runs from CI

A scheduler that can run a command — cron itself, a CI pipeline, GitHub Actions — can drive the same agent with [`flue run`](/docs/cli/run/) instead of a live server:

```bash
flue run src/agents/reporter.ts \
  --message "Review recent activity and prepare the daily summary." \
  --id "daily-$(date +%F)"
```

Each invocation compiles the agent module locally, delivers one `kind: 'user'` message (there is no signal form), streams activity to stderr, prints the reply to stdout, and exits. The dated `--id` gives each day its own conversation; with a configured database, a reused `--id` continues one conversation across invocations.

## Operational behavior

### Missed fires

An in-process Node scheduler fires only while the server is running: fires during downtime or a deploy are skipped, and cron libraries do not replay them on restart. If a fire must not be lost to a restart window, use a platform scheduler (a Cloudflare Cron Trigger or an [external scheduler](#external-schedulers)) — the platform fires regardless of your process — or track the last completed run yourself and catch up at startup.

On Cloudflare, the platform invokes the `scheduled` handler on cadence with no traffic required. Nothing durable exists until `dispatch(...)` resolves, so a handler that throws before admission delivers nothing for that fire; keep the handler thin — dispatch and return.

### Overlap

Deliveries to one conversation never run concurrently: inputs are processed in accepted order, and a message that arrives while a response is in flight joins it at a turn boundary. Overlapping fires against a fixed id therefore queue or coalesce — they cannot double-run the agent. Croner's `protect: true` additionally skips a fire while the previous callback is still executing, which matters when the callback awaits a settled reply rather than a fast admission. Per-fire ids are independent conversations and do run concurrently.

### Durability

`dispatch(...)` resolves at admission, and what admission guarantees depends on the target. On Node with the in-memory default, admitted work lasts only as long as the process — configure a durable [database](/docs/guide/database/) so accepted submissions survive a restart and a replacement process recovers them. On Cloudflare, admission is durable in the agent's Durable Object and interrupted processing is reconciled, which makes delivery **at-least-once** — design a scheduled agent's external side effects to be idempotent. [Durability](/docs/guide/durability/) covers what recovery replays on each target.

## Next steps

- [Building Agents](/docs/guide/building-agents/#dispatch) — the `dispatch(...)` walkthrough and standalone `start()` scripts.
- [`dispatch(...)` reference](/docs/reference/agent-api/#dispatch) — receipts, conditional sends, and the full `DeliveredMessage` shape.
- [Routing](/docs/guide/routing/#dispatch-only-agents) — dispatch-only agents and protecting mounted conversation URLs.
- [Durability](/docs/guide/durability/) — recovery behavior behind admitted work on each target.
- [Channels](/docs/guide/channels/) — the same signal-delivery pattern driven by provider webhooks instead of cron.
