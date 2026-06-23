---
title: Jetty
description: Grade Flue agent runs with Jetty — an independent grader, plus durable, labelled trajectories you can compare across versions.
lastReviewedAt: 2026-06-23
---

## Quickstart

You shipped a Flue agent. You tweaked a prompt. Is it better or worse? You can't
tell from one reply. [Jetty](https://jetty.io) is the check: an independent
grader plus a durable record of every run.

There's no `flue add tooling jetty` blueprint — Jetty plugs in through its SDK:

```sh
npm install @jetty/sdk
```

The complete worked example lives at
[`jettyio/jetty-sdk` → `examples/flue-jetty`](https://github.com/jettyio/jetty-sdk/tree/main/examples/flue-jetty).

## Overview

Flue owns the agent loop. In a workflow, draft with the agent, then hand the
draft to a Jetty **grading task** and wait for the result. The grade comes back
as a [trajectory](https://docs.jetty.io) you can label and compare — every run
becomes a queryable record, so a regression shows up before a customer finds it.

`gradeWithJetty` collapses the whole exchange — upload the output, run the
grader to completion, read its grade file, and label the trajectory — into one
call:

```ts
import { defineWorkflow } from "@flue/runtime";
import * as v from "valibot";
import { JettyClient, gradeWithJetty } from "@jetty/sdk";
import { triageAgent } from "../agent.js";

const jetty = new JettyClient(); // JETTY_API_TOKEN from env or ~/.config/jetty/token

export default defineWorkflow({
  agent: triageAgent,
  input: v.object({ ticket: v.any() }),
  async run({ harness, input }) {
    // 1. Flue runs the agent (it owns the loop).
    const session = await harness.session();
    const draft = await session.prompt(JSON.stringify(input.ticket));

    // 2. Jetty grades it server-side, with a grader that isn't the author.
    const { grade, trajectoryId } = await gradeWithJetty(jetty, "acme", "triage-grader", {
      files: [{ filename: "case.json", data: draft.text }],
      useTrialKeys: true,                          // grade on Jetty's free trial, no key
      labels: (g) => ({ "eval.grade": String(g.total) }), // labels can read the grade
    });

    return { grade, gradeTrajectoryId: trajectoryId };
  },
});
```

The grader is a separate Jetty task — a deterministic rubric or an LLM judge you
deploy once. It isn't the agent scoring itself, which rubber-stamps. Compare the
`eval.*` labels across configs to see which version slipped.

## Configure

| Variable | Required | Purpose |
| --- | --- | --- |
| `JETTY_API_TOKEN` | yes | Jetty API token (also read from `~/.config/jetty/token`). |
| `JETTY_COLLECTION` | yes | Collection that owns the grading task. |
| `JETTY_GRADE_TASK` | yes | The grading runbook (e.g. `triage-grader`). |
| `JETTY_USE_TRIAL_KEYS` | no | Grade on Jetty's free trial, no provider key (see below). |
| `ANTHROPIC_API_KEY` | for the agent | The Flue agent runs on your machine, so it needs a model key. |

Put anything sensitive in the run's `secretParams`, which the server keeps out
of the stored trajectory. Don't put secrets in `initParams`; that field is
persisted. The SDK never logs your token. Tokens resolve from a constructor arg,
then `JETTY_API_TOKEN`, then `~/.config/jetty/token`.

Requires `@jetty/sdk` 0.2.0+.

## What Jetty captures

| Flue | Jetty |
| --- | --- |
| Agent output (the draft) | The input the grading runbook scores |
| Grade (1–5) | Label `eval.grade` on the trajectory |
| Pass / fail vs. the bar | Label `eval.pass` |
| Per-run cost (`response.usage`) | Label `eval.cost_usd` |
| Which agent config / version | Label `eval.config` |
| The whole graded run | A [trajectory](https://docs.jetty.io): inputs, outputs, steps, replayable |

## Protect sensitive content

Trajectories persist step inputs and outputs — they're content-bearing. Put
credentials in `secretParams` (kept out of the stored trajectory), not
`initParams`. If a draft can carry PII, redact it before grading, or grade a hash
or summary instead. Treat trajectory storage like any other logging surface.

## Run on Jetty's free trial

Jetty grading runs server-side, and every collection gets a free trial: 10 runs,
auto-activated, on Jetty's keys. Set `JETTY_USE_TRIAL_KEYS=true` (or
`useTrialKeys: true` on the call) and you need no provider key to grade. Sonnet
and most models are covered; Opus-class is excluded. The Flue agent still runs on
your machine, so it uses your own model key.

## Verify

- `npm run deploy-grader` creates the grading runbook in your collection.
- `npx flue run eval --target node --input '{"tickets":2}'` prints per-run
  scores and a verdict table, then writes a labelled trajectory you can open at
  `https://flows.jetty.io/<collection>/<task>`.
- The offline `npm run demo` prints the same verdict table with no keys at all.

## Next steps

See [Evals](/docs/guide/evals/) for designing cases, choosing deterministic
assertions or judges, and gating CI. A complete runnable project is available in
[`examples/flue-jetty`](https://github.com/jettyio/jetty-sdk/tree/main/examples/flue-jetty).
Flue's [Vitest Evals](/docs/ecosystem/tooling/vitest-evals/) integration runs
assertions in-process; Jetty complements it by storing each run as a durable,
comparable trajectory graded by an independent task.
