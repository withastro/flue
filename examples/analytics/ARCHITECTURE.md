# Analytics Agent Architecture Plan

## Goal

Untangle the current single Claude Code-style agent into a lean multi-stream system with clear routing, tool boundaries, and domain-specific instructions.

The target system supports non-technical users asking for analytics help, product/internal knowledge, specialized workflow execution, and documentation/context contribution.

## Proposed Shape

Use a waiter plus kitchen model:

- `waiter`: user-facing experience owner: understands needs, recommends options, asks clarifying questions, translates requests into kitchen orders, reviews kitchen output, sends work back when unsatisfactory, and presents the final answer.
- `analytics`: dbt manifest discovery, BigQuery exploration, Metabase research/card creation.
- `knowledge`: product/internal question answering from built-in docs, Slack search, Google Drive, and repo reading.
- `workflow`: specialized operational workflows such as Amplitude event creation; may call analytics and knowledge kitchen stations.
- `documentation`: write/update personal or project context so users can contribute to the knowledge base.
- `explorer`: cheap tasker subagent for bounded information gathering across manifest, Slack, Google Drive, docs, and repo search.
- `dbt-explorer`: parallel omnipotent agent carrying the current broad dbt-explorer instructions/tools; use it while we learn which tasks can be safely promoted or demoted to narrower agents.

The kitchen is the collection of specialized workhorse agents. Each stream has separate instructions, tools, model defaults, and session memory. For new, flagged, ambiguous, or high-impact turns, kitchen output is subject to waiter review before reaching the user. For smooth mainline continuation, the waiter may choose "no more research needed" and pass the message directly to the active station.

## Recommended Flue Layout

```text
source_catalog.md

.flue/
  agents/
    waiter.ts
    dbt-explorer.ts
    analytics.ts
    knowledge.ts
    workflow.ts
    documentation.ts
    explorer.ts

  roles/
    waiter.md
    analytics.md
    knowledge.md
    workflow.md
    documentation.md
    explorer.md

  tools/
    manifest/
      search.ts
      lineage.ts
      details.ts
    bigquery/
      explore.ts
      preview.ts
    metabase/
      research.ts
      create-card.ts
    slack/
      search.ts
      thread.ts
    drive/
      search.ts
      read.ts
    repo/
      search.ts
      read.ts
    docs/
      search.ts
      read.ts
    context/
      user-context.ts
      project-context.ts
    workflows/
      amplitude-events.ts
      jira.ts

  toolsets/
    analytics.ts
    knowledge.ts
    workflow.ts
    documentation.ts
    explorer.ts
```

Tools are shared primitives. Agents should import curated toolsets rather than owning private tool implementations:

```ts
// toolsets/analytics.ts
export function analyticsTools(policy: ToolPolicy) {
  return [
    manifestSearchTool(policy),
    manifestLineageTool(policy),
    manifestDetailsTool(policy),
    bigQueryExploreTool(policy),
    bigQueryPreviewTool(policy),
    metabaseResearchTool(policy),
    ...(policy.allowMetabaseCreate ? [metabaseCreateCardTool(policy)] : []),
  ];
}
```

Shared tools should accept a policy/config object so the same implementation can be reused with different permissions, limits, and credentials per agent or source.

Tool policy is the runtime contract for a shared tool. Today many limits are source-agnostic, but the policy object prevents permissions from getting hard-coded into tool implementations as Slack/web/GKE differences grow.

```ts
type ToolPolicy = {
  source: "web" | "slack" | "cli";
  actor: {
    userId: string;
    email?: string;
  };
  credentials: {
    bigQueryMode: "service_account" | "user_oauth";
    googleDriveMode: "service_account" | "user_oauth";
  };
  permissions: {
    allowSensitiveBigQuery: boolean;
    allowMetabaseCreate: boolean;
    allowContextWrite: boolean;
    allowWorkflowMutation: boolean;
  };
  limits: {
    maxBigQueryGb: number;
    maxSearchResults: number;
    maxToolCalls?: number;
  };
};
```

