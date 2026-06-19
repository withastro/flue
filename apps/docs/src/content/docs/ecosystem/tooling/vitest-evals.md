---
title: Vitest Evals
description: Add repeatable agent and workflow evals to a Flue project with vitest-evals.
lastReviewedAt: 2026-06-18
---

## Quickstart

Add the [`vitest-evals`](https://vitest-evals.sentry.dev/docs) setup blueprint to an existing Flue project:

```sh
flue add tooling vitest-evals
```

The blueprint guides your coding agent through installing the test dependencies, creating a dedicated eval configuration, adapting Flue's public SDK to a `vitest-evals` harness, and writing a starter case for behavior already defined by your application.

## Overview

`vitest-evals` adds eval harnesses, judges, normalized reports, and CI reporting to Vitest. The Flue integration evaluates the same public HTTP boundary used by a deployed application rather than importing Flue runtime internals.

The generated harness:

- prompts an HTTP-exposed agent through `@flue/sdk`;
- gives each eval case a fresh agent instance;
- captures the prompt's event sequence using its server-provided offset and submission ID;
- records response text, model usage, costs, and tool calls in the normalized eval result;
- supports local servers and deployed applications through `FLUE_BASE_URL`.

The blueprint does not expose an existing agent automatically. Confirm that the agent's `route` export and its authentication are appropriate before evaluating it over HTTP.

## Run evals

Start the Flue application in one terminal:

```sh
pnpm exec flue dev
```

After the server is ready, run evals in another terminal:

```sh
pnpm run evals
```

The server process needs the application's normal model-provider credentials. To evaluate a deployment, set its public mount URL:

```sh
FLUE_BASE_URL=https://preview.example.com pnpm run evals
```

Configure a token or request headers in the SDK client when the target is protected. Never commit provider or application credentials.

## Reports

The blueprint adds commands for compact terminal output, detailed tool and usage output, and a JSON artifact. Open the JSON report locally with:

```sh
pnpm exec vitest-evals serve vitest-results.json
```

The same artifact can be published by the `getsentry/vitest-evals` GitHub Action. Reports can contain prompts, outputs, tool arguments and results, errors, and application metadata; review retention and access requirements before uploading them.

`vitest-evals` does not include a Braintrust reporter. Flue's [Braintrust integration](/docs/ecosystem/tooling/braintrust/) can independently trace the application execution, but those traces do not replace eval cases, assertions, judges, or CI gates.

## Next steps

See [Evals](/docs/guide/evals/) for designing cases, choosing deterministic assertions or judges, evaluating workflows, and understanding the harness. A complete runnable project is available in [`examples/vitest-evals`](https://github.com/withastro/flue/tree/main/examples/vitest-evals).
