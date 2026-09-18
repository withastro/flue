---
'@flue/runtime': minor
---

Tools returned by `createMcpConnection()` now retain the metadata sent by the MCP server in its `tools/list` response. The metadata is available on each Flue tool as `tool.annotations`:

```ts
const connection = await createMcpConnection(definition);
const deleteIssue = connection.tools.find((tool) => tool.name.endsWith('delete_issue'));

console.log(deleteIssue?.annotations?.destructiveHint); // true
```

`defineTool()` and `useTool()` also accept `annotations`, so wrappers can carry the metadata forward. Flue does not automatically change a tool's behavior based on these server-supplied values.