Current default:

- Most limits can stay source-agnostic.
- Slack runs with vanilla service-account access and stricter mutation permissions.
- Web can obtain user credentials for sensitive BigQuery and Google Drive access.
- CLI is developer/local mode and should be explicit about which credentials it exposes.

FastAPI remains the external adapter layer for now:

- Slack signature verification, retries, duplicate event handling.
- Slack thread/channel routing and progress updates.
- User identity mapping and authorization.
- Web app request lifecycle and response formatting.

Flue owns the waiter, kitchen agents, domain tools, kitchen sessions, and model orchestration.

## Kitchen Orders

Agents do not implicitly share full conversation history. Orders should be explicit, summarized, and typed.

The waiter sends a compact kitchen order to a kitchen station:

```ts
type KitchenOrder = {
  source: "web" | "slack" | "cli";
  userId: string;
  userRequest: string;
  rewrittenTask: string;
  route: "analytics" | "knowledge" | "workflow" | "documentation" | "explorer";
  sources: Array<"kb" | "manifest" | "metabase" | "slack" | "drive" | "repo">;
  constraints: string[];
  knownContext: string[];
  requestedOutput: string;
  selectedToolsets: string[];
  priorArtifacts?: Array<{
    type: "sql" | "csv" | "metabase_card" | "doc_update" | "workflow_spec";
    id?: string;
    path?: string;
    url?: string;
    summary?: string;
  }>;
};
```

`source_catalog.md` is the waiter-readable map from user intent to source domains. It is deliberately positive: each source says what it is best for, while implementation status says which harnesses exist today. This keeps routing guidance separate from policy enforcement.

Kitchen agents return structured results:

```ts
type KitchenResult = {
  answer: string;
  confidence: "low" | "medium" | "high";
  artifacts: Array<{
    type: "sql" | "csv" | "metabase_card" | "doc_update" | "workflow_spec";
    id?: string;
    path?: string;
    url?: string;
  }>;
  followupQuestions: string[];
  kitchenSummary: string;
  needsReview: boolean;
};
```

Kitchen outputs should always be schema-validated. Optional fields are allowed, but the top-level envelope should be present for every station so the waiter can reliably audit, retry, persist, and synthesize.

The waiter reviews `KitchenResult` before responding to the user when the turn is routed through a full work order. The waiter may:

- Accept and translate it into a user-facing answer.
- Ask the kitchen for clarification or correction.
- Route a subtask to another kitchen station.
- Ask the user a clarifying question.
- Refuse unsafe or unauthorized actions.

User-visible text invariant:

- The waiter owns all user-visible text.
- Kitchen stations may answer directly only when the waiter made an explicit pass-through decision for smooth mainline continuation.
- The waiter edits for clarity, caveats, tone, permissions, and completeness before responding.

Rework path:

- FastAPI/web UI should expose a "send back to kitchen" action on responses.
- This is not a normal follow-up. It means the answer was not directionally correct.
- The waiter should launch a more scrutinizing review: completely rethink the user's intent, inspect the prior kitchen order/result, and decide whether to ask a clarifying question, rewrite the order, route to a different station, or escalate model strength.
- The rework order should include `doNotRepeat` items so the kitchen does not rerun successful expensive steps blindly.

Session strategy:

- Waiter session: `user:<id>:waiter`
- Analytics session: `user:<id>:analytics`
- Knowledge session: `user:<id>:knowledge`
- Workflow session: `user:<id>:workflow`
- Documentation session: `user:<id>:documentation`

The waiter owns user-facing history, recommendations, gating, and final synthesis. Kitchen stations own domain memory and tool history.

All user-initiated messages reach the waiter first. The waiter can either:

- pass a smooth mainline continuation directly to the active station without preflight
- run preflight explorer and create a new work order
- ask a clarifying question
- trigger rework/topic-switch/side-question handling based on explicit UI signals

Durable state:

