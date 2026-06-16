# Observability And Errors

Use this when inspecting work, exporting telemetry, or handling Flue errors.

## Workflow Run Inspection

- Each workflow invocation has a `runId`.
- `flue logs <runId> --server <url>` inspects workflow runs.
- `flue logs` does not inspect direct agent prompts or dispatched agent input.
- Use workflow `log.info`, `log.warn`, and `log.error` for application-specific facts.
- Logs accept structured attributes for search and aggregation.

## Observe Application Activity

Register `observe(...)` in `app.ts` to monitor workflows and continuing agents handled by that running application context.

```ts
observe((event) => {
  if (event.type === 'run_end' && event.isError) {
    console.error('Workflow failed', event.runId, event.error);
  }
});
```

- Branch on `event.type`.
- Treat events as read-only.
- Return immediately for events you do not consume.
- Keep callbacks lightweight; returned promises are observed for rejection but not awaited.
- In distributed deployments, each context observes only activity it handles.

## Event Boundaries

| Boundary | Meaning |
| --- | --- |
| Workflow run | Finite workflow invocation and its persisted run history. |
| Operation | Prompt, skill, task, shell, or compact call inside agent activity. |
| Turn | One nested model round trip. |

Streaming deltas are best-effort live progress. `message_end` is the authoritative completed assistant message.

## Privacy

Events can contain payloads, prompts, model messages, logs, tool values, errors, and application metadata. Flue omits recognized image bytes, but arbitrary payloads and logs still need application-owned sanitization.

Start with outcome-oriented signals: failed workflows, explicit application error logs, slow operations, and completed usage. Do not alert on every nested model/tool error when the agent can recover.

## Error Conventions In This Repo

- Throw structured error classes from `packages/runtime/src/errors.ts`.
- Do not add ad-hoc `new Error('[flue] ...')` in runtime code.
- Put machine-readable fields in `details`.
- Put developer-only setup mechanics, paths, and guidance in `dev`.
- Caller-visible messages are not API.
- Tests should assert on error class and structured data, not message text.

