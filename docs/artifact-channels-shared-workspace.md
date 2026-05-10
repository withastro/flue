# Artifact Channels and Shared Workspace Protocol

Status: Draft proposal

## What Hurts

Agents often need to hand off big things: source files, diffs, logs, research,
screenshots, reports. Putting those things into prompts is expensive and noisy.

Writing files is better, but then the next agent has to guess which file matters,
who made it, whether it replaced an older file, and whether it is meant as a
final output or just scratch work.

That is the problem. A shared workspace saves tokens, but without a protocol it
turns into a pile of files.

## What Other Harnesses Usually Do

Hosted managed-agent systems can give agents a shared filesystem, but the
protocol belongs to the hosted runtime. Graph frameworks make state explicit,
but large artifacts do not belong in serialized graph state. Lightweight agent
SDKs often leave file handoff to prompts and convention.

## What Flue Can Do Better

Flue already owns the sandbox filesystem. The first-principles move is simple:
keep file bodies in the workspace, and publish small artifact refs that say what
the file is, who produced it, which channel it belongs to, and what it replaces.

The ref moves through prompts, events, and task results. The large file stays in
the sandbox until a model actually needs to read it.

```text
Architect task
  |
  +-- writes /workspace/design.md
  +-- publishes ArtifactRef art_design (channel=design)
        |
        v
Builder task reads art_design
  |
  +-- writes /workspace/fix.diff
  +-- publishes ArtifactRef art_patch (channel=patch)
        |
        v
Parent / CLI / inspect / TokenOps / FinOps

File bodies stay in /workspace.
ArtifactRefs move through prompts, events, and task results.
```

## What Stays Pluggable

The core protocol stays storage-light and sandbox-native: append-only artifact
records over the existing `SessionEnv` filesystem. That gives Flue a portable
default, while keeping room for adapters:

- filesystem records under `.flue-runtime/` for the default implementation;
- R2, S3, database, or vector-index mirrors for deployed environments;
- custom channel vocabularies for review, build, research, migration, and
  verification workflows;
- CLI, SSE, and future `flue inspect` renderers;
- TokenOps and FinOps consumers that correlate artifact refs with task usage.

The runtime owns artifact identity and provenance. Blob storage, indexing,
visualization, and governance stay replaceable.

## Current Gap

Flue already has the right base: agents and tasks can share a sandbox
filesystem. That means they can pass paths instead of stuffing large files into
the prompt.

But the workspace is invisible to Flue as a workflow. A useful report and a
scratch file look the same. A parent can tell a child to write `design.md`, but
Flue does not know that `design.md` matters.

There is no simple way to answer:

- Which task produced this file?
- Which files are the meaningful outputs of this run?
- Which artifact should a later task read instead of scanning the whole
  workspace?
- Did a child revise an earlier artifact or create a competing one?
- Which large context was kept out of the prompt by passing a file reference?

A shared filesystem is the cost lever. The missing piece is a small protocol
that says which files are real outputs, who made them, and how the next agent
should find them.

## Goals

- Give Flue agents a first-class way to publish and discover artifacts in a
  shared workspace.
- Preserve the token-saving path: pass small artifact references instead of
  copying large file contents through prompts.
- Attribute artifacts to the session, task, role, and model that produced them.
- Make task outputs visible in events, `flue run`, and future inspection tools.
- Avoid a central mutable manifest as the v1 coordination point.
- Stay portable across Flue's current `SessionEnv` filesystem surface.

## Design Principles

- **Artifacts are pointers, not payloads.** Events and task details carry compact
  references. File contents stay in the workspace until a model explicitly reads
  them.
- **Publishing is explicit.** Writing a file does not automatically make it a
  workflow artifact. The producer decides which files matter.
- **Records are append-only.** A new version publishes a new record and links to
  the previous one. Consumers can hide superseded records without losing audit
  history.
- **No new storage substrate.** The protocol uses the existing `SessionEnv`
  filesystem so it works across virtual, local, and remote sandboxes.
- **No hidden trust boundary.** Shared workspace agents remain mutually trusted.
  Artifact records improve coordination and attribution; they are not a sandbox
  permission layer.

## Non-Goals

- A full artifact database or long-term search index.
- A collaborative editing protocol, CRDT, or file-locking system.
- A web UI for artifact browsing.
- Fine-grained permissions inside one trusted agent workspace.
- Automatic semantic versioning of arbitrary files.
- Storing binary blobs outside the configured sandbox.

