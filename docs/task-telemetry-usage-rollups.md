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

Flue is at the right layer to fix this. It is the runtime that creates the child session. It knows the parent, the task id, the role, the cwd, the model, the duration, the usage, and the outputs produced by that work.

So Flue should record that once, in the same shape no matter which model provider is used. The primitive is not a log line. It is a small work record: identity, parentage, timing, usage, and optional outputs. The runtime should own causality and accounting. Dashboards and billing tools can plug in later.

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

## Shared Primitive: Work Records

Task telemetry and artifact channels should meet at one tiny runtime primitive: a work record.

A task is a work unit. A model call is a work unit. A tool call can be a work unit. An artifact is an output of a work unit. Usage and artifacts are therefore facets of the same causality chain, not two separate reporting systems.

```ts
export type FlueWorkKind =
  | 'prompt'
  | 'skill'
  | 'task'
  | 'tool'
  | (string & {});

export interface FlueWorkRef {
  workId: string;
  parentWorkId?: string;
  kind: FlueWorkKind;
  name?: string;
  sessionId?: string;
  parentSessionId?: string;
  taskId?: string;
  role?: string;
  cwd?: string;
}
```

The primitive stack stays boring on purpose: `FlueWorkRef` gives identity and causality, task telemetry adds the usage facet, artifact channels add the output facet, and CLI/SSE/tracing/FinOps adapters consume the same normalized facts.

| Primitive | Purpose |
| --- | --- |
| `FlueWorkRef` | Common identity and parentage for prompt, skill, task, and tool work |
| `PromptUsage` | Normalized token and model usage for a completed work unit |
| `ArtifactRef` | Compact pointer to durable output produced by a work unit |
| `FlueEventMetadata` | Transport for work identity on runtime events |
| `TaskToolResultDetails` | Parent-facing summary that can carry usage and output refs together |

For this proposal, `task_start`, `task_end`, and `TaskToolResultDetails` should carry `workId` and `parentWorkId`. That is enough for TokenOps and FinOps to group direct usage, child usage, failed work, and later artifact outputs without inventing a second identity system.

## Primitive Invariants

- `workId` is stable for one runtime operation across events, task details, and any artifacts produced by that operation.
- `parentWorkId` points to the operation that caused this one. It is a correlation key, not a mandate to build a full tracing backend in v1.
- `taskId` remains the task-facing id. `workId` is the cross-feature id that can also describe prompt, skill, and tool work.
- Usage is recorded on completed work once. Parent rollups can add direct child work exactly once without walking the whole tree again.
- Artifact refs, when present, attach to the work that produced the durable output and never carry file bodies through telemetry events.

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
- Implementing the artifact-channel protocol in this PR.

Those are natural follow-ups, but this proposal is the first telemetry layer they would build on.

## What Changes From Today

| Today | Proposed |
| --- | --- |
| Task events identify the task but not the full work chain. | Task events carry `workId`, `parentWorkId`, `sessionId`, `parentSessionId`, and `taskId`. |
| Task end events report success or failure with an unstructured result. | Task end events also report timing, model, and usage when available. |
| Built-in `task` tool results do not expose a stable accounting payload. | `TaskToolResultDetails` becomes the parent-facing receipt for task usage, model, duration, and optional output refs. |
| Parent prompt usage can hide direct child task usage. | Built-in task tool usage rolls into the enclosing parent prompt or skill response exactly once. |
| TokenOps and FinOps consumers must infer causality from logs. | Consumers can group work by stable ids and add adapters without changing provider-specific model APIs. |

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
  workId?: string;
  parentWorkId?: string;
  workKind?: FlueWorkKind;
};
```

For `task_start` and `task_end`, `workId` and `workKind: 'task'` should be present. The fields stay optional on the generic event envelope only because not every existing event has work identity yet.

## Task Tool Details

When the built-in `task` tool completes, the tool result should expose the same telemetry in its details payload:

```ts
interface TaskToolResultDetails {
  taskId: string;
  sessionId: string;
  workId: string;
  parentWorkId?: string;
  messageId?: string;
  role?: string;
  cwd?: string;
  usage?: PromptUsage;
  model?: PromptModel;
  durationMs: number;
  artifacts?: ArtifactRef[];
}
```

This gives raw event consumers the information even before the parent prompt finishes. If artifact channels are enabled, the same details payload can include bounded `ArtifactRef` summaries for files the child task published. The usage rollup says what the delegated work cost; artifact refs say what durable outputs came from it.

## Event Sequence

The useful join is intentionally small:

```text
prompt_start       work=wrk_parent
  task_start       task=task_123 work=wrk_child parent=wrk_parent
  artifact_publish artifact=art_patch producer.work=wrk_child
  task_end         task=task_123 work=wrk_child usage=12,430 tokens
