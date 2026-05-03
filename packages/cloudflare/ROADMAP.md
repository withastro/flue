# @flue/cloudflare — Agents SDK Integration Roadmap

> Written: April 16, 2026
> Status: v1 shipped (build plugin + containers + doStore). This document captures the plan for deeper Agents SDK integration.

## Context

The Cloudflare Agents SDK is not a competing agent framework — it's a collection of distributed systems primitives (stateful DOs, WebSockets with hibernation, durable execution, scheduling, sub-agents, state sync) built on Cloudflare infrastructure. Flue should treat it as the **runtime substrate** on Cloudflare, the same way a framework targets a runtime.

v1 (current) uses the Agents SDK superficially — we extend `Agent` but only use `onRequest()`. The roadmap below progressively integrates deeper primitives to make Flue on Cloudflare rock-solid and feature-rich.

## Architecture Principles

- **Flue's API should work on both Node and Cloudflare.** If a feature ships on CF, it should also ship on Node — unless the difference is invisible to the user (e.g., durable execution prevents data loss on CF; Node doesn't have this problem because processes are long-lived).
- **Conversation history is Flue's responsibility, not the Agents SDK's.** The base `Agent` class has no concept of messages or LLM interactions. `AIChatAgent` does, but we intentionally don't use it — Flue's session model (skills, roles, sandbox, compaction, structured results) is richer and must be portable.
- **The session store is our checkpoint mechanism.** Because `Session` already saves after every turn, durable session storage (via `this.sql`) gives us turn-level recovery for free. We don't need `stash()` for conversation data.

---

## Phase 1 (v1.1): Invisible Reliability

No Flue API changes. No Node equivalents needed. Just making the CF deployment rock-solid.

### 1. Durable Execution (`runFiber()`)

**Problem:** If a CF Worker/DO is evicted mid-prompt (code deploy, resource limit, alarm timeout), the in-flight work is silently lost. `keepAliveWhile()` prevents idle eviction but doesn't help with forced eviction.

**Solution:** Wrap prompt execution in `runFiber()`. This gives us:

- Idle eviction prevention (`keepAlive()` is called internally by `runFiber`)
- A registered task in SQLite that the framework tracks
- Automatic detection of interrupted work — `onFiberRecovered()` fires when the DO wakes back up after an eviction
- Minimal stash (just session ID + agent name so the recovery hook knows what to resume)

**Key insight:** We don't need `stash()` for conversation data because the session store already persists after every turn. The value of `runFiber()` is the **automatic interruption detection + recovery hook**, not the checkpointing.

**On recovery (`onFiberRecovered()`):**

1. Load session from SQL (conversation history up to last completed turn)
2. Reconnect to the same container (same session ID — container is durable)
3. Resume the prompt loop, or mark the session as interrupted for the client to retry

**Why not `keepAliveWhile()` alone:** It only prevents idle eviction. If a forced eviction happens (code deploy, resource limit), there's no recovery hook — work just dies silently. `runFiber()` is strictly more powerful and calls `keepAlive` internally.

**Why not `stash()` for conversation data:** Flue uses an agent harness model — `pi-agent-core` runs the LLM loop autonomously. Flue doesn't control the loop between turns, so we can't call `stash()` at fine-grained points. But we don't need to — the session store already saves after every turn via `Session` calling `store.save()`.

### 2. Move Session Storage from `this.state` to `this.sql`

**Problem:** Currently `DOSessionStore` uses `this.state` (a single JSON blob). Every save rewrites the entire conversation history. Doesn't scale for long conversations.

**Solution:** Use `this.sql` with proper tables:

- `messages` table — append-only, one row per message/tool-result
- `session_metadata` table — lightweight status, timestamps, config
- `compaction_state` table — compaction checkpoints

**Benefits:**

- Incremental writes (append a message vs. rewrite everything)
- Efficient partial reads (load last N messages for context window)
- Already durable — `this.sql` survives DO eviction, hibernation, restarts
- This IS the checkpoint mechanism that makes fiber recovery work
- Compaction becomes a SQL operation

**`this.state` still used for:** Lightweight metadata (agent name, status, timestamps). Small, syncs to clients if we later use state sync for UI.

**Filesystem recovery note:** For isolate mode (OverlayFs, in-memory), dirty files could also be persisted to `this.sql` on eviction. The 128MB per-DO SQLite budget is sufficient for typical agent workloads (modified source files, configs). For containers mode, the container filesystem is independently durable — no extra persistence needed.

---

## Phase 2 (v2): Real Features

These change Flue's API surface and need implementations on both Node and Cloudflare.

### 3. WebSocket Communication

**Problem:** SSE is one-way (server → client). Can't cancel a running agent, send follow-up prompts, or provide human-in-the-loop input without new HTTP requests.

**Solution:** WebSocket as primary transport, HTTP/SSE as fallback.

**Enables:**

- Client sends follow-up prompts on the same connection (multi-turn without new requests)
- Client cancels a running agent mid-execution
- Human-in-the-loop input (approve a tool call, provide clarification)
- Multiple clients observe the same session simultaneously (via `broadcast()`)

