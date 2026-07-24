---
{ "kind": "tooling", "version": 1, "website": "https://vitest-evals.sentry.dev" }
---

# Add vitest-evals to Flue

You are an AI coding agent adding `vitest-evals` to a Flue project. Create a separate eval suite that exercises the application's public HTTP boundary through `@flue/sdk`. Do not import Flue runtime internals or replace the project's unit-test setup.

## Inspect the project

Read local instructions and detect the package manager. Inspect `package.json`, TypeScript configuration, existing Vitest configuration, agent modules, the `app.ts` route map, route authentication, CI configuration, and ignore files. Keep eval support files under `src/evals/`, independent of whether Flue application sources use `.flue/`, `src/`, or the project root.

Ask which agent and which observable behavior should form the starter eval when that is not clear from the project. Do not invent a product requirement merely to produce a passing case.

The primary agent used below must already be mounted on an HTTP route by the application's `app.ts` (`app.route('/agents/<name>', createAgentRouter(<AgentFn>))`). Do not mount an unauthenticated agent route without confirming that exposing the agent is appropriate. When the application protects its routes, preserve that boundary and configure the SDK client with the required token or headers.

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
import { createFlueClient, type FlueConversationMessage } from '@flue/sdk';
import { createHarness, type SimpleToolCallRecord } from 'vitest-evals';

export interface FlueAgentHarnessOptions {
  /**
   * Absolute URL where the agent's routes are mounted (wherever the
   * application's app.ts mounts `createAgentRouter(...)`). Each eval case runs in a
   * fresh conversation at `<agentUrl>/eval-<uuid>`.
   */
  agentUrl: string;
  /** Harness display name; defaults to the agent URL's last path segment. */
  name?: string;
  token?: string;
  headers?: Record<string, string>;
}

function lastAssistantMessage(
  messages: FlueConversationMessage[],
): FlueConversationMessage | undefined {
  return messages.findLast((entry) => entry.role === 'assistant');
}