Those are reasonable follow-ups, but the first step should be a small protocol
that makes shared filesystem handoffs explicit.

## Vocabulary

**Workspace** is the sandbox filesystem visible to the agent runtime.

**Artifact** is a meaningful output file or directory that an agent wants other
agents or users to find.

**Channel** is a named stream of artifacts for a purpose, such as `analysis`,
`design`, `patch`, `verification`, or `handoff`.

**Artifact record** is the structured metadata Flue writes when an artifact is
published.

**Artifact ref** is the compact pointer that can safely travel through prompts,
events, logs, and task results without copying the underlying file content.

## Default Channels

Channels should be freeform strings, but Flue can document a small common
vocabulary so logs and examples converge:

| Channel | Purpose |
| --- | --- |
| `analysis` | Research notes, discovery summaries, trade-off analysis |
| `design` | Design docs, API sketches, architecture diagrams |
| `patch` | Diffs, changed files, generated implementation artifacts |
| `verification` | Test logs, smoke results, review findings |
| `handoff` | Final task summaries intended for a parent or later task |

Custom channels should use simple lowercase names with dashes, for example
`security-review` or `migration-plan`.

## Protocol Shape

Publishing an artifact should be a metadata operation over the existing
filesystem. The producer writes the actual file first, then publishes a record
that points at it.

```ts
await session.fs.writeFile('/workspace/reports/review.md', reviewMarkdown);

const artifact = await session.artifacts.publish({
  channel: 'review',
  path: '/workspace/reports/review.md',
  title: 'Security review',
  summary: 'Finds SQL injection risk and missing transfer atomicity.',
  kind: 'report',
  mediaType: 'text/markdown',
});
```

The model-facing version should be a built-in tool with the same split:

1. use `write` or `edit` to create the file;
2. call `artifact_publish` with the path and short summary;
3. pass the returned artifact id to the parent or next task.

The next task receives a small pointer:

```text
Read artifact art_01JZ... from channel review, then produce a patch.
```

It can call `artifact_list` to resolve the id to a path, then use the existing
`read` tool to inspect the file.

If the caller already knows the artifact id, `artifact_get` should resolve it
directly. `artifact_list` is for discovery by channel or producer.

## Example Workflow

A parent agent coordinating implementation can pass artifact references through
the whole workflow without repeatedly copying large context.

1. Parent writes the target source bundle into the workspace.
2. Architect task reads source files and publishes `design` artifact
   `art_design`.
3. Builder task receives `art_design`, reads the referenced path, writes a diff,
   and publishes `patch` artifact `art_patch`.
4. Reviewer task receives `art_design` and `art_patch`, reads only those files,
   and publishes `verification` artifact `art_review`.
5. Parent receives task results containing artifact ids and returns a final
   answer that links to `art_patch` and `art_review`.

The prompt traffic carries short ids and summaries. The large design, patch, and
review bodies remain in the workspace unless the next model turn actually needs
to read them.

## Storage Layout

The v1 protocol should avoid one shared manifest file because `SessionEnv` does
not expose locks or compare-and-swap writes. Instead, each publish writes one
unique record file.

Default runtime directory:

```text
<cwd>/.flue-runtime/artifacts/
  records/
    art_01JZABC123.json
    art_01JZABC124.json
  files/
    art_01JZABC125/
      output.md
```

The runtime directory intentionally uses `.flue-runtime/`, not `.flue/`, so it
does not collide with Flue's source layout.

Most artifacts will point at files the agent already wrote elsewhere in the
workspace. The `files/` directory is only for convenience APIs that ask Flue to
write managed content directly.

Listing artifacts scans `records/` and filters by channel, producer, status, or
time. A materialized manifest can be derived later without changing the record
format.

## Validation and Safety

Publishing should validate the target before writing the artifact record:

- resolve the path through `SessionEnv.resolvePath()`;
- fail if the target does not exist or the sandbox adapter rejects the path;
- record whether the target is a file, directory, or symbolic link;
- record file size from `stat()` when available;
- keep `title` and `summary` bounded so events and task details stay small.

The protocol does not add a permissions boundary inside a shared sandbox. Agents
that share a sandbox can already read and write the same files. Artifact records
make that activity discoverable; they do not make untrusted agents safe to run
in the same workspace.

Artifact summaries should be treated like log/event data. They should not contain
secrets, full file bodies, or large excerpts. The record points at the file; it
does not replace the file.

## Failure Semantics

