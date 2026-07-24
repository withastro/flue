---
title: Evals
description: Test agent behavior by running an agent against a live model and asserting on what it does.
lastReviewedAt: 2026-07-21
---

An **eval** is an automated test that runs an agent against a live model and asserts on its observable behavior: the reply it produces, the tools it calls, the data it emits. This guide covers what separates evals from ordinary tests, setting up an eval suite with Vitest, running the agent under test in-process and over HTTP, scoring results with assertions and judges, and running evals locally and in CI.

## What an eval is

An agent's behavior emerges from its instructions, its model, and its tools together. The parts you wrote are ordinary code with ordinary tests — a [tool's](/docs/guide/tools/) `run` function is a plain function you can unit-test directly, with no model involved. What unit tests cannot cover is the model's contribution: whether the agent calls the right tool, follows its instructions, and produces a correct answer. Evals cover that by running the complete loop — instructions, model, tools — and asserting on the outcome.

Two properties shape how evals are written:

- **Evals are nondeterministic.** The same input can produce different wording, a different tool order, occasionally a different outcome. Assert on the behavioral contract — required tool calls, key facts in the reply, the shape of structured data — rather than exact output strings.
- **Evals spend real tokens and real time.** Every case runs one or more live model turns. Evals therefore live in their own suite, with their own configuration, credentials, timeouts, and run cadence, separate from unit tests.

