---
title: Agent Behavior
description: How an agent behaves when you run it, including the default tools, environment, message handling, context rules, and limits.
---

This page describes the tools a Flue agent's model gets by default, the
environment it runs in, how incoming messages are handled, what its
context window contains, and the limits the runtime enforces. It describes
runtime behavior, not an authoring API. Each section links to the pages that
define these behaviors. Flue's inner agent loop builds on
[pi's](https://pi.dev) agent core. Everything below describes Flue's own
behavior. For the pi coding agent's equivalents, see
[pi's usage docs](https://pi.dev/docs/latest/usage).

## Built-in tools

An agent with a [sandbox](/docs/guide/sandboxes/) attached gets six tools that
operate on it. The model calls these tools. Application code and sandbox
adapters use the lower-level [`Sandbox`](/docs/reference/sandbox-api/#sandbox)
API that these tools are built on, which has whole-file verbs and no
truncation.

### `read`

Reads a file. Parameters: `path`, optional `offset` (line number to start
from, 1-indexed), optional `limit` (maximum lines).

- Output is truncated to **2000 lines or 50 KB**, whichever is hit first, and
  never mid-line. Truncated output ends with a marker naming the shown range
  and the offset to continue from (`Use offset=N to continue.`), so the model
  can page through files of any length.
- An `offset` past the end of the file is an error naming the file's actual
  line count.
- A single line larger than the byte budget is returned as its first 50 KB
  with a note that the remainder is not reachable via `offset`/`limit`.

### `write`

Writes a file whole. Parameters: `path`, `content`. Creates the file and any
missing parent directories. Overwrites the file without warning when it exists.

### `edit`

Exact-text replacement. Parameters: `path`, `oldText`, `newText`, optional
`replaceAll`.

- `oldText` must match exactly one region of the file. Zero matches is an
  error telling the model to check whitespace and indentation. Multiple
  matches is an error asking for more surrounding context, unless
  `replaceAll` is set, which replaces every occurrence and reports the count.
- The read → replace → write transaction is atomic per file. Tool calls in
  one batch run in parallel, and same-file mutations from `write` and `edit`
  are serialized through a per-path lock. A conflict therefore surfaces as a
  "could not find" error instead of a silently lost edit. A `bash` command
  mutating the same file concurrently is not synchronized.

### `bash`

Executes a shell command in the sandbox. Parameters: `command`, optional
`timeout` (seconds).

- Returns combined stdout/stderr, truncated to the **last** 2000 lines or
  50 KB (the tail is where errors and final results live). A non-zero exit
  appends the exit code.
- A command that exceeds `timeout` returns a recoverable exit-124 result
  rather than failing the operation, so the model can react.

### `grep`

Searches file contents. Parameters: `pattern` (regex), optional `path`,
`include` (glob filter), `literal`.

- Runs `rg` inside the sandbox when available (probed once), falling back to
  POSIX `grep -E`.
- Returns matching lines with file paths and line numbers, capped at **100
  matches** and **500 characters per line**. When it hits the cap, it reports
  this with advice to narrow the search.

### `glob`

Finds files by name. Parameters: `pattern`, optional `path`. Uses shell
`find -name` semantics (the pattern matches file names, not paths) and
returns up to **1000** paths.

### Framework tools

Independent of any sandbox, the framework adds `task` for
[subagent delegation](/docs/guide/subagents/)
(always present; inert until agents are declared), `activate_skill` when the
agent has [skills](/docs/guide/skills/), and `read_skill_resource` when an
imported skill packages resource files. These names are reserved, so a custom
tool can't use them.

A sandbox adapter may replace the six sandbox tools with its own set (see
[Sandbox-provided tools](/docs/guide/sandboxes/#sandbox-provided-tools)).
Check an integration's documentation before assuming ordinary file or
command tools are present.

## Environment defaults

An agent has **no sandbox unless you attach one** with
[`useSandbox()`](/docs/reference/agent-hooks-api/#usesandbox), and at most
one. Without a sandbox, the six file and shell tools aren't in the tool set,
no workspace context enters the system prompt, workspace skills aren't
discovered, and [`harness.sandbox`](/docs/reference/agent-api/#harnesssandbox)
throws. Custom tools, imported skills, subagents, and state work the same
either way.

Attaching a sandbox defines tools, workspace discovery, skills, and what
subagents inherit, all at once. The [Sandboxes
guide](/docs/guide/sandboxes/#what-a-sandbox-adds) walks through them.
Presence is re-read at every turn boundary, so a conditional `useSandbox()`
can attach or detach the environment mid-conversation. The runtime tells the
model about the swap with an [`environment`
signal](/docs/reference/agent-api/#dynamic-resources).

## Message handling

Every input (HTTP prompt, `dispatch()`, channel delivery, scheduled trigger)
is admitted as a **submission** and recorded durably before any model work
begins. Submissions for one conversation form a queue processed in admission
order, and the agent does not sit idle behind a busy conversation's turn:

- One submission runs at a time.
- A message that arrives while the agent is busy **joins the live response at
  the next turn boundary** when it can. Otherwise it waits its turn as its
  own submission. Nothing is dropped, because a delivery that misses the
  live response runs on its own afterward.
- Every accepted submission reaches exactly one durable terminal outcome
  (`completed`, `failed`, or `aborted`), no matter how many crashes happen in
  between.

The [Durability guide](/docs/guide/durability/) covers retries, recovery, and
abort mechanics. [Routing](/docs/guide/routing/) covers the wire protocol (the
`202` admission response, streaming).

## Context composition

At initialization the runtime composes the system prompt from what it finds.
It always includes the agent function's returned instructions. When a sandbox
is attached, it also includes the working directory path, a directory
listing, the contents of `AGENTS.md` when present, and the discovered skill,
subagent, and tool rosters.

The system prompt is then **frozen**. It keeps describing the workspace and
catalogs discovered at initialization until the next compaction rebaselines
it against the current environment. Mid-window changes (tools mounting or
unmounting, skills flipping, the environment swapping) reach the model as
append-only [signals](/docs/reference/agent-api/#dynamic-resources) instead
of prompt rewrites. This keeps the transcript's earlier turns consistent with
the prompt they ran under. It also keeps the system prompt's share of the
provider's prompt cache warm, though a tool change invalidates the cache
through the native tools array.

## Context management

When the conversation approaches the model's context window, the runtime
compacts it, folding older messages into a summary and preserving recent
ones verbatim. Threshold compaction triggers when used tokens exceed the window
minus a model-aware reserve (capped at 20,000 tokens). The most recent 8,000
tokens are kept verbatim by default.
[`CompactionConfig`](/docs/reference/agent-hooks-api/#compactionconfig)
controls both values, the summarization model, and opting out. Overflow
recovery and explicit
[`harness.compact()`](/docs/reference/agent-api/#harnesscompact) compact even
when threshold compaction is disabled.

## Limits

The numbers the runtime enforces, collected from the sections above plus
subagent delegation:

| Limit                          | Value                                                                                                     |
| ------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `read` output                  | 2000 lines / 50 KB, head-truncated with continuation marker                                               |
| `bash` output                  | 2000 lines / 50 KB, tail-truncated                                                                        |
| `grep` results                 | 100 matches, 500 chars per line                                                                           |
| `glob` results                 | 1000 paths                                                                                                |
| Delegation depth               | 4. A `task` chain (including harness invocations) deeper than this fails with `delegation_depth_exceeded` |
| Compaction reserve             | model-aware, capped at 20,000 tokens                                                                      |
| Kept verbatim after compaction | 8,000 tokens by default                                                                                   |

Tool-set size has no framework cap, but every mounted tool uses context.
See [Conditional tools](/docs/guide/tools/#conditional-tools) for keeping the
set small.