- Firestore stores conversation state, waiter orders/results, kitchen summaries, event stream metadata, and lightweight session indexes.
- GCS stores large artifacts and portable session payloads: CSVs, reports, query files, generated docs, logs, and any large serialized state that should not live in Firestore documents.
- Project context is versioned with the agent definition repo.
- User-contributed personal context is not versioned initially; it is mutable user state.

## Tool Boundaries

Waiter should have minimal direct tools:

- classify/route
- read lightweight user/project context
- delegate to kitchen stations
- synthesize results
- request kitchen rework

Kitchen stations get only their domain tools:

- Analytics: analytics toolset plus optional explorer delegation.
- Knowledge: knowledge toolset plus optional explorer delegation.
- Workflow: workflow toolset plus selected analytics/knowledge/explorer delegation.
- Documentation: context write tools plus knowledge/explorer lookup.
- Explorer: read-only discovery tools across manifest, Slack, Drive, docs, and repo.

Avoid giving the waiter broad tools such as BigQuery, Metabase creation, repo writes, or raw Slack search unless a concrete flow requires it. The waiter can request those actions from kitchen agents and review the result.

Toolsets should be composed from shared tools:

```text
analytics toolset:
  manifest.search, manifest.lineage, manifest.details
  bigquery.explore, bigquery.preview
  metabase.research, metabase.create-card gated

knowledge toolset:
  docs.search/read
  slack.search/thread
  drive.search/read
  repo.search/read

workflow toolset:
  workflows.amplitude-events
  workflows.jira
  selected read-only knowledge + analytics lookups

documentation toolset:
  context.user/project read/write
  docs/repo read-only lookup

explorer toolset:
  manifest.search/details
  slack.search/thread
  drive.search/read
  docs.search/read
  repo.search/read
```

## Explorer Subagent

The explorer is a cheap, read-only tasker used by the waiter and kitchen stations for bounded lookup work.

Responsibilities:

- Search the dbt manifest for relevant models/columns.
- Search Slack and summarize relevant threads.
- Search Google Drive and summarize relevant docs.
- Search/read internal repo files.
- Return concise evidence packs, not final user-facing answers.

The explorer should default to a cheap model and strict output schema:

```ts
type ExplorerTask = {
  query: string;
  sources: Array<"manifest" | "slack" | "drive" | "docs" | "repo">;
  maxResultsPerSource: number;
  constraints: string[];
};

type EvidencePack = {
  summary: string;
  findings: Array<{
    source: "manifest" | "slack" | "drive" | "docs" | "repo";
    title: string;
    reference: string;
    relevance: "low" | "medium" | "high";
    excerpt?: string;
  }>;
  gaps: string[];
};
```

The explorer should not:

- Run BigQuery.
- Create Metabase cards.
- Write docs/context.
- Execute workflow actions.
- Talk directly to end users.

## Model Defaults

Model selection should be configurable per agent:

```env
WAITER_MODEL=anthropic/claude-sonnet-4-6
ANALYTICS_MODEL=openai/gpt-4.1-mini
KNOWLEDGE_MODEL=openai/gpt-4.1-mini
WORKFLOW_MODEL=anthropic/claude-sonnet-4-6
DOCUMENTATION_MODEL=openai/gpt-4.1-mini
EXPLORER_MODEL=openai/gpt-4.1-mini
```

The waiter can use a higher-intelligence model because user understanding, recommendations, gating, and rework decisions matter. Kitchen stations should default cheaper and escalate only when needed.

Escalation policy is intentionally tabled. The architecture should leave room for model escalation on low confidence, repeated kitchen failure, user-requested rework, or high-impact actions, but the concrete thresholds need usage data.

## Decisions

