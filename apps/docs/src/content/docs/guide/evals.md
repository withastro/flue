---
title: Evals
description: Evaluate Flue agents with repeatable Vitest suites using vitest-evals.
lastReviewedAt: 2026-06-18
---

Model output can change when you revise instructions, switch models, or alter the tools available to an agent. Evals give those changes a repeatable set of scenarios and expectations, so you can decide whether the new behavior is acceptable before shipping it.

Flue does not prescribe an eval library; nor do we build one into the framework itself. Instead, we recommend Sentry's [`vitest-evals`](https://vitest-evals.sentry.dev/docs) for running evals, which leverages the popular Vitest testing library.

## vitest-evals

Use the tooling blueprint to add the dependencies, dedicated configuration, reusable Flue harness, and an application-specific starter case:

```sh
flue add tooling vitest-evals
```

The tooling blueprint creates `createFlueAgentHarness(...)`, which prompts an HTTP-exposed agent through `@flue/sdk` and records its response, model usage, costs, and tool calls in the format expected by `vitest-evals`. Each eval case gets a fresh agent instance, so saved conversation history cannot affect other cases. To evaluate a workflow instead, create a harness around `client.workflows.invoke(...)` and return the workflow result as its output.

For protected deployments, configure the SDK client with the required token or headers. See [Vitest Evals tooling](/docs/ecosystem/tooling/vitest-evals/) for setup and reporting details.

In addition to ordinary Vitest assertions and case tables, `vitest-evals` supports model-based and deterministic judges, normalized transcripts and tool calls, tool replay, JSON reports, a local report UI, and GitHub reporting. See the [`vitest-evals` documentation](https://vitest-evals.sentry.dev/docs) for the complete feature set and API.

### Write an eval

Use `describeEval(...)` to bind the Flue harness to a suite. Call `run(...)` explicitly, then use ordinary Vitest assertions and `vitest-evals` helpers on the normalized result:

```ts title="src/evals/service-health.eval.ts"
import { expect } from 'vitest';
import { describeEval, toolCalls } from 'vitest-evals';
import { createFlueAgentHarness } from './harness.ts';

const harness = createFlueAgentHarness({ agentName: 'service-status' });

describeEval('Flue service status agent', { harness }, (it) => {
  it('checks live service status before answering', async ({ run }) => {
    const result = await run('Is the checkout service currently operational?');

    expect(result.output).toContain('operational');
    expect(toolCalls(result).map((call) => call.name)).toContain('get_service_status');
    expect(result.usage.totalTokens).toBeGreaterThan(0);
  });
});
```

This case protects requirements that can be checked directly: the answer reports the current status, the agent consults the service-status tool, and the model reports token usage. Use direct assertions for requirements with a concrete expected result. Use an agent harness to inspect responses and tool use, or a workflow harness when the workflow's returned value is what matters.

Some qualities—such as whether an explanation is clear or a summary preserves the important facts—need a score rather than an exact match. For those cases, configure a `vitest-evals` judge and use `toSatisfyJudge(...)`. Keep the grading model independent from the model being evaluated, and see the `vitest-evals` judge documentation for its built-in and custom options.

### Run evals

Start the Flue application in one terminal:

```sh
pnpm exec flue dev
```

Run the eval suite in another:

```sh
pnpm run evals
```

The agent uses the same provider credentials as the rest of your Flue application. The eval exits non-zero when an assertion or gated judge fails, so the same command can be used in CI.

Run `pnpm run evals:json` to save the normalized runs in `vitest-results.json`. That artifact can be opened with `vitest-evals serve vitest-results.json` or passed to the `getsentry/vitest-evals` GitHub Action for job summaries and annotations.

Set `FLUE_BASE_URL` to evaluate a deployed application instead of the local development server:

```sh
FLUE_BASE_URL=https://your-app.example.com pnpm run evals
```

The harness uses the agent's public HTTP route, so the module under test must export `route`. When evaluating a protected deployment, pass the required request headers to `createFlueClient(...)`.

A complete runnable version of the agent, harness, and eval is available in [`examples/vitest-evals`](https://github.com/withastro/flue/tree/main/examples/vitest-evals).

## Braintrust

[Braintrust](https://www.braintrust.dev) provides a hosted platform for datasets, experiments, scoring, and comparing eval results over time. You can run Braintrust evals against the same public Flue agent and workflow APIs used in this guide. Flue also provides a [Braintrust tooling integration](/docs/ecosystem/tooling/braintrust/) that exports model, tool, task, usage, and error traces from the application. Experiment results and runtime traces serve different purposes, but identifiers such as `runId`, `instanceId`, and `submissionId` can connect a failed case to the execution that produced it.

## Bring your own evals

You do not need `vitest-evals` to evaluate a Flue application. An eval can call an agent with `client.agents.prompt(...)` or a workflow with `client.workflows.invoke(...)`, compare the returned result with the behavior you expect, and send the result to any test runner or hosted platform. The harness in this guide packages that work for `vitest-evals`; use the same SDK boundary to integrate another eval library or your own scoring pipeline.