Flue has no dedicated eval framework. An eval is a [Vitest](https://vitest.dev) test that drives an agent through the same public surfaces every other caller uses — the in-process [`init()` handle](/docs/reference/agent-api/#init) or the HTTP conversation surface — and asserts on the result. The [vitest-evals](/docs/ecosystem/tooling/vitest-evals/) integration layers eval harnesses, judges, and CI reporting on top; see [below](#vitest-evals).

## Set up an eval suite

Keep evals in a dedicated Vitest configuration. Live-model tests need different file discovery, longer timeouts, and different credentials than unit tests, and a separate config lets each run independently:

```ts title="vitest.evals.config.ts"
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/evals/**/*.eval.ts'],
    testTimeout: 60_000,
  },
});
```

The `60_000` timeout replaces Vitest's 5-second default, which a single live model turn can exceed. Add a script so the suite runs with one command:

```json title="package.json"
{
  "scripts": {
    "evals": "vitest run --config vitest.evals.config.ts"
  }
}
```

Eval files live under `src/evals/` and are named for the capability or scenario they evaluate — `service-health.eval.ts`, `refund-policy.eval.ts` — not one file per agent.

## Write an eval in-process

The most direct way to run an agent in a test is [`start()`](/docs/guide/building-agents/#standalone-scripts) from `@flue/runtime/node`, which boots the Flue runtime inside the test process — no server, no build. The [`init()`](/docs/reference/agent-api/#init) handle then sends a message and awaits the settled reply:

```ts title="src/evals/service-health.eval.ts"
import { init } from '@flue/runtime';
import { start } from '@flue/runtime/node';
import { afterAll, expect, it } from 'vitest';
import { ServiceStatus } from '../agents/service-status.ts';

const flue = await start({ agents: [ServiceStatus] });
afterAll(() => flue.stop());

it('checks live service status before answering', async () => {
  const toolsCalled: string[] = [];

  // No id: init() mints a fresh conversation for this case.
  const agent = init(ServiceStatus);
  const receipt = await agent.dispatch('Is the checkout service currently operational?');
  const reply = await agent.read(receipt, {
    onEvent: (chunk) => {
      if (chunk.type === 'tool-input') toolsCalled.push(chunk.toolName);
    },
  });

  expect(reply.text).toContain('operational');
  expect(toolsCalled).toContain('get_service_status');
});
```

Everything here is the ordinary programmatic surface:

- **Fresh conversation per case.** `init(agent)` without an `id` addresses a new, uniquely named conversation, so cases stay independent — saved conversation history cannot affect other cases. A case that evaluates conversation memory reuses one handle and sends several `dispatch(...)`/`read(...)` pairs through it.
- **The reply is the assertion target.** `reply.text` is the final assistant text, and `reply.data` carries named [`useDataWriter`](/docs/guide/agent-hooks/#streaming-data-to-the-client) parts — the place to assert on structured results. A failed or aborted run rejects `read()` with `AgentRunError`, which fails the test.
- **Tool calls arrive as events.** `read()`'s `onEvent` callback receives every conversation chunk as it is recorded; `tool-input` chunks carry the `toolName` and `input` of each tool call the model made.
- **Full runtime behavior.** Hooks, durability, and sandboxes work exactly as they do in a server — `start()` is the same assembly without an HTTP surface.

Three constraints apply. One process holds one Flue runtime, so call `start()` once per test file and stop it when the file finishes — Vitest's default isolation gives each test file its own worker, which keeps files from colliding. Provider credentials come from the test process environment (see [Models — Provider credentials](/docs/guide/models/#provider-credentials)). And the eval imports the agent module directly, so the module must load under plain Vitest: an agent that depends on build-resolved imports, such as a [`SKILL.md` import](/docs/guide/skills/#import-and-mount-a-skill), needs the Flue build and should be evaluated over HTTP instead.

## Evaluate over HTTP

An agent [mounted in `app.ts`](/docs/guide/routing/#mounting-an-agent) can be evaluated through its HTTP surface with the [Flue Agent SDK](/docs/sdk/overview/) — the same boundary a deployed application serves, including your route middleware. A fresh conversation is a fresh id appended to the mount URL:

```ts title="src/evals/service-health.eval.ts"
import { createFlueClient } from '@flue/sdk';
import { expect, it } from 'vitest';

// The agent's mount URL from app.ts; point FLUE_AGENT_URL at a deployment.
const mountUrl = process.env.FLUE_AGENT_URL ?? 'http://127.0.0.1:5173/agents/service-status';

it('checks live service status before answering', async () => {
  const conversation = createFlueClient({
    url: `${mountUrl}/eval-${crypto.randomUUID()}`,
  });

  const admission = await conversation.send({
    message: { kind: 'user', body: 'Is the checkout service currently operational?' },
  });
  await conversation.wait(admission);

  const { messages } = await conversation.history();
  const reply = messages.findLast((message) => message.role === 'assistant');
  const text =
    reply?.parts
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('') ?? '';

  expect(text).toContain('operational');
});
```

Prompts are fire-and-forget over HTTP: `send()` admits the message, `wait()` awaits its completion, and `history()` returns the finished conversation — including the assistant reply and its tool-call parts. The eval process does not start the application; run `vite dev` (or the built server) in another terminal, or set the URL to a deployed environment. When the route is protected, pass `token` or `headers` to `createFlueClient(...)` — see [Protecting your agents](/docs/guide/routing/#protecting-your-agents).

Choose a surface by what the eval should exercise:

- **In-process (`start()`)** exercises the agent itself — instructions, model, hooks, tools — and needs provider credentials in the test environment.
- **HTTP (`@flue/sdk`)** exercises the agent plus `app.ts` routing and middleware, and needs a running dev server or deployment.

Both surfaces are public APIs, so they also serve as the integration point for other eval libraries and hosted platforms such as [Braintrust](/docs/ecosystem/tooling/braintrust/) — drive the agent the same way and hand the result to your own scoring pipeline.

## vitest-evals

[`vitest-evals`](https://vitest-evals.sentry.dev/docs) extends Vitest with eval harnesses, LLM judges, normalized reports, and CI reporting. Add Flue's integration with a [blueprint](/docs/cli/add/):

```sh
flue add tooling vitest-evals
```

The blueprint creates the eval configuration and scripts from [above](#set-up-an-eval-suite) and generates `src/evals/harness.ts` — a harness that drives one conversation per case through `@flue/sdk` and converts the reply, tool calls, and usage into the normalized `vitest-evals` result. Setup, generated files, and report commands are documented on the [vitest-evals ecosystem page](/docs/ecosystem/tooling/vitest-evals/); a complete runnable project is available in [`examples/vitest-evals`](https://github.com/withastro/flue/tree/main/examples/vitest-evals).

Cases are written with `describeEval`, which binds the harness to a suite and hands each test a `run(...)` function:

```ts title="src/evals/service-health.eval.ts"
import { expect } from 'vitest';
import { describeEval, toolCalls } from 'vitest-evals';
import { createFlueAgentHarness } from './harness.ts';

const harness = createFlueAgentHarness({
  agentUrl: process.env.FLUE_AGENT_URL ?? 'http://127.0.0.1:5173/agents/service-status',
});

describeEval('service status agent', { harness }, (it) => {
  it('checks live service status before answering', async ({ run }) => {
    const result = await run('Is the checkout service currently operational?');

    expect(result.output).toContain('operational');
    expect(toolCalls(result).map((call) => call.name)).toContain('get_service_status');
  });
});
```

### Judges

Deterministic assertions cover exact contracts: required tools, prohibited tools, structured output, stable content. For semantic behavior — factual consistency, tone, policy adherence — `vitest-evals` provides **judges**, scorers that grade a result and fail the case below a threshold. LLM-backed judges run on a _judge harness_: the judge's own model connection, configured separately from the agent under evaluation:

```ts
import { expect } from 'vitest';
import { describeEval, FactualityJudge } from 'vitest-evals';

describeEval('service status agent', { harness, judgeHarness }, (it) => {
  it('reports status consistent with the reference answer', async ({ run }) => {
    const result = await run('Is the checkout service currently operational?');

    await expect(result).toSatisfyJudge(FactualityJudge(), {
      expected: 'The checkout service is currently operational.',
      threshold: 0.6,
    });
  });
});
```

`createJudge(...)` defines custom judges, deterministic or LLM-backed; the built-in `FactualityJudge`, `ToolCallJudge`, and `StructuredOutputJudge` cover the common rubrics. Judge construction and judge-harness adapters are documented in the [vitest-evals docs](https://vitest-evals.sentry.dev/docs). Prefer deterministic assertions first and add a judge only where the behavior cannot be checked exactly.

## Run evals locally and in CI

Locally, in-process suites run with one command once provider credentials are in the environment:

```sh
pnpm run evals
```

HTTP suites additionally need a reachable target: start the application in another terminal first, or set the suite's URL variable to a deployed environment:

```sh
FLUE_AGENT_URL=https://preview.example.com/agents/service-status pnpm run evals
```

In CI, an eval suite is an ordinary Vitest run — it exits non-zero when a case fails, so it gates a pipeline like any other test job. Keep it as a separate job from unit tests: live-model runs are slower, spend tokens, and can fail without a code change, so they warrant their own cadence — on merge, on a schedule, or on demand. Provider credentials come from CI secrets; for HTTP suites, either build and start the application inside the job or target a preview [deployment](/docs/guide/deploy/).

For reporting, the vitest-evals blueprint adds an `evals:json` script that writes a `vitest-results.json` artifact. Inspect it locally with `vitest-evals serve vitest-results.json`, or publish it from CI with the `getsentry/vitest-evals` GitHub Action. Reports can contain prompts, outputs, tool arguments and results, and errors — review retention and access requirements before uploading them.

## Next steps

- [Vitest Evals](/docs/ecosystem/tooling/vitest-evals/) — the blueprint, generated harness, and report commands.
- [Agents](/docs/guide/building-agents/#standalone-scripts) — `start()` and standalone scripts, the same surface evals build on.
- [Agent API](/docs/reference/agent-api/#init) — the full `init()` handle contract, `AgentReply`, and `AgentRunError`.
- [Agent SDK](/docs/sdk/flue-client/) — `send()`, `wait()`, and `history()` on one conversation URL.
- [Observability](/docs/guide/observability/) — tracing agent runs with [Braintrust](/docs/ecosystem/tooling/braintrust/) and other providers; identifiers such as `submissionId` and the conversation id connect a failing case to the execution that produced it.
