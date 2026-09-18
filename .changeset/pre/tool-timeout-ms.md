---
'@flue/runtime': minor
---

Tools can now declare a `timeoutMs` execution bound: on expiry the harness aborts the tool's `context.signal` and settles the call with a `ToolTimeoutError` (the model sees `Tool "<name>" timed out after <ms>ms` and the conversation continues) instead of letting one hung call consume the submission's durability budget.

```ts
import { defineTool } from '@flue/runtime';
import * as v from 'valibot';

export const lookupCatalog = defineTool({
  name: 'lookup_catalog',
  description: 'Query the upstream catalog API.',
  input: v.object({ sku: v.string() }),
  timeoutMs: 15_000,
  async run({ data, signal }) {
    // If this call exceeds 15s, `signal` aborts, the call settles with a
    // ToolTimeoutError the model sees, and the conversation continues —
    // the model can retry or change approach.
    const response = await fetch(`https://catalog.example.com/${data.sku}`, { signal });
    return { output: await response.json() };
  },
});
```
