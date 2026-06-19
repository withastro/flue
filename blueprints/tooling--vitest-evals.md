---
{ "kind": "tooling", "version": 1, "website": "https://vitest-evals.sentry.dev" }
---

# Add vitest-evals to Flue

You are an AI coding agent adding `vitest-evals` to a Flue project. Create a separate eval suite that exercises the application's public HTTP boundary through `@flue/sdk`. Do not import Flue runtime internals or replace the project's unit-test setup.

## Inspect the project

Read local instructions and detect the package manager. Inspect `package.json`, TypeScript configuration, existing Vitest configuration, agents, workflows, route authentication, CI configuration, and ignore files. Keep eval support files under `src/evals/`, independent of whether Flue application sources use `.flue/`, `src/`, or the project root.

Ask which agent or workflow and which observable behavior should form the starter eval when that is not clear from the project. Do not invent a product requirement merely to produce a passing case.

The primary agent used below must already expose an HTTP route. Do not add an unauthenticated `route` export without confirming that exposing the agent is appropriate. When the application protects its routes, preserve that boundary and configure the SDK client with the required token or headers.

## Install dependencies

Install `@flue/sdk`, `vitest`, and `vitest-evals` as development dependencies using the project's package manager. Preserve existing version and workspace conventions. Do not install a runtime-specific `@vitest-evals/harness-*` package: the custom harness below evaluates the deployed Flue application rather than Flue's underlying model runtime.

## Create the eval configuration

Create `vitest.evals.config.ts` unless the project already has a dedicated eval configuration. Merge equivalent existing configuration instead of replacing it:

```ts title="vitest.evals.config.ts"
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/evals/**/*.eval.ts'],
    reporters: ['default', 'vitest-evals/reporter'],
    testTimeout: 60_000,
  },
});
```

Keep this separate from ordinary unit-test configuration because live-model evals usually need different file discovery, timeouts, credentials, and reporting.

Merge these scripts into `package.json`, preserving existing scripts:

```json
{
  "scripts": {
    "evals": "vitest run --config vitest.evals.config.ts",
    "evals:json": "vitest run --config vitest.evals.config.ts --reporter=vitest-evals/reporter --reporter=json --outputFile.json=vitest-results.json"
  }
}
```

Ensure the project's TypeScript configuration includes `src/evals/**/*.ts` and `vitest.evals.config.ts` when its existing include rules require this. Add `vitest-results.json` to the project's ignore file when adding the JSON script.

## Create the Flue harness

Create `src/evals/harness.ts`:

```ts title="src/evals/harness.ts"
// flue-blueprint: tooling/vitest-evals@1
import { type AttachedAgentEvent, createFlueClient } from '@flue/sdk';
import { createHarness, type SimpleToolCallRecord } from 'vitest-evals';

export interface FlueAgentHarnessOptions {
  agentName: string;
  baseUrl?: string;
  token?: string;
  headers?: Record<string, string>;
}

function collectToolCalls(events: AttachedAgentEvent[]): SimpleToolCallRecord[] {
  const argumentsById = new Map<string, unknown>();

  for (const event of events) {
    if (event.type === 'tool_start') {
      argumentsById.set(event.toolCallId, event.args);
    }
  }

  return events.flatMap((event) => {
    if (event.type !== 'tool') return [];

    return [
      {
        id: event.toolCallId,
        name: event.toolName,
        arguments: argumentsById.get(event.toolCallId),
        ...(event.isError ? { error: event.result } : { result: event.result }),
        durationMs: event.durationMs,
      },
    ];
  });
}

export function createFlueAgentHarness(options: FlueAgentHarnessOptions) {
  const client = createFlueClient({
    baseUrl: options.baseUrl ?? process.env.FLUE_BASE_URL ?? 'http://127.0.0.1:3583',
    token: options.token,
    headers: options.headers,
  });

  return createHarness<string, string>({
    name: `flue-${options.agentName}-agent`,
    run: async ({ input, signal }) => {
      const instanceId = `eval-${crypto.randomUUID()}`;
      const invocation = await client.agents.prompt(options.agentName, instanceId, {
        message: input,
        signal,
      });
      const events: AttachedAgentEvent[] = [];

      for await (const event of client.agents.stream(options.agentName, instanceId, {
        offset: invocation.offset,
        signal,
      })) {
        if (event.submissionId !== invocation.submissionId) continue;

        events.push(event);
        if (event.type === 'idle') break;
      }

      const toolCalls = collectToolCalls(events);

      return {
        output: invocation.result.text,
        toolCalls,
        usage: {
          provider: invocation.result.model.provider,
          model: invocation.result.model.id,
          inputTokens: invocation.result.usage.input,
          outputTokens: invocation.result.usage.output,
          totalTokens: invocation.result.usage.totalTokens,
          toolCalls: toolCalls.length,
          metadata: {
            cacheReadTokens: invocation.result.usage.cacheRead,
            cacheWriteTokens: invocation.result.usage.cacheWrite,
            cost: invocation.result.usage.cost,
          },
        },
        metadata: {
          agent: options.agentName,
          instanceId,
          submissionId: invocation.submissionId,
        },
      };
    },
  });
}
```