function messageText(message: FlueConversationMessage | undefined): string {
  if (!message) return '';
  return message.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

function collectToolCalls(messages: FlueConversationMessage[]): SimpleToolCallRecord[] {
  return messages.flatMap((message) =>
    message.parts.flatMap((part) => {
      if (part.type !== 'dynamic-tool') return [];
      return [
        {
          id: part.toolCallId,
          name: part.toolName,
          arguments: part.input,
          ...(part.state === 'output-error'
            ? { error: part.errorText }
            : part.state === 'output-available'
              ? { result: part.output }
              : {}),
        },
      ];
    }),
  );
}

export function createFlueAgentHarness(options: FlueAgentHarnessOptions) {
  const agentUrl = options.agentUrl.replace(/\/+$/, '');
  const agentName = options.name ?? (agentUrl.split('/').at(-1) as string);

  return createHarness<string, string>({
    name: `flue-${agentName}-agent`,
    run: async ({ input, signal }) => {
      // A fresh conversation per case: the caller constructs the URL by
      // appending a new id to the agent's mount URL.
      const conversation = createFlueClient({
        url: `${agentUrl}/eval-${crypto.randomUUID()}`,
        token: options.token,
        headers: options.headers,
      });
      const admission = await conversation.send({
        message: { kind: 'user', body: input },
        signal,
      });
      await conversation.wait(admission, { signal });
      const history = await conversation.history({ signal });
      const reply = lastAssistantMessage(history.messages);
      const usage = reply?.metadata?.usage;
      const model = reply?.metadata?.model;

      return {
        output: messageText(reply),
        toolCalls: collectToolCalls(history.messages),
        // The reply's own message metadata carries usage/model — the same
        // data the removed prompt-result surface used to return.
        ...((usage ?? model)
          ? {
              usage: {
                ...(model ? { provider: model.provider, model: model.id } : {}),
                ...(usage
                  ? {
                      inputTokens: usage.input,
                      outputTokens: usage.output,
                      totalTokens: usage.totalTokens,
                      metadata: { cost: usage.cost.total },
                    }
                  : {}),
              },
            }
          : {}),
      };
    },
  });
}
```

Agent prompts are fire-and-forget: `send()` admits the prompt and `wait()` only awaits completion, so the following `history()` snapshot — read after `wait()` resolves — contains the completed messages and tool activity for that fresh conversation. The `agentUrl` is the agent's mount URL, taken from where the application's `app.ts` mounts the agent's router (`createAgentRouter(...)`) — derive it from the route map, not from the agent's name. The harness opens a new conversation for every `run(...)` by appending a fresh id to that mount URL; reuse a conversation id only inside an application-specific harness for a case that intentionally evaluates conversation memory.

Do not remove the abort signal or derive tool calls from runtime-internal events. Preserve output, token usage, cost, and tool activity unless project-specific data policy requires omitting them.

## Add a starter eval

Create the first eval under `src/evals/` for a behavior the application intentionally supports. Name files by the capability or scenario they evaluate—for example, `src/evals/service-health.eval.ts`—rather than assuming one eval file per agent. Adapt the harness target, input, and assertions to the application instead of copying placeholders:

```ts title="src/evals/service-health.eval.ts"
import { expect } from 'vitest';
import { describeEval, toolCalls } from 'vitest-evals';
import { createFlueAgentHarness } from './harness.ts';

// The conversation URL base: where app.ts mounts the agent. Point
// FLUE_AGENT_URL at a deployed application to evaluate it instead.
const harness = createFlueAgentHarness({
  agentUrl: process.env.FLUE_AGENT_URL ?? 'http://127.0.0.1:3583/agents/service-status',
});

describeEval('Flue service status agent', { harness }, (it) => {
  it('checks live service status before answering', async ({ run }) => {
    const result = await run('Is the checkout service currently operational?');

    expect(result.output).toContain('operational');
    expect(toolCalls(result).map((call) => call.name)).toContain('get_service_status');
    expect(result.usage.totalTokens).toBeGreaterThan(0);
  });
});
```

Adapt the fallback `agentUrl` to the project: use the local dev server's actual origin (Vite's default port is 5173 unless `vite.config.ts` sets `server.port`) and the agent's mount path from `app.ts`.

Prefer deterministic assertions for exact contracts such as structured output, required tools, prohibited tools, or stable content. Add a `vitest-evals` judge only when the behavior is genuinely semantic. Configure its model separately from the agent under evaluation.

For a bounded, structured job, evaluate the agent that exposes it as a harness tool (`useTool({ harness: true })`) through this same conversation-URL harness: send the message that triggers the tool and assert on its tool call and the final reply. Do not invent a separate invocation path for it.

## Run and report evals

The eval process does not start the Flue application. For local evaluation, start the server in one terminal and wait until it is ready:

```sh
pnpm exec vite dev
```

Then run the evals from a second terminal:

```sh
pnpm run evals
```

To evaluate an existing deployment instead, do not start a local server. Point the harness at the agent's mount URL on the deployed application:

```sh
FLUE_AGENT_URL=https://preview.example.com/agents/service-status pnpm run evals
```

Use the project's package-manager equivalents. Provider credentials belong to the Flue server process. Authentication credentials for a protected Flue route belong to the SDK client configuration; do not commit either kind of secret.

`pnpm run evals:json` writes `vitest-results.json`. Inspect it with `pnpm exec vitest-evals serve vitest-results.json`, or publish it with the `getsentry/vitest-evals` GitHub Action. `vitest-evals` has no built-in Braintrust reporter. Flue's Braintrust tooling may be enabled independently to trace the application execution, but it does not replace eval cases, assertions, judges, or CI gates.

## Verify

1. Type-check the project and run its existing lint checks.
2. Build the project with `vite build` and confirm the selected agent module is discovered.
3. Start the application with provider credentials and run the starter eval.
4. Confirm the report includes output, usage, and the expected tool calls.
5. Intentionally break one assertion and confirm the eval command exits non-zero, then restore it.
6. Run against `FLUE_AGENT_URL` when deployed-target evaluation is required.
7. If the target is protected, confirm the eval succeeds only with the intended authentication.
8. Review prompts, outputs, tool values, errors, and report artifacts for sensitive data before retaining or uploading them.

When updating an existing integration, inspect and compare it against this complete current blueprint, apply every relevant change while preserving application-specific harnesses, authentication, scripts, and assertions, and then add or update the marker in `src/evals/harness.ts`. This comparison is required when the marker is missing.

## Upgrade Guide

### Version 1 — 2026-06-18

Initial version.