- **FastAPI remains the adapter/orchestration shell, but not the business router.** The waiter writes the kitchen order. FastAPI may execute the station call as infrastructure, but it should not bypass or reinterpret waiter routing.
- **User-triggered rework is explicit.** A "send back to kitchen" action should trigger a more scrutinizing waiter pass that rethinks intent and prior output, not a normal continuation.
- **State is Firestore + GCS.** Firestore for structured run/session metadata; GCS for large artifacts and portable session payloads.
- **Slack is more restricted than web.** Slack uses vanilla service-account access with limited permissions. Web can obtain user credentials for sensitive BigQuery and Drive access.
- **Kitchen outputs are schema-validated.** Schemas can contain optional fields, but the envelope must be reliable.
- **Context versioning differs by scope.** Project context is versioned with the agent definition repo. Personal/user context is mutable and non-versioned initially.
- **Explorer can be used by both waiter and kitchen.** The waiter can use explorer for planning evidence; kitchen stations can use explorer for bounded lookup work.
- **Tool limits are currently mostly source-agnostic.** `ToolPolicy` is still useful as a future-proof config/permission carrier, but v1 should avoid inventing unnecessary per-source knobs.

## Reference From Prior Two-Agent Branch

The prior `evenup-internal-tools-wt/two-agent-arch` branch is reference material, not gospel. Its decisions were made under Claude Code SDK constraints. Flue gives us more flexible native tools, typed results, sessions, roles, and runtime orchestration, so the current architecture should be redesigned around Flue rather than porting that branch directly.

Ideas worth preserving as design inputs:

- **Schema-first contracts.** If PlanDoc/KitchenOrder and ReportDoc/KitchenResult stay vague, the system degrades into prompt conventions.
- **Document passing beats message-list injection.** Kitchen orders/results are the interface, not a provider-specific chat transcript.
- **Waiter owns all user-visible text.** Kitchen output is evidence and draft material, not the final response.
- **Kitchen never sees raw conversation history.** It gets the order plus scoped prior artifacts selected by the waiter.
- **Clarification lifecycle must be explicit.** If the waiter asks a question, the next user message should be routed as an answer to that pending clarification, not treated as a fresh request.
- **Retries must be bounded and specific.** Rework should include required fixes and `doNotRepeat` so expensive successful steps are not rerun.
- **Evidence matters more than effort.** A kitchen result should say what was actually checked; "searched around" is not enough.
- **Personal context informs waiter planning only.** Do not leak broad user preference/profile data into kitchen prompts unless the waiter selects a narrow, relevant fact.
- **Prior artifacts are load-bearing for follow-ups.** "Modify this query" requires prior SQL and findings to be explicitly passed in the order.

Claude-specific choices that should not automatically carry over:

- Gatekeeper on turn 1 only.
- `/deepthink` as the main escalation mechanism.
- Workhorse prompt stacking around `CLAUDE.*.md` files.
- `report.json` as an output-file-based handoff.
- Anthropic message-list persistence.
- Claude Code SDK permission-mode assumptions.
- Skill preloading as the primary tool-selection mechanism.

In Flue, prefer native Flue primitives:

- Agent files for waiter and kitchen stations.
- Roles for behavior/instruction bundles.
- Shared typed tools and curated toolsets.
- `prompt()`/`task()` result schemas for kitchen orders/results.
- Named sessions for waiter and kitchen continuity.
- Explicit artifacts in Firestore/GCS rather than output-file conventions where possible.

## Migration Plan

1. Stabilize `analytics` as the first Flue kitchen station.
2. Add typed kitchen order/result schemas.
3. Add a small waiter that only classifies, routes, and reviews; no complex synthesis initially.
4. Extract current tool wrappers into shared `tools/` and curated `toolsets/`.
5. Add `explorer` as a cheap read-only tasker used by kitchen stations.
6. Move knowledge-base retrieval into `knowledge`.
7. Move highly specialized skills into `workflow`.
8. Add documentation/context contribution as its own stream.
9. Add cross-kitchen delegation after single-route flows are reliable.

## Open Questions

- What escalation policy should move a kitchen station from cheap model to stronger model?
- What exact `ToolPolicy` fields are needed for v1 versus later Slack/web/GKE differences?
