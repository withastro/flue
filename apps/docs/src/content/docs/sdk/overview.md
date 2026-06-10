---
title: SDK overview
description: Reference for consuming deployed Flue agents and workflows with @flue/sdk.
---

The client SDK is exported from `@flue/sdk`. Use it from applications that consume deployed Flue agents and workflows.

```ts
import { createFlueClient } from '@flue/sdk';

const client = createFlueClient({
  baseUrl: 'https://example.com/api',
  token: process.env.FLUE_TOKEN,
});
```

## Client

[`createFlueClient(...)`](/docs/sdk/client/) configures access to a deployed Flue application.

## API namespaces

- [`client.agents`](/docs/sdk/agents/) invokes persistent agent instances and streams their events.
- [`client.workflows`](/docs/sdk/workflows/) starts workflow runs.
- [`client.runs`](/docs/sdk/runs/) inspects and streams workflow runs.
- [`client.admin`](/docs/sdk/admin/) reads agent discovery metadata and workflow-run records from an explicitly mounted admin route.

## Shared types

- [Events and records](/docs/sdk/events/) describes observable events, records, and normalized model-turn data.
- [Errors](/docs/sdk/errors/) describes HTTP and stream errors.
