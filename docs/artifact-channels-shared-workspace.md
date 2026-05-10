# Artifact Channels and Shared Workspace Protocol

Status: Draft proposal

## Problem

Flue already has the important primitive for managed-agent work: every agent and
task can share a sandbox filesystem. That lets agents pass paths instead of
copying large code, documents, logs, datasets, or generated reports through the
model context.

Today that shared workspace is powerful but informal. A parent can tell a child
to write `design.md`, and another child can read it, but Flue does not know that
`design.md` is an artifact. There is no structured way to answer:

- Which task produced this file?
- Which files are the meaningful outputs of this run?
- Which artifact should a later task read instead of scanning the whole
  workspace?
- Did a child revise an earlier artifact or create a competing one?
- Which large context was kept out of the prompt by passing a file reference?

The research spike on managed agents points to the same lesson: a shared
filesystem is the cost lever for large inter-agent context, but without a
workspace protocol it turns into convention, prompts, and hope. Flue should keep
the filesystem advantage while adding enough structure for agents, users, and
future tooling to reason about artifacts.

## Goals

- Give Flue agents a first-class way to publish and discover artifacts in a
  shared workspace.
- Preserve the token-saving path: pass small artifact references instead of
  copying large file contents through prompts.
- Attribute artifacts to the session, task, role, and model that produced them.
- Make task outputs visible in events, `flue run`, and future inspection tools.
- Avoid a central mutable manifest as the v1 coordination point.
- Stay portable across Flue's current `SessionEnv` filesystem surface.

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
- fail if the target does not exist;
- record whether the target is a file, directory, or symbolic link;
- record file size from `stat()` when available;
- keep `title` and `summary` bounded so events and task details stay small.

The protocol does not add a permissions boundary inside a shared sandbox. Agents
that share a sandbox can already read and write the same files. Artifact records
make that activity discoverable; they do not make untrusted agents safe to run
in the same workspace.

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
  id: string;
  channel: string;
  kind: ArtifactKind;
  path: string;
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

Agents should not need to hand-edit JSON records. Flue can add two built-in
tools:

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

artifact_list({
  channel?: string;
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
  - Add built-in `artifact_publish` and `artifact_list` tools.
- `packages/cli/bin/flue.ts`
  - Render artifact publication events.

## Open Questions

- Should artifact tools be enabled by default, or only when `init()` opts into
  artifact channels?
- Should records live under `.flue-runtime/` by default for all sandbox modes,
  or should local sandbox users be required to choose a runtime directory?
- Should `artifact_publish` compute SHA-256 digests for files in v1, or should
  digest calculation be best-effort and skipped for large directories?
- Should the task result include full `ArtifactRef` objects or only artifact
  ids, to keep events and task details smaller?
- Should Flue automatically publish files created through the `write` tool when
  the model includes a channel hint, or should publication always be explicit?