Publishing should fail before writing a record when the target path is missing or
the sandbox rejects access to it. A failed publish should not create a partial
record.

If the artifact file exists but disappears later, `artifact_get` should still
return the record and mark the target as unavailable when it checks the path.
That preserves provenance while making the broken reference explicit.

If two tasks publish records at the same time, both should succeed because their
record files use unique ids. If both records claim to replace the same prior
artifact, consumers should treat the result as competing revisions rather than
attempting last-writer-wins conflict resolution.

## Primary Data Types

```ts
export type ArtifactKind =
  | 'file'
  | 'directory'
  | 'report'
  | 'patch'
  | 'json'
  | 'log'
  | 'binary'
  | (string & {});

export type ArtifactStatus = 'active' | 'superseded' | 'deleted';

export interface ArtifactProducer {
  sessionId: string;
  parentSessionId?: string;
  taskId?: string;
  role?: string;
  model?: PromptModel;
}

export interface ArtifactRef {
  version: 1;
  id: string;
  channel: string;
  kind: ArtifactKind;
  path: string;
  recordPath: string;
  targetAvailable: boolean;
  isDirectory?: boolean;
  isSymbolicLink?: boolean;
  title?: string;
  summary?: string;
  mediaType?: string;
  sizeBytes?: number;
  digest?: {
    algorithm: 'sha256';
    value: string;
  };
  createdAt: string;
  updatedAt: string;
  producer: ArtifactProducer;
  status: ArtifactStatus;
  replaces?: string;
  parentArtifactIds?: string[];
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface ArtifactPublishOptions {
  channel: string;
  path: string;
  kind?: ArtifactKind;
  title?: string;
  summary?: string;
  mediaType?: string;
  replaces?: string;
  parentArtifactIds?: string[];
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface ArtifactListOptions {
  channel?: string;
  taskId?: string;
  sessionId?: string;
  status?: ArtifactStatus;
  includeSuperseded?: boolean;
  since?: string;
  limit?: number;
}

export interface ArtifactChannel {
  name: string;
  description?: string;
  defaultKind?: ArtifactKind;
}
```

## SDK Surface

The smallest useful trusted-code surface is:

```ts
interface FlueArtifacts {
  publish(options: ArtifactPublishOptions): Promise<ArtifactRef>;
  list(options?: ArtifactListOptions): Promise<ArtifactRef[]>;
  get(id: string): Promise<ArtifactRef | null>;
}

interface FlueSession {
  readonly artifacts: FlueArtifacts;
}

interface FlueAgent {
  readonly artifacts: FlueArtifacts;
}
```

`FlueAgent.artifacts` and `FlueSession.artifacts` share the same workspace, but
the session variant automatically fills producer metadata from the active
session.

## Model-Facing Tools

Agents should not need to hand-edit JSON records. Flue can add three built-in
tools in v1:

```ts
artifact_publish({
  channel: string;
  path: string;
  title?: string;
  summary?: string;
  kind?: string;
  replaces?: string;
  parentArtifactIds?: string[];
  tags?: string[];
}) -> ArtifactRef

artifact_get({
  id: string;
}) -> ArtifactRef | null

artifact_list({
  channel?: string;
  taskId?: string;
  status?: 'active' | 'superseded' | 'deleted';
  limit?: number;
}) -> ArtifactRef[]
```

There is no separate `artifact_read` in the initial design. Returning paths from
`artifact_list` keeps reading on the existing `read` tool, which preserves the
current truncation and offset behavior.

## Task Integration

Artifact channels become most useful when paired with `session.task()` and the
built-in `task` tool.

Child tasks should publish meaningful outputs while they work. The parent should
then receive artifact ids in the task result details.

```ts
interface TaskToolResultDetails {
  taskId: string;
  sessionId: string;
  messageId?: string;
  role?: string;
  cwd?: string;
  artifacts?: ArtifactRef[];
}
```

Task events can carry artifact summaries without embedding file contents:

```ts
type FlueArtifactEvent = {
  type: 'artifact_publish';
  artifact: ArtifactRef;
};
```

This complements task telemetry. Telemetry explains what the task cost and how
long it ran; artifact channels explain what the task produced.

Together, the two features give a parent workflow an accounting pair:

```text
task telemetry = what ran, how long, which model, how many tokens
artifact channel = what durable output came from that work
```

That pairing is what later enables cost-per-artifact, failed-work analysis, and
managed-agent debugging.

## Revision Semantics

