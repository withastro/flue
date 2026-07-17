---
title: Subagents
description: Let agents delegate focused work to named specialists.
lastReviewedAt: 2026-05-29
---

Subagents let an agent delegate a piece of work to a named specialist while it continues to own the interaction. Use them when an agent should ask another configured role to research, classify, or review something and then work with the returned answer.

A subagent is an [agent profile](/docs/guide/building-agents/#agent-profiles) declared on another agent. Delegated work runs in a separate child session, rather than continuing the parent agent's conversation history. The subagent is not a separately addressable agent endpoint — it has no `/agents/:name/:id` route — but the parent can hold a multi-turn conversation with it in process. Use `task()` for a single delegated question, or `spawn()` to keep the child alive across several prompts (see [Hold a conversation with a subagent](#hold-a-conversation-with-a-subagent)).

## Define a subagent

Create a named profile with `defineAgentProfile(...)`, then provide it through an agent's `subagents` configuration:

```ts title="src/agents/support-assistant.ts"
import { defineAgent, defineAgentProfile } from '@flue/runtime';

const issueClassifier = defineAgentProfile({
  name: 'issue_classifier',
  description: 'Classifies support issues for routing.',
  instructions: 'Return the likely product area and urgency for the reported issue.',
});

export default defineAgent(() => ({
  model: 'anthropic/claude-sonnet-4-6',
  instructions: 'Help resolve support requests. Delegate classification when it helps your answer.',
  subagents: [issueClassifier],
}));
```

In this example, `support-assistant` can delegate work to `issue_classifier`. The profile configures the specialist used for delegated tasks; it does not define another agent at `/agents/issue_classifier/:id`.

The profile's `description` is shown to the parent model alongside the subagent's name, so write it as delegation guidance: a short statement of what the subagent is good for.

## Delegate work

An agent with configured subagents can decide to delegate while answering a prompt. Flue gives the agent a built-in `task` capability that starts a child session for the selected subagent and returns that child's answer to the parent agent.

The child session receives the delegated request and its own configured context, not the parent's existing conversation transcript. When persistence is configured, its retained history remains owned by the parent session rather than becoming an ordinary named session. See [Database](/docs/guide/database/) for persistence setup. When a subagent works in a configured sandbox, it uses that same sandbox boundary as its parent. See [Sandboxes](/docs/guide/sandboxes/) for controlling workspace and command access.

## Hold a conversation with a subagent

`task()` delegates a single prompt and disposes the child. When application code needs a back-and-forth with a specialist — ask, read the answer, then follow up while the child keeps its context — call `session.spawn(...)`. It returns a `SubagentHandle` whose lifecycle you own: prompt it as many times as you like, then close it.

```ts title="src/workflows/investigate.ts"
async run({ harness }) {
  const session = await harness.session();

  await using researcher = await session.spawn({ agent: 'researcher' });
  const diagnosis = await researcher.prompt('Diagnose the failing test in auth.ts.');
  const scope = await researcher.prompt('Does main have the same bug?'); // remembers the diagnosis

  return { diagnosis: diagnosis.text, scope: scope.text };
  // The child session closes when `researcher` is disposed at scope exit.
}
```

The handle exposes the child session's `prompt()`, `skill()`, `task()`, `shell()`, and `fs` surface, so a spawned specialist can use skills and tools across the conversation just like a top-level session. Each `prompt()` accepts the same options as `session.prompt()`, including `result` for validated structured data.

Spawn shares everything `task()` does: the child is a detached, parent-owned session with the selected profile's configuration (see [Configuration inheritance](#configuration-inheritance)), running inside the parent's sandbox. It differs only in lifecycle — you decide when the conversation ends. Because the handle is `AsyncDisposable`, `await using` closes it automatically on scope exit; you can also call `await researcher.close()` explicitly. Closing is idempotent. Omit `options.agent` to spawn an agent-less child that reuses the parent's full configuration in a fresh conversation.

Like a programmatic `task()`, a spawned child carries no parent `task` tool call, so it lives only for the current process and is not restored by durable subagent recovery. Close handles when you are done with them so their child sessions do not stay open for the life of the parent session.

## Configuration inheritance

A subagent profile is self-contained. The capability fields that define what the subagent is and can do apply only when the profile declares them — omitting one means the subagent has none, never the parent's. Environment fields fall back to the parent's values as runtime defaults.

| Field                                          | Behavior                                                                                                                                          |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `instructions`, `tools`, `skills`, `subagents` | Profile-owned. Only the profile's own declarations apply; an omitted field means none. The parent's values never flow into the delegated session. |
| `model`, `thinkingLevel`, `compaction`         | Inherits as a default. The profile's own value wins when declared; an omitted field uses the parent's value.                                      |
| `durability`                                   | Rejected. Delegated task sessions run inside the parent operation, so declaring `durability` on a subagent profile is a definition-time error.    |

A `task()` call without an `agent` name is not a subagent delegation: the child session reuses the parent's full configuration in a fresh context.

## Use subagents in workflows

A workflow can choose delegation directly when application logic requires work from a particular subagent. Call `session.task(...)` with the name of a declared subagent, and provide `result` when the workflow needs validated data:

```ts title="src/workflows/review-change.ts"
import { defineAgent, defineWorkflow, defineAgentProfile } from '@flue/runtime';
import * as v from 'valibot';

const reviewer = defineAgentProfile({
  name: 'reviewer',
  instructions: 'Review the proposed change and identify concrete correctness risks.',
});

const coordinator = defineAgent(() => ({
  model: 'anthropic/claude-sonnet-4-6',
  subagents: [reviewer],
}));

const Review = v.object({
  summary: v.string(),
  risks: v.array(v.string()),
});

export default defineWorkflow({
  agent: coordinator,
  input: v.object({ change: v.string() }),
  output: Review,

  async run({ harness, input }) {
    const response = await (
      await harness.session()
    ).task(input.change, {
      agent: 'reviewer',
      result: Review,
    });
    return response.data;
  },
});
```

Here, the workflow chooses `reviewer` rather than leaving delegation to the parent agent. See [Workflows](/docs/guide/workflows/) for workflow orchestration and the [Agent API](/docs/api/agent-api/) for task options and result types.

## Next steps

- [Agents](/docs/guide/building-agents/) — create agents and reusable agent profiles.
- [Workflows](/docs/guide/workflows/) — orchestrate finite agent work in application code.
- [Tools](/docs/guide/tools/) and [Skills](/docs/guide/skills/) — give an agent profile capabilities and reusable instructions.
- [Sandboxes](/docs/guide/sandboxes/) — control the workspace available during delegated work.
- [Agent API](/docs/api/agent-api/) — look up `session.task(...)` options and results.
- [Observability](/docs/guide/observability/) — inspect delegated activity alongside other agent work.
