---
title: Evaluating Flue Agents
description: Use Vitest Evals to evaluate Flue workflows and agents through the public app boundary.
---

Evals are tests for behavior quality. They help you catch regressions in answers, routing decisions, structured outputs, tool use, and conversation behavior that ordinary unit tests do not cover.

Flue does not provide an eval runner. Use an ecosystem tool such as [Vitest Evals](https://vitest-evals.sentry.dev/docs) and point it at the Flue boundary you actually ship: workflow HTTP routes, direct agent prompts, or SDK calls.

This guide uses `examples/evals` as its shape: a small Flue app with one HTTP-exposed workflow, one HTTP-exposed agent, and evals that run against public routes.

## What to Evaluate

Evaluate workflows when the behavior has a bounded input and output. Classification, extraction, summarization, ranking, and report generation are usually workflow evals because each case can assert a final structured result.

Evaluate agents when the behavior depends on persistent conversation state. Direct agent evals should use a fresh agent instance id per case unless the case is intentionally testing memory across turns.

Prefer the app boundary over Flue internals. Flue uses `pi-ai` internally, but most Flue users should not start with `@vitest-evals/harness-pi-ai`; that evaluates a runtime adapter rather than the workflow route, agent route, or SDK call your application exposes.

## Install Vitest Evals

Install Vitest and Vitest Evals in your app. Add `@flue/sdk` if your evals call Flue through the SDK instead of raw HTTP.

```bash
npm install -D vitest vitest-evals
npm install -D @flue/sdk # optional, for SDK-based evals
```

Keep evals out of the default unit-test suite. Use a separate config and command:

```json title="package.json"
{
  "scripts": {
    "evals": "vitest run --config vitest.evals.config.ts",
    "evals:json": "vitest run --config vitest.evals.config.ts --reporter=vitest-evals/reporter --reporter=json --outputFile.json=vitest-results.json"
  }
}
```

```ts title="vitest.evals.config.ts"
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['evals/**/*.eval.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    reporters: ['vitest-evals/reporter'],
    env: {
      FLUE_EVAL_BASE_URL: process.env.FLUE_EVAL_BASE_URL ?? 'http://localhost:3583',
      FLUE_EVAL_WITH_JUDGES: process.env.FLUE_EVAL_WITH_JUDGES ?? '0',
    },
  },
});
```

These env vars belong to the eval process. Provider keys and model selection still need to be available to the Flue server process you are evaluating.

## Create a Harness

Use `createHarness(...)` to turn a Flue route call into a Vitest Evals run. The harness receives eval input, calls your app, and returns the app-facing output.

```ts title="evals/flue.eval.ts"
import { createHarness } from 'vitest-evals';

type ClassificationInput = {
  message: string;
};

type ClassificationOutput = {
  category: 'billing' | 'technical' | 'account' | 'other';
  priority: 'low' | 'medium' | 'high';
  summary: string;
};

const baseUrl = (process.env.FLUE_EVAL_BASE_URL ?? 'http://localhost:3583').replace(/\/+$/, '');

const workflowHarness = createHarness<ClassificationInput, ClassificationOutput>({
  name: 'flue-workflow-http',
  run: async ({ input, signal, setArtifact }) => {
    const response = await fetch(`${baseUrl}/workflows/classify?wait=result`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
      signal,
    });

    const body = (await response.json()) as {
      result: ClassificationOutput;
      runId: string;
      streamUrl: string;
      offset: string;
    };

    setArtifact('runId', body.runId);
    setArtifact('streamUrl', body.streamUrl);
    setArtifact('offset', body.offset);
    return { output: body.result };
  },
});
```

If your Flue app mounts `flue()` under a prefix, include that prefix in `FLUE_EVAL_BASE_URL`, such as `https://preview.example.com/api`.

## Evaluate a Workflow

An HTTP-exposed workflow exports `route` from its workflow module and is available at `POST /workflows/<name>`. Add `?wait=result` when the eval needs the final output inline.

```ts title="src/workflows/classify.ts"
import { createAgent, type FlueContext, type WorkflowRouteHandler } from '@flue/runtime';
import * as v from 'valibot';

export const route: WorkflowRouteHandler = async (_c, next) => next();

const classifier = createAgent(() => ({ model: 'openai/gpt-5.5' }));

export async function run({ init, payload }: FlueContext) {
  const harness = await init(classifier);
  const session = await harness.session();
  const message =
    typeof payload === 'object' && payload && 'message' in payload ? String(payload.message) : '';

  const response = await session.prompt(`Classify this support request: ${message}`, {
    result: v.object({
      category: v.picklist(['billing', 'technical', 'account', 'other']),
      priority: v.picklist(['low', 'medium', 'high']),
      summary: v.string(),
    }),
  });

  return response.data;
}
```

```ts title="evals/flue.eval.ts"
import { expect } from 'vitest';
import { describeEval } from 'vitest-evals';

describeEval('classify workflow', { harness: workflowHarness }, (it) => {
  it('returns billing triage when the request is about duplicate charges', async ({ run }) => {
    const result = await run({
      message: 'I was charged twice for invoice INV-123 and need help with a refund.',
    });

    expect(result.output).toMatchObject({ category: 'billing' });
    expect(['low', 'medium', 'high']).toContain(result.output.priority);
    expect(result.output.summary.trim().length).toBeGreaterThan(0);
  });
});
```

The eval asserts the structured `result` returned by the workflow. The `runId` is saved as an artifact so the eval report can point back to Flue logs or run events when a case fails.

## Evaluate an Agent

Direct agent prompts are persistent. Use a unique agent instance id per eval case so one case does not inherit another case's session history.

```ts title="evals/flue.eval.ts"
import { randomUUID } from 'node:crypto';
import { createFlueClient } from '@flue/sdk';
import { createHarness, describeEval } from 'vitest-evals';

const client = createFlueClient({ baseUrl });

const agentHarness = createHarness<{ message: string }, { instanceId: string; text: string }>({
  name: 'flue-agent-sdk',
  run: async ({ input, signal, setArtifact }) => {
    const instanceId = `support-eval-${randomUUID()}`;
    const response = await client.agents.prompt('support', instanceId, {
      message: input.message,
      signal,
    });

    const promptResult = response.result as { text?: unknown };
    const text =
      typeof promptResult.text === 'string' ? promptResult.text : JSON.stringify(response.result);

    setArtifact('instanceId', instanceId);
    setArtifact('streamUrl', response.streamUrl);

    return { output: { instanceId, text } };
  },
});

describeEval('support agent', { harness: agentHarness }, (it) => {
  it('answers a billing prompt with an isolated agent instance', async ({ run }) => {
    const result = await run({
      message:
        'A customer says they were charged twice for invoice INV-123. Give a concise support triage reply.',
    });

    expect(result.output.instanceId).toMatch(/^support-eval-/);
    expect(result.output.text.trim().length).toBeGreaterThan(20);
    expect(result.output.text.toLowerCase()).toMatch(/billing|charge|invoice|refund|payment/);
  });
});
```

Use direct HTTP instead of the SDK if that is the boundary you need to verify. The SDK call above maps to `POST /agents/:name/:id?wait=result` and returns the prompt `result` with `streamUrl`, `offset`, and `submissionId`.

## Add Assertions and Judges

Start with ordinary deterministic assertions. They are cheaper, faster, easier to debug, and better at protecting structured contracts.

Use judges only for checks that are genuinely semantic, such as factuality, groundedness, tone, or rubric quality. Keep the basic harness working before adding a judge.

```ts
import { createJudge, type JudgeContext } from 'vitest-evals';

const classificationRubricJudge = createJudge(
  'classification-rubric',
  async (
    ctx: JudgeContext<ClassificationInput, ClassificationOutput, { expectedCategory?: string }>,
  ) => {
    const correctCategory =
      ctx.metadata.expectedCategory === undefined ||
      ctx.output.category === ctx.metadata.expectedCategory;
    const hasSummary = ctx.output.summary.trim().length > 0;

    return {
      score: correctCategory && hasSummary ? 1 : 0,
      metadata: {
        expectedCategory: ctx.metadata.expectedCategory ?? null,
        actualCategory: ctx.output.category,
        hasSummary,
      },
    };
  },
);

await expect(result).toSatisfyJudge(classificationRubricJudge, { threshold: 1 });
```

Model-backed judges are useful when the check cannot be expressed deterministically. The judge model is separate from the Flue app under test. Configure it through Vitest Evals using the judge harness that fits your evaluation environment. Do not reach into Flue's internal `pi-ai` runtime just to grade a shipped Flue route.

## Running Locally and in CI

For the simplest local setup, run the Flue dev server in one terminal and evals in another:

```bash
pnpm run dev
FLUE_EVAL_BASE_URL=http://localhost:3583 pnpm run evals
```

For CI, prefer a generated server artifact so the evals exercise the same route shape you deploy:

```yaml
- run: pnpm run build
- run: PORT=3583 node dist/server.mjs &
- run: pnpm run evals:json
  env:
    FLUE_EVAL_BASE_URL: http://localhost:3583
    OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
- uses: getsentry/vitest-evals@v0
  if: always()
  with:
    results: vitest-results.json
```

Add your normal readiness check before running evals. Keep model API keys in CI secrets, set provider spending limits, and avoid broad eval suites on every pull request unless you have a clear budget for them.

## Cloudflare-Specific Evals

Use Cloudflare dev or preview environments only when the Cloudflare platform is part of the behavior under test: Workers AI, Durable Object durability, Cloudflare Sandbox behavior, scheduled events, bindings, or platform-specific routing.

For ordinary model behavior and workflow output quality, the same black-box harness can point at a local Node server or any deployed preview URL. Change only `FLUE_EVAL_BASE_URL`; keep the eval assertions focused on the app boundary.