The server-provided offset points to the prompt's event sequence. The harness live-tails from that offset, filters by `submissionId`, and stops at the matching terminal `idle` event so asynchronously persisted tool events are not missed. It creates a new agent instance for every `run(...)`; reuse an instance only inside an application-specific harness for a case that intentionally evaluates conversation memory.

Do not remove the abort signal, construct an offset, replace the live read with one immediate catch-up read, or collect events from other submission IDs. Preserve token, cost, tool, instance, and submission metadata unless project-specific data policy requires omitting it.

## Add a starter eval

Create the first eval under `src/evals/` for a behavior the application intentionally supports. Name files by the capability or scenario they evaluate—for example, `src/evals/service-health.eval.ts`—rather than assuming one eval file per agent. Adapt the harness target, input, and assertions to the application instead of copying placeholders:

```ts title="src/evals/service-health.eval.ts"
import { expect } from 'vitest';
import { describeEval, toolCalls } from 'vitest-evals';
import { createFlueAgentHarness } from './harness.ts';

const harness = createFlueAgentHarness({ agentName: 'service-status' });

describeEval('service status agent', { harness }, (it) => {
  it('checks live service status before answering', async ({ run }) => {
    const result = await run('Is the checkout service currently operational?');

    expect(result.output).toContain('operational');
    expect(toolCalls(result).map((call) => call.name)).toContain('get_service_status');
    expect(result.usage.totalTokens).toBeGreaterThan(0);
  });
});
```

Prefer deterministic assertions for exact contracts such as structured output, required tools, prohibited tools, or stable content. Add a `vitest-evals` judge only when the behavior is genuinely semantic. Configure its model separately from the agent under evaluation.

For a workflow, create a project-specific harness around `client.workflows.invoke(name, { payload, wait: 'result' })`. Return the workflow's application-facing result as `output`, and retain `runId` in metadata or artifacts. Do not force workflow behavior through the agent harness.

## Run and report evals

The eval process does not start the Flue application. For local evaluation, start the server in one terminal and wait until it is ready:

```sh
pnpm exec flue dev
```

Then run the evals from a second terminal:

```sh
pnpm run evals
```

To evaluate an existing deployment instead, do not start a local server. Point the suite at the deployed application:

```sh
FLUE_BASE_URL=https://preview.example.com pnpm run evals
```

Use the project's package-manager equivalents. Provider credentials belong to the Flue server process. Authentication credentials for a protected Flue route belong to the SDK client configuration; do not commit either kind of secret.

`pnpm run evals:json` writes `vitest-results.json`. Inspect it with `pnpm exec vitest-evals serve vitest-results.json`, or publish it with the `getsentry/vitest-evals` GitHub Action. `vitest-evals` has no built-in Braintrust reporter. Flue's Braintrust tooling may be enabled independently to trace the application execution, but it does not replace eval cases, assertions, judges, or CI gates.

## Verify

1. Type-check the project and run its existing lint checks.
2. Build the Flue target and confirm the selected agent or workflow is discovered.
3. Start the application with provider credentials and run the starter eval.
4. Confirm the report includes output, usage, the expected tool calls, and Flue correlation metadata.
5. Intentionally break one assertion and confirm the eval command exits non-zero, then restore it.
6. Run against `FLUE_BASE_URL` when deployed-target evaluation is required.
7. If the target is protected, confirm the eval succeeds only with the intended authentication.
8. Review prompts, outputs, tool values, errors, and report artifacts for sensitive data before retaining or uploading them.

When updating an existing integration, inspect and compare it against this complete current blueprint, apply every relevant change while preserving application-specific harnesses, authentication, scripts, and assertions, and then add or update the marker in `src/evals/harness.ts`. This comparison is required when the marker is missing.

## Upgrade Guide

### Version 1 — 2026-06-18

Initial version.