**On CF:** Uses Agents SDK's `onConnect` / `onMessage` / `onClose` with hibernation (zero-cost idle connections — WebSocket stays open, DO sleeps, wakes on message).

**On Node:** WebSocket server via `ws` package or Hono's WebSocket support.

**Flue API change:** `FlueRuntime` gains interaction methods (e.g., `flue.onInput()`, or a message-based protocol). The generated entry point handles the transport; agent code works the same on both platforms.

### 4. State Sync + Client SDK

**Problem:** No way for a UI to show live agent status without polling.

**Solution:** Real-time state sync from agent to client.

**Exposes:**

- Current status (thinking, executing tool, idle, waiting for input)
- Which tool is executing and its progress
- Conversation state updates in real-time

**On CF:** Uses `setState()` / `onStateChanged()` — the Agents SDK persists state and syncs to all connected clients. The `useAgent()` React hook gives reactive UI bindings for free.

**On Node:** WebSocket messages carrying the same state updates. Flue provides an equivalent `FlueClient` class for client-side consumption.

**Pairs with:** WebSocket transport (phase 2, item 3). State sync messages flow over the WebSocket connection.

### 5. Scheduling

**Problem:** Flue has a `cron` trigger concept in agent definitions (`export const triggers = { cron: '0 8 * * *' }`), but it's manifest-only — nothing actually executes the cron.

**Solution:** Make cron triggers real. Also enable agent self-scheduling.

**On CF:** Use `this.schedule(cronExpr, 'runAgent', { agentName })` in `onStart()`. The Agents SDK persists schedules to SQLite, fires alarms at the right time, handles idempotency. Also supports delayed execution (`this.schedule(300, ...)`) and intervals (`this.scheduleEvery(30, ...)`).

**On Node:** `node-cron` or similar scheduler library.

**Flue API addition:** `flue.schedule(when, callback)` — an agent can schedule future work during execution. Examples:

- "Check back in 5 minutes" → `flue.schedule(300, { action: 'followUp' })`
- "Run daily at 8am" → `flue.schedule('0 8 * * *', { action: 'dailyReport' })`
- Exponential backoff retry on failure

**Agents SDK scheduling features we'd leverage:**

- Cron, delayed, interval, and Date-based schedules
- Idempotent schedule creation (safe to call in `onStart()`)
- `getSchedules()` / `cancelSchedule()` for management
- Overlap prevention for intervals

---

## Phase 3 (v3): Advanced Primitives

### 6. Sub-Agents via `subAgent()`

**Problem:** `flue.task()` currently runs sub-tasks in the same DO. For heavy parallel workloads, this limits concurrency and isolation.

**Solution:** On CF, spawn child DOs via `subAgent()`. Each sub-agent gets:

- Its own isolated SQLite database
- Its own sandbox/container
- Independent execution (true parallelism)
- Typed RPC stub for parent-child communication

The parent calls `this.subAgent(WorkerAgent, 'task-1')` and gets back a stub with Promise-wrapped methods. Sub-agents can spawn their own children (nested delegation).

**On Node:** `flue.task()` continues using child Sessions in-process. Same Flue API, different underlying execution model.

**Agents SDK sub-agent features:**

- `subAgent(cls, name)` — get or create a named child
- `abortSubAgent(cls, name)` — forcefully stop a child (transitive — aborts its children too)
- `deleteSubAgent(cls, name)` — abort + wipe storage
- Sub-agents share the parent's machine but have isolated SQLite
- Only the parent DO needs a wrangler binding — children are auto-discovered

**Limitation:** Sub-agents can't use `schedule()` or `keepAlive()` — the parent must schedule on their behalf.

### 8. MCP Client Integration

**What it enables:** Agents dynamically connect to external MCP (Model Context Protocol) servers, gaining access to external tool ecosystems at runtime.

**Agents SDK provides:** `addMcpServer()`, `removeMcpServer()`, `getMcpServers()` — manages MCP server connections per agent instance.

**On Node:** MCP client library (the protocol is platform-agnostic).

**Flue API:** `flue.addMcpServer(url)` / `flue.removeMcpServer(url)` — available on both platforms.

---

## Summary Table

| Phase | Feature                 | CF Primitive                        | Node Equivalent                           | Flue API Change?        |
| ----- | ----------------------- | ----------------------------------- | ----------------------------------------- | ----------------------- |
| v1.1  | Durable execution       | `runFiber()` + `keepAlive()`        | Not needed (long-lived process)           | No                      |
| v1.1  | SQL session storage     | `this.sql`                          | `InMemorySessionStore` (or future SQLite) | No                      |
| v2    | WebSocket transport     | `onConnect`/`onMessage`/`broadcast` | `ws` package                              | Yes                     |
| v2    | State sync + client SDK | `setState()`/`useAgent()`           | WebSocket messages + `FlueClient`         | Yes                     |
| v2    | Scheduling              | `this.schedule()`                   | `node-cron` or similar                    | Yes                     |
| v3    | Sub-agents              | `subAgent()`                        | Child Sessions in-process                 | No (same `flue.task()`) |
| v3    | MCP client              | `addMcpServer()`                    | MCP client library                        | Yes                     |