Artifact records should be append-only. A revision publishes a new record with
`replaces` pointing to the prior artifact id.

```ts
await session.artifacts.publish({
  channel: 'design',
  path: '/workspace/design-v2.md',
  replaces: 'art_01JZABC123',
});
```

Consumers that ask for active artifacts can hide superseded records by default,
but the old records remain available for audit, debugging, and replay.

The v1 protocol should not attempt to detect simultaneous edits to the same
underlying path. Instead, Flue should encourage task-scoped output paths:

```text
/workspace/.flue-runtime/artifacts/files/<artifact-id>/output.md
/workspace/tasks/<task-id>/review.md
```

That convention avoids most races without requiring filesystem locks.

## CLI Rendering

`flue run` should render artifact publications concisely:

```text
[flue] artifact:publish  review/security.md  channel=review task=task_123
[flue] artifact:publish  patch/fix.diff      channel=patch  task=task_124
```

For a completed task, the CLI can add a compact artifact count:

```text
[flue] task:done  8.2s  tokens=9,420  artifacts=2
```

The CLI should not print artifact contents. It should print paths and ids so
users can inspect files directly.

## TokenOps and FinOps

Artifact channels create a measurable token-avoidance layer.

For TokenOps, Flue can distinguish:

- content sent through prompt text;
- artifact references sent through prompt text;
- file contents read by a model only when needed;
- task outputs that stayed in the workspace and did not inflate parent context.

For FinOps, artifacts help attribute cost to durable outputs:

- cost per published report, patch, or verification log;
- cost of producing an artifact versus revising it;
- failed-task spend with or without useful artifacts;
- workflows where shared workspace handoff avoided repeated prompt payloads.

The protocol should not try to compute token savings in v1. It should preserve
enough structure for later rollups to compare large file sizes, artifact
references, and task usage.

## Implementation Shape

Likely change points:

- `packages/sdk/src/types.ts`
  - Add artifact data types.
  - Add `artifacts` to `FlueAgent` and `FlueSession`.
  - Add `artifact_publish` to `FlueEvent`.
- `packages/sdk/src/artifacts.ts`
  - New helper module for id generation, record paths, publish/list/get.
  - Store one JSON record per artifact under `.flue-runtime/artifacts/records`.
- `packages/sdk/src/agent-client.ts`
  - Construct agent-scoped artifact registry from the shared `SessionEnv`.
- `packages/sdk/src/session.ts`
  - Construct session-scoped artifact registry with producer metadata.
  - Track artifacts published during a task call.
- `packages/sdk/src/agent.ts`
  - Add built-in `artifact_publish`, `artifact_get`, and `artifact_list` tools.
- `packages/cli/bin/flue.ts`
  - Render artifact publication events.

## Acceptance Criteria

A v1 implementation is ready when:

- trusted code can publish, list, and get artifact records from an agent or
  session;
- model-facing tools can publish, get, and list artifacts without hand-editing
  JSON;
- `flue run` renders artifact publication events without printing file contents;
- task result details include artifacts published during that task;
- concurrent publishes create independent records without corrupting a shared
  manifest;
- tests cover missing paths, superseded artifacts, concurrent publishes, and
  task attribution.

## Suggested Rollout

1. Add the data types and trusted-code `FlueArtifacts` helper.
2. Add `artifact_publish` events and CLI rendering.
3. Add model-facing `artifact_publish`, `artifact_get`, and `artifact_list`
   tools.
4. Attach per-task artifact summaries to task result details.
5. Layer inspection, dashboards, or cost rollups on top after the protocol has
   real usage.

## Recommended V1 Defaults

- Enable artifact tools by default when the `task` tool is available. Artifact
  handoff is part of the managed-agent story, not a niche extension.
- Store records under `<cwd>/.flue-runtime/artifacts/records/` for all sandbox
  modes. Users can override the runtime directory later if real deployments need
  it.
- Include full `ArtifactRef` objects in task result details, but keep summaries
  bounded and omit file contents.
- Compute `sizeBytes` in v1. Treat SHA-256 digests as best-effort for regular
  files and skip them for directories until there is demand.
- Keep publication explicit. Do not infer artifact records from every `write`
  call.

## Open Questions

- What file-size cutoff should Flue use before skipping best-effort SHA-256
  digest calculation?
- Should Flue add a convenience API that writes managed artifact content into
  `.flue-runtime/artifacts/files/<artifact-id>/`, or should v1 only publish
  existing paths?
