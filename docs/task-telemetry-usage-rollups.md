# Task Telemetry and Usage Rollups

Status: Draft proposal

## Problem

Flue already has delegated child agents through `session.task()` and the built-in
LLM-facing `task` tool. That is the right primitive for managed-agent workflows,
but delegated work is still too opaque.

Today, a caller can see that a task started or ended, but not enough operational
detail to answer:

- Which task ran, under which role and cwd?
- How long did the task take?
- Which model did the child use?
- How many tokens and dollars did the child spend?
- Does the parent prompt usage include delegated child work?

This matters because task delegation is one of Flue's strongest managed-agent
building blocks. If task cost and timing are not first-class, users cannot debug
multi-agent behavior or trust reported usage.

## Goals

- Make task start/end events useful for humans and machines.
- Attribute child task usage to the task that produced it.
- Roll direct child task usage into parent prompt/skill usage when the task was
  invoked through the built-in `task` tool.
- Render concise task telemetry in `flue run`.
- Keep the implementation small and compatible with the current session model.

## Non-Goals

- A full `flue inspect` command.
- Persistent task telemetry indexes.
- Budget enforcement.
- Declarative managed-agent rosters.
- Artifact-channel protocols.

Those are natural follow-ups, but this proposal is the first telemetry layer
they would build on.

## Proposed Event Types

The current task events are:

```ts
type FlueTaskStartEvent = {
  type: 'task_start';
  taskId: string;
  prompt: string;
  role?: string;
  cwd?: string;
};

type FlueTaskEndEvent = {
  type: 'task_end';
  taskId: string;
  isError: boolean;
  result?: unknown;
};
```

The proposed enriched events are:

```ts
type FlueTaskStartEvent = {
  type: 'task_start';
  taskId: string;
  prompt: string;
  description?: string;
  role?: string;
  cwd?: string;
  startedAt: string;
};

type FlueTaskEndEvent = {
  type: 'task_end';
  taskId: string;
  isError: boolean;
  result?: unknown;
  usage?: PromptUsage;
  model?: PromptModel;
  durationMs: number;
  endedAt: string;
};
```

These events still receive the existing shared event fields:

```ts
type FlueEventMetadata = {
  sessionId?: string;
  parentSessionId?: string;
  taskId?: string;
};
```

## Task Tool Details

When the built-in `task` tool completes, the tool result should expose the same
telemetry in its details payload:

```ts
interface TaskToolResultDetails {
  taskId: string;
  sessionId: string;
  messageId?: string;
  role?: string;
  cwd?: string;
  usage?: PromptUsage;
  model?: PromptModel;
  durationMs: number;
}
```

This gives raw event consumers the information even before the parent prompt
finishes.

## Usage Rollup Semantics

There are two task entry points with different accounting expectations.

### Direct `session.task()`

When user code calls `session.task()` directly, the returned child response
already has its own usage.

```ts
const child = await session.task('Research the parser.');
console.log(child.usage.totalTokens);
```

No parent prompt usage should be modified, because there is no enclosing model
turn that caused the delegation.

### Built-In `task` Tool

When the parent model invokes the built-in `task` tool during `prompt()` or
`skill()`, the parent response should include:

```text
parent assistant usage + direct child task usage
```

This makes the returned usage describe the actual cost of that single parent
call.

Nested tasks should roll up one level at a time. If child A invokes child B,
child A's response usage includes child B once. The parent then adds child A's
usage once. The parent should not separately walk child B again.

## CLI Rendering

`flue run` should render task events in the same compact spirit as tool events.

Task start:

```text
[flue] task:start  Research auth flow  role=researcher cwd=/workspace/project
```

Task success:

```text
[flue] task:done   7.4s  tokens=12,430  cost=$0.0182
```

Task error:

```text
[flue] task:error  1.2s  No model configured for this prompt() call.
```

The CLI should omit unavailable fields rather than printing zero placeholders.
Descriptions or prompts should be truncated for log readability.

## Implementation Shape

Likely change points:

- `packages/sdk/src/types.ts`
  - Enrich `FlueEvent` task event variants.
- `packages/sdk/src/agent.ts`
  - Extend `TaskToolResultDetails`.
- `packages/sdk/src/session.ts`
  - Time tasks in `runTask()`.
  - Extract child `usage` and `model` from `PromptResponse` and
    `PromptResultResponse`.
  - Keep a parent-call-scoped direct-child usage accumulator for built-in task
    tool calls.
  - Add accumulated child usage in `aggregateUsageSince(...)`.
- `packages/cli/bin/flue.ts`
  - Render `task_start` and `task_end`.

## Open Questions

- Should `description` be added to the public `session.task()` options, or only
  remain a field from the built-in task tool parameters?
- Should failed tasks attempt to report partial child usage, or should failed
  parent calls keep failing without partial accounting?
- Should task usage rollups be visible as a separate field in the parent response
  later, rather than only included in aggregate `usage`?
- Do we want the task event `result` field to remain freeform, or should it get a
  narrower text/error shape in a later API cleanup?
