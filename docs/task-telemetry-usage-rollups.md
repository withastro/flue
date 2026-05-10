# Task Telemetry and Usage Rollups

Status: Draft proposal

## What Hurts

When a parent agent asks a child agent to do work, Flue should not lose the receipt.

Today we can see that a task ran. We cannot reliably answer the simple follow-up questions: which model did the child use, how long did it take, how many tokens did it spend, what did it cost, and does the parent response include that child work?

That is the problem. Delegation looks cheap when the bill is hidden.

## What Other Harnesses Usually Do

- [Claude Managed Agents](https://platform.claude.com/docs/en/managed-agents/observability) shows session traces in the Claude Console and exposes [raw session events](https://platform.claude.com/docs/en/managed-agents/events-and-streaming). It also reports cumulative session usage after the session goes idle. Good visibility, but the contract belongs to Anthropic's hosted runtime.
- [OpenAI Agents SDK](https://openai.github.io/openai-agents-js/guides/tracing/) has built-in traces and spans for runs, agents, model calls, tool calls, guardrails, and handoffs. It is strong tracing, but it is still the SDK's trace pipeline, not Flue's own usage contract.
- [LangGraph](https://docs.langchain.com/oss/javascript/langgraph/persistence) makes workflow state explicit with threads and checkpoints. That is excellent for replay and human-in-the-loop flows, but token and cost rollups are not the main primitive.
- [CrewAI](https://docs.crewai.com/en/observability/overview) points users at AMP and observability integrations like Langfuse, OpenLIT, MLflow, Arize Phoenix, and others. Useful, but again the accounting sits outside the harness core.

## What Flue Can Do Better

Flue is at the right layer to fix this. It is the runtime that creates the child session. It knows the parent, the task id, the role, the cwd, the model, the duration, and the usage.

So Flue should record that once, in the same shape no matter which model provider is used. The runtime should own causality and accounting. Dashboards and billing tools can plug in later.

```text
User / webhook
  |
  v
Parent prompt() or skill()
  |
  | calls built-in task tool
  v
Child task session
  |
  | emits usage + model + duration
  |
  +--> task_end event --> CLI / SSE / traces / TokenOps / FinOps
  |
  +--> usage rollup ----> returned parent PromptResponse
```

## What Stays Pluggable

The core contract stays small: normalized task events, `PromptUsage`, `PromptModel`, timing metadata, and parent-child session ids. Everything else can plug in around that contract:

- CLI renderer for humans during `flue run`;
- SSE stream consumers for live dashboards;
- OpenTelemetry or Langfuse adapters for tracing systems;
- TokenOps rollups by task, role, model, and workflow;
- FinOps attribution by delegated task, failed task, or parent workflow.

Observability vendors, dashboards, and budget policies remain replaceable.

## Goals

- Make task start/end events useful for humans and machines.
- Attribute child task usage to the task that produced it.
- Roll direct child task usage into parent prompt/skill usage when the task was invoked through the built-in `task` tool.
- Render concise task telemetry in `flue run`.
- Establish the accounting substrate for future TokenOps and FinOps reporting.
- Keep the implementation small and compatible with the current session model.

## Non-Goals

- A full `flue inspect` command.
- Persistent task telemetry indexes.
- Budget enforcement.
- Declarative managed-agent rosters.
- Artifact-channel protocols.

Those are natural follow-ups, but this proposal is the first telemetry layer they would build on.

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

When the built-in `task` tool completes, the tool result should expose the same telemetry in its details payload:

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

This gives raw event consumers the information even before the parent prompt finishes.

## Usage Rollup Semantics

There are two task entry points with different accounting expectations.

### Direct `session.task()`

When user code calls `session.task()` directly, the returned child response already has its own usage.

```ts
const child = await session.task('Research the parser.');
console.log(child.usage.totalTokens);
```

No parent prompt usage should be modified, because there is no enclosing model turn that caused the delegation.

### Built-In `task` Tool

When the parent model invokes the built-in `task` tool during `prompt()` or `skill()`, the parent response should include:

```text
parent assistant usage + direct child task usage
```

This makes the returned usage describe the actual cost of that single parent call.

Nested tasks should roll up one level at a time. If child A invokes child B, child A's response usage includes child B once. The parent then adds child A's usage once. The parent should not separately walk child B again.

## TokenOps and FinOps

Task telemetry is also the lowest useful accounting unit for TokenOps and FinOps.

At the TokenOps layer, enriched task events let users understand token burn by:

- task or subagent;
- role;
- model;
- working directory or workspace;
- parent session or workflow;
- success versus failure path.

At the FinOps layer, the same data supports cost attribution and governance:

- cost per delegated task;
- cost per parent workflow including delegated child work;
- expensive role/model combinations;
- failed-task spend;
- long-running task duration versus token cost;
- future budget alerts or policy enforcement.

This proposal does not add a FinOps dashboard or budget controls. It makes sure the first telemetry contract preserves enough structure for those features to be built later without changing the meaning of task usage.

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

The CLI should omit unavailable fields rather than printing zero placeholders. Descriptions or prompts should be truncated for log readability.

## Implementation Shape

Likely change points:

- `packages/sdk/src/types.ts`
  - Enrich `FlueEvent` task event variants.
- `packages/sdk/src/agent.ts`
  - Extend `TaskToolResultDetails`.
- `packages/sdk/src/session.ts`
  - Time tasks in `runTask()`.
  - Extract child `usage` and `model` from `PromptResponse` and `PromptResultResponse`.
  - Keep a parent-call-scoped direct-child usage accumulator for built-in task tool calls.
  - Add accumulated child usage in `aggregateUsageSince(...)`.
- `packages/cli/bin/flue.ts`
  - Render `task_start` and `task_end`.

## Open Questions

- Should `description` be added to the public `session.task()` options, or only remain a field from the built-in task tool parameters?
- Should failed tasks attempt to report partial child usage, or should failed parent calls keep failing without partial accounting?
- Should task usage rollups be visible as a separate field in the parent response later, rather than only included in aggregate `usage`?
- Do we want the task event `result` field to remain freeform, or should it get a narrower text/error shape in a later API cleanup?
