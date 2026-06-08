---
title: Subagents
description: Let agents delegate focused work to named specialists.
lastReviewedAt: 2026-05-29
---

Subagents let an agent delegate a piece of work to a named specialist while it continues to own the interaction. Use them when an agent should ask another configured role to research, classify, or review something and then work with the returned answer.

A subagent is an [agent profile](/docs/guide/building-agents/#agent-profiles) declared on another agent. Delegated work runs in a separate child session, rather than continuing the parent agent's conversation history. The subagent is not a separately addressable agent endpoint.

## Define a subagent

Create a named profile with `defineAgentProfile(...)`, then provide it through an agent's `subagents` configuration:

```ts title="src/agents/support-assistant.ts"
import { createAgent, defineAgentProfile } from '@flue/runtime';

const issueClassifier = defineAgentProfile({
  name: 'issue_classifier',
  description: 'Classifies support issues for routing.',
  instructions: 'Return the likely product area and urgency for the reported issue.',
});

export default createAgent(() => ({
  model: 'anthropic/claude-sonnet-4-6',
  instructions: 'Help resolve support requests. Delegate classification when it helps your answer.',
  subagents: [issueClassifier],
}));
```

In this example, `support-assistant` can delegate work to `issue_classifier`. The profile configures the specialist used for delegated tasks; it does not define another agent at `/agents/issue_classifier/:id`.

## Delegate work

An agent with configured subagents can decide to delegate while answering a prompt. Flue gives the agent a built-in `task` capability that starts a child session for the selected subagent and returns that child's answer to the parent agent.

The child session receives the delegated request and its own configured context, not the parent's existing conversation transcript. When persistence is configured, its retained history remains owned by the parent session rather than becoming an ordinary named session. See [Database](/docs/guide/database/) for persistence setup. When a subagent works in a configured sandbox, it uses that same sandbox boundary as its parent. See [Sandboxes](/docs/guide/sandboxes/) for controlling workspace and command access.

## Use subagents in workflows

A workflow can choose delegation directly when application logic requires work from a particular subagent. Call `session.task(...)` with the name of a declared subagent, and provide `result` when the workflow needs validated data:

```ts title="src/workflows/review-change.ts"
import { createAgent, defineAgentProfile, type FlueContext } from '@flue/runtime';
import * as v from 'valibot';

const reviewer = defineAgentProfile({
  name: 'reviewer',
  instructions: 'Review the proposed change and identify concrete correctness risks.',
});

const coordinator = createAgent(() => ({
  model: 'anthropic/claude-sonnet-4-6',
  subagents: [reviewer],
}));

const Review = v.object({
  summary: v.string(),
  risks: v.array(v.string()),
});

export async function run({ init, payload }: FlueContext<{ change: string }>) {
  const harness = await init(coordinator);
  const session = await harness.session();
  const response = await session.task(payload.change, {
    agent: 'reviewer',
    result: Review,
  });

  return response.data;
}
```

Here, the workflow chooses `reviewer` rather than leaving delegation to the parent agent. See [Workflows](/docs/guide/workflows/) for workflow orchestration and the [Agent API](/docs/api/agent-api/) for task options and result types.

## Next steps

- [Agents](/docs/guide/building-agents/) — create agents and reusable agent profiles.
- [Workflows](/docs/guide/workflows/) — orchestrate finite agent work in application code.
- [Tools](/docs/guide/tools/) and [Skills](/docs/guide/skills/) — give an agent profile capabilities and reusable instructions.
- [Sandboxes](/docs/guide/sandboxes/) — control the workspace available during delegated work.
- [Agent API](/docs/api/agent-api/) — look up `session.task(...)` options and results.
- [Observability](/docs/guide/observability/) — inspect delegated activity alongside other agent work.
