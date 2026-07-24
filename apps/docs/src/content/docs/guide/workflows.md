---
title: Workflows
description: Driving agents from programs — one-shot CLI runs and CI jobs, standalone scripts, the SDK, and durable workflows.
lastReviewedAt: 2026-07-21
---

In Flue, a workflow is any script or program that runs an agent. Workflows are not a Flue feature per se — they are just a useful pattern we've found for referring to all of the different ways that you might use Flue to build scripted automations outside of the usual deployed "chatbot" agent experience.

To learn how to deploy an agent, visit the [Deploy](/docs/guide/deploy/) guide.

## Choosing an approach

The right approach to programmable automations will usually depend on where the code runs and what it needs back from the run:

| Approach                                  | When to use it                                                                                                                                                                          |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`flue run`](#flue-run)                   | You need to initialize and prompt a local agent from the terminal. Best for CI workflows.                                                                                               |
| [The Flue JS API](#the-flue-js-api)       | You need to initialize and control a local agent from Node.js. Best for local scripting, cron jobs, etc.                                                                                |
| [The Flue Agent SDK](#the-flue-agent-sdk) | You need to initialize and control a hosted agent over HTTP. Best for talking (or listening) to deployed production agents.                                                             |
| [Durable Workflows](#durable-workflows)   | You need to initialize and control a hosted agent from a hosted runtime, and need durability guarantees. Best for multi-step orchestration and products that must survive interruption. |

These approaches are not mutually exclusive: a durable workflow will use the same `start()` and `init()` API as a standalone Node.js script, and a CI job wraps the same `flue run` command you'd type in a terminal.

## `flue run`

The smallest workflow is a single [`flue run`](/docs/cli/run/) invocation. It loads the agent module in the local process, submits one message, prints the final reply to stdout, and exits when the run settles — the exit code reports success or failure.

```bash
flue run src/agents/triage.ts --message "Triage issue 17307." --id issue-17307
```

Everything except the reply streams to stderr, so stdout stays pipeable, and passing `--json` swaps the plain reply for a result envelope. That is enough to chain agents from a shell script:

```bash
summary=$(flue run src/agents/reporter.ts -m "Summarize yesterday's deploys." --json | jq -r .message)
flue run src/agents/notifier.ts -m "Post this summary to #eng: $summary"
```

Conversations persist between invocations in the project's [configured database](/docs/guide/database/), so reusing an `--id` continues one conversation across runs.

The same command runs anywhere a CI job can run a shell step, which makes CI the easiest place to host a recurring workflow. Provider credentials come from the job's environment, and `--new` combined with a deterministic `--id` makes conversation creation exactly-once, so a retried job cannot double-create the conversation:

```yaml title=".github/workflows/triage.yml"
jobs:
  triage:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: >
          npx flue run src/agents/triage.ts
          --message "Triage issue #${{ github.event.issue.number }}."
          --id "issue-${{ github.event.issue.number }}"
          --new --json > triage.json
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

The envelope in `triage.json` carries the outcome, the reply, and the conversation id for later steps to use. The [GitHub Actions](/docs/ecosystem/deploy/github-actions/) and [GitLab CI](/docs/ecosystem/deploy/gitlab-ci/) ecosystem pages cover the platform details.

See the [`flue run` reference](/docs/cli/run/) for agent selection, creation data, and the full flag list.

## The Flue JS API

When your workflow needs more than what `flue run` can offer — loops, error handling, or data structures — write a Node.js script instead. [`start()`](/docs/guide/building-agents/#standalone-scripts) boots the Flue runtime inside your own process, with no server and no `app.ts`, and [`init()`](/docs/reference/agent-api/#init) returns a handle to an agent conversation. The handle's `dispatch()` submits a message and resolves with its durable receipt; `read()` awaits the settled reply:

```ts title="scripts/nightly.ts"
import { init } from '@flue/runtime';
import { sqlite, start } from '@flue/runtime/node';
import { Reporter } from '../src/agents/reporter.ts';

await using flue = await start({
  agents: [Reporter],
  db: sqlite('./nightly.db'),
});

const reporter = init(Reporter, { id: 'nightly-2026-07-17' });
const receipt = await reporter.dispatch('Produce the nightly report.');
const reply = await reporter.read(receipt);
console.log(reply.text);
```

A failed or aborted run rejects the `read()` with `AgentRunError`, so ordinary `try`/`catch` is all the error handling a script needs. The `db` option decides whether conversations outlive the script: omit it for in-memory state that vanishes with the process, or configure a [database adapter](/docs/guide/database/) so a later run can continue the same conversation.

See the [`init()` reference](/docs/reference/agent-api/#init) for the rest of the handle's surface.

## The Flue Agent SDK

The Flue Agent SDK connects to a deployed agent over HTTP, sending messages and streaming back responses. A client wraps one conversation URL:

```ts title="scripts/audit-release.ts"
import { createFlueClient } from '@flue/sdk';

const conversation = createFlueClient({
  url: `https://example.com/agents/release-auditor/release-${version}`,
  token: process.env.FLUE_TOKEN,
});

const admission = await conversation.send({
  message: { kind: 'user', body: `Audit the ${version} rollout.` },
});
const reply = await conversation.read(admission);
console.log(reply.text);
```

The SDK mirrors the handle's model over HTTP: `send()` resolves at admission with the submission's identifiers, and `read()` awaits that submission's settlement and resolves with its reply (throwing `FlueExecutionError` on failure or abort). `read()` also takes a bare submission id, so a process that persisted just the admission can re-attach later — the same recovery story as the handle's `read()`. Choose by where the agents live: use `start()` when your script runs the agents itself, and the SDK when they run in a deployment.

## Durable Workflows

Flue already guarantees a durable outcome for every individual send: once a message is admitted, that submission settles through crashes, restarts, and redeploys — the [Durability](/docs/guide/durability/) guide covers that contract. What Flue does not guarantee is the script _around_ the sends: a workflow that dies between two dispatches re-runs from its start. That is fine for a quick script, but not for a multi-step orchestration that must finish once started.

That gap is what a **durable workflow** fills: a hosted script whose steps checkpoint their results, so it can retry a failed step, resume a run that spans days, and survive restarts without losing its place. [Cloudflare Workflows](https://developers.cloudflare.com/workflows/), [Inngest](https://www.inngest.com/), and [Temporal](https://temporal.io/) are a few of the products built on this primitive, and Flue needs no special integration with any of them — write the durable workflow on your platform of choice and call Flue from it like any other service.

In the examples below, the dispatch runs in its own workflow step, so the receipt — the durable claim ticket for the submission — is checkpointed the moment it exists, and a second step reads the settled reply. A completed dispatch step never re-runs the send, and a read step that crashes re-attaches with the same receipt instead of prompting again.

The split also splits any per-step time bound: a 20-minute step timeout becomes up to 40 minutes end-to-end. If the operation carries one deadline, checkpoint it in the dispatch step's result and have the read step enforce the remainder.

### Example: Cloudflare Workflows

On Cloudflare, write the Workflow in the same Worker as your Flue application and call the `init()` handle from steps:

```ts title="src/cloudflare.ts"
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { init } from '@flue/runtime';
import { Reviewer } from './agents/reviewer.ts';
import { collectFindings, fileReport } from './shared/nightly.ts';

type Params = { date: string };

export class NightlyReview extends WorkflowEntrypoint {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    const findings = await step.do('collect findings', () => collectFindings(event.payload.date));

    const agent = init(Reviewer, { id: `nightly-${event.payload.date}` });

    const receipt = await step.do('dispatch review', () =>
      agent.dispatch(`Review these findings:\n${findings}`),
    );

    const review = await step.do('read review', async () => {
      const reply = await agent.read(receipt);
      return { text: reply.text, data: reply.data };
    });

    await step.do('file report', () => fileReport(review));
  }
}
```

The class is exported from [`src/cloudflare.ts`](/docs/guide/cloudflare-target/#extending-cloudflarets-entrypoint), with its workflow binding declared in `wrangler.jsonc`. See the [Cloudflare target guide](/docs/guide/cloudflare-target/) for the rest of the platform details.

### Example: Inngest

In Inngest, the send goes inside a `step.run`. Call `init()` when the function runs inside your Flue application's process, or use the [Agent SDK](#the-flue-agent-sdk) when it runs as a separate service:

```ts title="src/inngest/nightly-review.ts"
import { init } from '@flue/runtime';
import { inngest } from './client.ts';
import { Reviewer } from '../agents/reviewer.ts';
import { fileReport } from '../shared/nightly.ts';

export const nightlyReview = inngest.createFunction(
  { id: 'nightly-review' },
  { event: 'reports/nightly.requested' },
  async ({ event, step }) => {
    const agent = init(Reviewer, { id: `nightly-${event.data.date}` });

    const receipt = await step.run('dispatch review', () =>
      agent.dispatch('Review the nightly findings.'),
    );

    const review = await step.run('read review', async () => {
      const reply = await agent.read(receipt);
      return { text: reply.text, data: reply.data };
    });

    await step.run('file report', () => fileReport(review));
  },
);
```

The same pattern applies to any other durable workflow engine: in Temporal, the dispatch and the read would each live inside an activity.

### Re-attaching after a crash

`read()` holds no in-memory state: settlement and reply are durable conversation records, so any process can read a submission at any later time, and a submission that settled while the workflow was down resolves immediately. That is why the receipt gets its own step above — once the engine has checkpointed it, every retry of the read step re-attaches to the same submission instead of prompting again.

The one crash window left is inside the dispatch step itself: the send was admitted, but the step died before checkpointing the receipt. The engine re-runs the step, which sends again — and the instance's send condition decides what that means:

- An unconditional send (no `uid`) delivers the duplicate, which joins the live response at a turn boundary; both submissions settle with the same coalesced reply, so the retry's fresh receipt reads the same answer.
- A create-only send (`uid: null`) rejects the duplicate at admission with `AgentInstanceExistsError` — nothing reaches the agent twice, and the rejection is the workflow's signal to fail the run or fall back.

## Next steps

- [Durability](/docs/guide/durability/) — the accepted-work contract behind every send.
- [Schedules](/docs/guide/schedules/) — time-triggered dispatch, in-app and external.
- [`flue run`](/docs/cli/run/) — the full CLI reference.
- [SDK overview](/docs/sdk/overview/) — the conversation client for deployed applications.
- [Deploy](/docs/guide/deploy/) — hosting the application these workflows drive.
