---
title: Jetty
description: Grade Flue agent output and compare results across versions with Jetty.
lastReviewedAt: 2026-07-22
---

## Quickstart

Install the [Jetty TypeScript SDK](https://www.npmjs.com/package/@jetty/sdk) in an existing Flue project:

```sh
pnpm add @jetty/sdk
```

Jetty does not use a `flue add` blueprint. Follow Jetty's [Flue integration guide](https://docs.jetty.io/docs/agent-integrations/flue) to create and deploy a grading runbook, then call the SDK from a workflow script.

## Overview

Jetty can grade output produced by a Flue agent and store the grading task as a trajectory. Labels on that trajectory can record the score, pass/fail result, evaluated configuration, and other dimensions that you want to compare across versions.

The following Node.js script starts the Flue runtime in-process, prompts its agent, sends the reply to a separately configured Jetty grader, and prints the grade with its Jetty trajectory ID:

```ts title="scripts/evaluate-triage.ts"
import { init } from '@flue/runtime';
import { start } from '@flue/runtime/node';
import { gradeWithJetty, JettyClient } from '@jetty/sdk';
import { Triage } from '../src/agents/triage.ts';

interface TriageGrade {
  total: number;
  pass: boolean;
}

const ticket = process.argv[2] ?? 'Summarize this support request.';
const jetty = new JettyClient();

await using flue = await start({ agents: [Triage] });

const agent = init(Triage, { id: `evaluate-${Date.now()}` });
const receipt = await agent.dispatch(ticket);
const reply = await agent.read(receipt);

const { grade, trajectoryId } = await gradeWithJetty<TriageGrade>(
  jetty,
  process.env.JETTY_COLLECTION!,
  process.env.JETTY_GRADE_TASK!,
  {
    files: [
      {
        filename: 'case.json',
        data: JSON.stringify({ ticket, response: reply.text }),
      },
    ],
    useTrialKeys: process.env.JETTY_USE_TRIAL_KEYS === 'true',
    labels: (result) => ({
      'eval.grade': String(result.total),
      'eval.pass': String(result.pass),
    }),
  },
);

console.log(JSON.stringify({ grade, trajectoryId }, null, 2));
```

The grading runbook must produce the `grade.json` file expected by `gradeWithJetty(...)`. Keep the grader separate from the agent being evaluated so that changing the agent does not silently change its rubric.

## Configure

| Variable               | Purpose                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------ |
| `JETTY_API_TOKEN`      | **Required** - Authenticates the Jetty SDK. The SDK can also read `~/.config/jetty/token`. |
| `JETTY_COLLECTION`     | **Required** - Identifies the collection that owns the grading task.                       |
| `JETTY_GRADE_TASK`     | **Required** - Identifies the deployed grading task.                                       |
| `JETTY_USE_TRIAL_KEYS` | **Optional** - Set to `true` to use Jetty's trial model keys for the grading task.         |

The Flue agent still needs model-provider credentials, which come from the process environment. Jetty credentials configure the separate grading operation.

`@jetty/sdk` and `start()` both require Node.js. To grade a deployed agent instead — including one on the Cloudflare target — prompt it over HTTP with the [Agent SDK](/docs/sdk/overview/) and pass the reply to the same `gradeWithJetty(...)` call from any Node.js process.

## Protect sensitive content

Jetty trajectories can persist the files, step inputs, and outputs used for grading. Redact credentials, personal information, and other sensitive content before sending agent output to Jetty. Use Jetty's secret parameters for credentials needed by the grading runbook rather than including them in persisted initialization parameters or uploaded files.

Review Jetty's retention, access, privacy, and compliance controls before grading production content.

## Verify

Deploy the grading runbook following Jetty's integration guide, configure the required environment variables, and run the script:

```sh
node scripts/evaluate-triage.ts "Summarize this support request."
```

Confirm that the script prints the expected grade and trajectory ID, then inspect the trajectory in Jetty to verify its labels and captured content.

## Next steps

See [Evals](/docs/guide/evals/) for choosing cases, deterministic assertions, and model-based judges, and [Workflows](/docs/guide/workflows/) for the scripting surface used here — from `flue run` one-shots to durable orchestration. Flue's [Vitest Evals integration](/docs/ecosystem/tooling/vitest-evals/) provides an alternative for running assertions and judges through Vitest, while Jetty stores each grading task as a comparable trajectory.
