# Agent Sessions And Operations

Use this when creating continuing agents, direct prompts, dispatched input, sessions, or operation-level calls.

## Created Agent

```ts
import { createAgent } from '@flue/runtime';

export default createAgent(({ id }) => ({
  model: 'anthropic/claude-haiku-4-5',
  instructions: `Help with ticket ${id}.`,
}));
```

- Filename gives the discovered agent name.
- `id` selects one continuing agent instance.
- Application code decides what `id` means and must authorize caller access to it.
- Conversation history belongs to the session store; business data belongs to the application.

## Public Direct Prompt

Export `route` from an agent module to expose:

- `POST /agents/<name>/<id>` for prompts.
- `GET /agents/<name>/<id>` for event streaming.

Use the route handler to authenticate and authorize the selected `id`.

## Dispatch

Use `dispatch(agent, { id, input })` when an accepted application or provider event should enter a continuing agent session asynchronously.

```ts
await dispatch(supportAssistant, {
  id: event.ticketId,
  input: {
    type: 'support.comment.created',
    commentId: event.commentId,
    text: event.text,
  },
});
```

- Application code chooses the agent and instance ID.
- Dispatched input is an agent session operation, not a workflow run.
- Preserve delivery IDs in input when useful for tracing.
- Claim delivery IDs in application storage before dispatch when duplicate admission is unacceptable.

## Harness And Session

Inside workflows or application-controlled execution:

```ts
const harness = await init(agent);
const session = await harness.session();
const response = await session.prompt('Summarize this ticket.');
```

- Use `harness` as the variable name for `init(...)`.
- Use named sessions for parallel or separate conversation branches.
- A session runs one active operation at a time.
- Use structured results when application code depends on fields rather than prose.

## Operation Choices

| Need | Use |
| --- | --- |
| Send text or images to the agent | `session.prompt(...)` |
| Invoke a registered skill | `session.skill(...)` |
| Delegate to a child session or subagent | `session.task(...)` |
| Run command output into session context | `session.shell(...)` |
| Stage or collect workspace files outside conversation | `harness.fs` |
| Prepare workspace without adding conversation messages | `harness.shell(...)` |