prompt_end         work=wrk_parent usage=parent_direct + wrk_child
```

If artifact channels are not installed yet, the same telemetry sequence still works. The `workId` field is the compatibility anchor for adding artifact outputs later.

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
  - Add the shared `FlueWorkRef` identity shape.
  - Enrich `FlueEvent` task event variants.
- `packages/sdk/src/agent.ts`
  - Extend `TaskToolResultDetails`.
- `packages/sdk/src/session.ts`
  - Allocate `workId` and `parentWorkId` for task calls.
  - Time tasks in `runTask()`.
  - Extract child `usage` and `model` from `PromptResponse` and `PromptResultResponse`.
  - Keep a parent-call-scoped direct-child usage accumulator for built-in task tool calls.
  - Attach artifacts published during the task when artifact channels are present.
  - Add accumulated child usage in `aggregateUsageSince(...)`.
- `packages/cli/bin/flue.ts`
  - Render `task_start` and `task_end`.

## Landing Order

The two PRs should not race to create different contracts.

- If task telemetry lands first, it should add `FlueWorkRef`, event metadata, and task details with `workId`. The `artifacts` field can wait until artifact channels exist.
- If artifact channels land first, they should add `FlueWorkRef` and `producer.workId` on artifact records. Usage joins can wait until task telemetry exists.
- If they land together, `FlueWorkRef` should be defined once in the SDK types module and imported by both feature implementations.

## Forward Compatibility and Cost

This should be additive to the current task surface. Existing `taskId`, `sessionId`, and event names stay intact. New metadata fields can be optional on the generic event envelope while becoming required for the new task telemetry variants. That gives older consumers a soft landing and gives new consumers a reliable join key.

The cognitive cost should stay low for ordinary users: they see clearer CLI lines and more accurate `usage`. Advanced consumers learn one new noun, `workId`, when they need tracing, rollups, or artifact joins.

The runtime cost is intentionally small:

- one id allocation and timestamp pair per tracked task;
- a task-scoped accumulator for direct child usage during built-in `task` tool calls;
- slightly larger event and tool-detail payloads;
- no extra model calls, no persistent telemetry index, and no recursive tree walk for rollups.

The feature should not make failed or nested work ambiguous. Failed tasks may omit usage if none is available, but they should still emit timing and work identity. Nested rollups should only add direct child usage at each level so totals do not double count.

## Acceptance Criteria

A v1 implementation is ready when:

- `task_start` and `task_end` events include work identity, task identity, timing, model, and usage when available;
- built-in `task` tool results expose the same work identity and telemetry in `TaskToolResultDetails`;
- parent prompt and skill responses include direct child task usage exactly once;
- direct `session.task()` calls still return child usage without mutating unrelated parent usage;
- telemetry remains useful if artifact channels land later, and can include bounded artifact refs if they are already present;
- `flue run` renders task start/end lines without dumping large results or file contents.

## Open Questions

- Should `description` be added to the public `session.task()` options, or only remain a field from the built-in task tool parameters?
- Should failed tasks attempt to report partial child usage, or should failed parent calls keep failing without partial accounting?
- Should task usage rollups be visible as a separate field in the parent response later, rather than only included in aggregate `usage`?
- Do we want the task event `result` field to remain freeform, or should it get a narrower text/error shape in a later API cleanup?
