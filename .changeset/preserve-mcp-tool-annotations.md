---
'@flue/runtime': minor
---

MCP tools now preserve the server's `annotations` metadata on their Flue tool definitions, so trusted application code can inspect hints such as `readOnlyHint`, `destructiveHint`, and `idempotentHint` before mounting or approving a tool:

```ts
const connection = await createMcpConnection(definition);
const safeTools = connection.tools.filter((tool) => tool.annotations?.readOnlyHint);
```

`defineTool()` and `useTool()` also accept MCP-compatible annotations for wrappers and hand-written tools. The hints do not alter execution and should not be treated as a security boundary unless the MCP server is trusted.
