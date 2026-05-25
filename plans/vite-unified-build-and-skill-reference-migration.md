# Unified Vite Build Graph and `SkillReference` Migration Plan

## Purpose

This document is the implementation plan for migrating Flue from its existing split build/imported-skill architecture to a single, clean architecture centered on **Vite as the authored application module graph** for both Node and Cloudflare, with the official **Cloudflare Vite plugin** owning Cloudflare platform integration.

This is not an exploratory spike plan. A focused spike has already demonstrated that the core design is viable. This plan defines the intended final architecture, the migration sequence, required verification, and the legacy code that must be deleted before the migration is considered complete.

An engineer should be able to execute this plan without knowledge of the conversation that led to it. For the exploratory rationale and original decision gates, consult:

- `plans/vite-build-graph-and-agent-skills-spike.md`
- `plans/runtime-cli-simplification-roadmap.md`

Where those documents conflict with this plan on build direction or imported-skill representation, **this plan supersedes them**.

---

# Executive decision

## Architecture decision

Flue will drive toward the following final architecture:

1. **Vite is the one authored application graph for both supported deployment targets.**
   - Application modules include agents, workflows, channels, app modules, imported helpers, and statically imported Agent Skills.
   - Node and Cloudflare may produce different deployment artifacts, but they must use the same authored-module semantics and shared Flue Vite plugins.

2. **Cloudflare uses the official `@cloudflare/vite-plugin` integration.**
   - Flue should invoke/configure it as part of actual `flue build` and `flue dev` behavior.
   - The existing Cloudflare `_entry.bundled.js` preprocessing path must not remain in the completed migration.

3. **An imported `SKILL.md` always evaluates to a lightweight `SkillReference`.**
   - It does not expose `body`, eager `resources`, or packaged file contents to authored application code.
   - It identifies a raw packaged Agent Skill directory owned by the built application/runtime.

4. **Packaged imported skills and workspace-discovered skills remain separate loading modes, but obey one Agent Skills validation contract.**
   - Packaged imported skills are compiled application capabilities represented by `SkillReference`.
   - Workspace-discovered skills are runtime filesystem content, loaded from a session sandbox/workspace.
   - Both are valid only if they conform to the official Agent Skills contract.

5. **Legacy build-time imported-skill behavior is removed, not preserved as a permanent compatibility layer.**
   - No final union type such as `SkillDefinition | SkillReference` for static `SKILL.md` imports.
   - No final esbuild imported-skill transformer alongside a Vite imported-skill transformer.
   - No final production `ViteNodePlugin`/`NodePlugin` or `ViteCloudflarePlugin`/`CloudflarePlugin` split.

## Why this decision was made

The existing architecture is functional but has two important structural problems:

- Static Agent Skill imports compile to eager body/resource-bearing values, which conflicts with the desired progressive-disclosure model where imports grant access to packaged skill directories through lightweight references.
- Cloudflare skill handling currently requires Flue to preprocess/bundle Worker source before platform tooling bundles it again, hiding the authored source graph from the platform development/build integration and creating unnecessary build-graph complexity.

The spike proved a viable replacement architecture:

- attributed `SKILL.md` imports can remain authored as `with { type: 'skill' }` while being safely transformed by a Vite plugin;
- imported values can be lightweight references;
- complete skill directories can be packaged and made available lazily at runtime;
- Node artifacts can be produced through a Vite vertical slice;
- Cloudflare Worker/Durable Object output can build and execute under the official Cloudflare Vite/workerd integration;
- Vite development invalidation can update changed, added, removed, and no-longer-imported skill files;
- runtime access can be scoped safely for direct activation and connector-backed sandboxes.

The goal of the migration is therefore not to maintain the spike beside the old implementation. The goal is to use the spike evidence to replace the old architecture cleanly.

---

# Terminology and user-facing model

Use project terminology consistently:

```txt
Agent profile                 — one reusable `defineAgentProfile(...)` value
Created agent                 — one runtime initializer from `createAgent(...)`
Agent module                  — `agents/<name>.ts`; default-exports a created agent
└─ AgentInstance              — URL `<id>`; provided to `createAgent(({ id }))`
   └─ Harness                 — runtime-initialized agent environment; defaults to name `"default"`
      └─ Session              — one `harness.session(name?)`; defaults to `"default"`
         └─ Operation        — one `session.prompt` / `skill` / `task` / `shell` call
            └─ Turn          — one LLM round-trip inside pi-agent-core
Workflow                     — `workflows/<name>.ts`; exports `run(...)`
└─ Workflow run/invocation   — unique `ctx.id === runId`; initializes created agents when needed
```

Runs are workflow-only. Direct agent prompts, WebSocket agent operations, and dispatched inputs operate in persistent sessions and must not be described as runs.

## Imported Agent Skill authoring contract

Users continue authoring raw Agent Skills directories:

```txt
skills/
└── review/
    ├── SKILL.md
    ├── LICENSE.txt
    ├── references/
    │   └── checklist.md
    ├── scripts/
    │   └── inspect.py
    ├── assets/
    │   └── template.bin
    └── schemas/
        └── response.json
```

Application source imports a packaged reference:

```ts
import review from '../skills/review/SKILL.md' with { type: 'skill' };

export default createAgent(() => ({
	model: 'anthropic/claude-sonnet-4-6',
	skills: [review],
}));
```

It may also activate that reference directly:

```ts
await session.skill(review);
```

The final imported type is:

```ts
interface SkillReference {
	readonly __flueSkillReference: true;
	readonly id: string;
	readonly name: string;
	readonly description: string;
}
```

The import must never expose the instruction body or packaged files as ordinary properties on the value.

## Agent Skills behavioral contract

Use the official Agent Skills specification as the behavioral reference:

- <https://agentskills.io/specification>

Required semantics:

- `SKILL.md` is required.
- Required frontmatter includes valid `name` and `description`.
- `name` must satisfy specification constraints and match the skill directory name.
- Supported optional frontmatter fields must be validated consistently.
- Metadata may be advertised before activation.
- Full instructions are loaded on activation.
- Additional files are loaded only when needed.
- Files beyond `scripts/`, `references/`, and `assets/` are permitted and must have a deliberate packaging policy.

---

# Final target architecture

## High-level architecture

```txt
Project source tree
  agents/ | workflows/ | channels/ | app.ts | skills/
                         │
                         ▼
             Flue discovery of topology
       (filenames/layout/config/platform exports only)
                         │
                         ▼
                Generated source entry
                         │
                         ▼
                  Shared Vite graph
       ┌─────────────────┼─────────────────┐
       │                 │                 │
 authored TS/JS    Flue skill plugin   shared virtual/bootstrap modules
       │                 │                 │
       └─────────────────┼─────────────────┘
                         ▼
                 target adapter/output
             ┌───────────┴───────────┐
             ▼                       ▼
       Node server artifact   Cloudflare official Vite plugin
                                  + workerd/build output
```

## Responsibility boundaries

### CLI responsibilities

`packages/cli/` owns:

- discovering project topology from filenames and configured source layout;
- resolving Flue configuration and target selection;
- generating minimal Node/Cloudflare source entry modules and target configuration;
- assembling shared Vite configuration/plugins;
- invoking target-specific build/dev adapters;
- emitting deployable output and CLI diagnostics.

The CLI must **not** infer authored module behavior by parsing agent/workflow implementation syntax. Authored modules remain evaluated module values.

### Shared Vite build-layer responsibilities

The shared Vite layer owns:

- processing authored source module dependencies;
- recognizing valid attributed static Agent Skill imports/re-exports;
- building the packaged-skill manifest/store for reachable imported skills;
- tracking packaged inputs and invalidating development modules correctly;
- supplying shared virtual modules needed by generated entries/runtime bootstrap.

### Runtime responsibilities

`packages/runtime/` owns:

- public `SkillReference` and internal packaged-directory types;
- harness/session activation semantics;
- advertised versus directly activated packaged skill access;
- packaged-file access through safe runtime tools/overlays;
- common Agent Skills validation where runtime discovery or runtime activation needs it;
- runtime module normalization/resource registry work described in `plans/runtime-cli-simplification-roadmap.md` where that work remains applicable.

### Target adapter responsibilities

Node and Cloudflare adapters own only platform-specific output/plumbing:

| Concern | Node adapter | Cloudflare adapter |
| --- | --- | --- |
| Runtime entry | Node Hono/server/WebSocket bootstrap | Worker + Durable Object exports/bootstrap |
| Artifact | Runnable server output | Worker output/config via official Cloudflare Vite integration |
| Platform bindings | Node runtime environment | Wrangler/Cloudflare bindings, migrations, DOs |
| Authored import graph | Shared Vite behavior | Shared Vite behavior |
| Static Agent Skill semantics | `SkillReference` | `SkillReference` |

Target adapters must not develop separate static Agent Skill compilers or different public semantics.

---

# Existing implementation and spike state at plan creation

## Production architecture before migration

At the latest committed baseline preceding this migration:

- `packages/cli/src/lib/build.ts` routes default targets to existing production `NodePlugin` and `CloudflarePlugin` strategies.
- Node uses an esbuild-based output flow.
- Cloudflare uses a generated entry plus an imported-skill preprocessing output named `_entry.bundled.js`, consumed by Wrangler/platform tooling.
- Imported skills are transformed through:
  - `packages/cli/src/lib/skill-plugin.ts`
  - `packages/cli/src/lib/skill-bundle.ts`
  - `packages/cli/src/lib/skill-frontmatter.ts`
- Those imports produce eager `SkillDefinition` values with selected bundled resources.
- Selected resource packaging is limited to conventional `scripts/`, `references/`, and `assets/` paths.

## Verified prototype work available at plan creation

At the time this plan was written, the working tree contains an experimental, uncommitted Vite/reference implementation. An engineer starting later must first inspect git state and determine whether this work has since been checkpointed, amended, replaced, or discarded.

Experimental additions/changes include:

- `packages/cli/src/lib/vite-skill-reference-plugin.ts`
- experimental build strategies and adapter subclasses in:
  - `packages/cli/src/lib/build.ts`
  - `packages/cli/src/lib/build-plugin-node.ts`
  - `packages/cli/src/lib/build-plugin-cloudflare.ts`
  - `packages/cli/src/lib/types.ts`
- runtime `SkillReference` and packaged-skill handling in:
  - `packages/runtime/src/types.ts`
  - `packages/runtime/src/session.ts`
  - `packages/runtime/src/result.ts`
  - `packages/runtime/src/agent.ts`
  - `packages/runtime/src/index.ts`
  - `packages/runtime/types/skill-md.d.ts`
- focused tests in:
  - `packages/runtime/test/vite-skill-reference-plugin.test.ts`
  - `packages/runtime/test/vite-cloudflare-build.test.ts`
  - `packages/runtime/test/build-plugin-node.test.ts`
  - `packages/runtime/test/build-plugin-cloudflare.test.ts`
  - `packages/runtime/test/skill-resource-tool.test.ts`
  - `packages/runtime/vitest.spike.config.ts`

### Prototype findings already proven

The prototype has executable evidence for all of the following:

1. **Authored syntax preservation**
   - `import review from '../skills/review/SKILL.md' with { type: 'skill' }` works through Vite.
   - Valid attributed barrel re-exports work.
   - Plain `SKILL.md` imports, `?raw`, `?url`, arbitrary query forms, and user-spelled internal marker attempts are rejected.
   - Vite/Rolldown did not reliably expose authored static import attributes through ordinary `resolveId()` options; AST-aware source transformation was required to preserve the syntax safely.

2. **Lightweight reference representation**
   - Imported values contain `__flueSkillReference`, `id`, `name`, and `description` only.
   - They do not include `body` or packaged `files`.

3. **Complete-directory packaging**
   - A referenced skill directory can package `SKILL.md`, conventional directories, and ordinary additional files such as `LICENSE.txt`.
   - Large file packaging emits a warning comparable to the existing legacy behavior.

4. **Development invalidation**
   - Vite development reload behavior has tests for modified packaged files, modified `SKILL.md`, new files, removed files, nested path additions/removals, and removing the import itself from an authored module.
   - Correct handling required canonical/real filesystem path normalization because Vite module IDs use real paths on macOS temporary directories.

5. **Runtime activation and capability boundaries**
   - Registered references and direct `session.skill(reference)` activation can resolve packaged instructions and supporting files.
   - Direct activation can grant access for that operation without exposing merely imported-but-unregistered files to ordinary prompts.
   - Packaged read paths are namespaced by reference identity rather than name to avoid same-name collisions.
   - Connector-backed sessions can read active packaged files without receiving unrestricted filesystem-read capability if their connector omitted a normal `read` tool.
   - Binary files under `assets/` retain base64 behavior and large assets can be read through bounded/paginated output.

6. **Node vertical slice**
   - A Vite-built Node artifact can execute representative workflow behavior and return lightweight imported references.

7. **Cloudflare vertical slice**
   - A generated Worker entry can be built using `@cloudflare/vite-plugin` with Flue Durable Object configuration.
   - Actual workerd-backed development execution can run a deterministic workflow and observe a lightweight imported skill reference.

### Last known verification commands/results

At plan creation, after prototype corrections, these commands passed:

```bash
# packages/runtime
pnpm run check:types
pnpm run build
pnpm run test                    # 192 tests passed
pnpm run test:spike:cloudflare   # 2 tests passed

# packages/cli
pnpm run check:types
pnpm run build
```

These results prove the candidate's vertical slices; they do not mean production target selection or full feature parity has already migrated.

---

# Final architecture invariants

The following invariants are requirements, not optional aspirations. Any migration change that makes one temporarily false must identify its removal/follow-up in the same implementation series and must not be treated as final.

## Build graph invariants

1. Vite is the only authored application module graph in the completed architecture.
2. Node and Cloudflare use the same Flue skill-reference plugin and imported-skill semantics.
3. Cloudflare does not consume a Flue-prebundled whole authored program solely for static skills.
4. Generated entries contain platform bootstrap/configuration, not a second user-module compiler.
5. Filesystem discovery determines topology and platform exports; runtime evaluation determines authored module behavior.

## Imported skill invariants

1. A static attributed `SKILL.md` import has one public runtime type: `SkillReference`.
2. The import value never exposes skill instructions or packaged file contents directly.
3. Referenced raw skill directories are packaged according to one documented policy on both targets.
4. `skills: [reference]` advertises/grants the packaged skill to the harness.
5. `session.skill(reference)` activates the packaged skill directly even when it was not pre-registered.
6. Skill package identity prevents same-name packaged directories from returning each other's files.
7. Access to packaged files does not silently expand connector/tool capabilities.

## Runtime skill invariants

1. Packaged and workspace-discovered skills use one validation contract derived from the official Agent Skills spec.
2. Their loading modes may differ: packaged reference versus runtime filesystem discovery is a legitimate distinction.
3. Supporting file access preserves content correctly, including binary assets under the documented policy.
4. Any virtual/mounted packaged storage namespace is framework-owned and non-conflicting.

## Cleanup invariants

Before this migration is complete:

1. Experimental adapter class duplication is removed.
2. Legacy imported-skill esbuild compilation is removed from production code.
3. Transitional static import union typing is removed.
4. Cloudflare `_entry.bundled.js` processing is removed.
5. Tests no longer assert both imported-skill contracts as supported final behavior.
6. Documentation describes the new architecture only, with any explicitly retained compatibility behavior time-boxed.

---

# Deliberate product/API decisions

These decisions are made by this plan and should not be reopened during implementation unless evidence shows a severe blocker.

## Decided: Vite is the final shared authored graph

Do not preserve separate Node esbuild and Cloudflare Vite authored-module systems as the final solution merely because Node's existing path works. Platform output adapters may differ; authored import semantics must not.

## Decided: imported skills become `SkillReference`

Do not retain eager imported `SkillDefinition` values as the final static-import contract. `SkillDefinition` may still exist internally or publicly for genuinely runtime/discovered/in-memory skill definitions if that use remains meaningful; it must not describe static Vite `SKILL.md` imports after migration.

## Decided: Cloudflare uses official Vite integration

Do not implement a second narrow Cloudflare-only source rewriter as the final architecture. The prototype demonstrates that official Cloudflare Vite/workerd integration can host the Flue Worker/Durable Object entry and imported skill plugin.

## Decided: complete intended raw skill directories are supported

Do not restrict packaged imported skills to only `scripts/`, `references/`, and `assets/`. Agent Skills may contain files elsewhere, such as `LICENSE.txt` and schemas. The migration must define safe exclusions/diagnostics rather than silently dropping spec-permitted files.

## Decided: direct activation remains supported

`session.skill(reference)` is a meaningful capability and should remain. It means “activate this packaged skill for this operation,” while agent-profile registration means “make this skill available/advertised in this harness.”

---

# Implementation details still requiring a final choice

These are bounded design items, not reasons to retain dual architecture.

## Packaged-skill inclusion/exclusion policy

The prototype packages every regular file recursively beneath an imported skill directory and warns for files larger than 1MB. Before production adoption, document and implement the final policy:

- whether dotfiles are packaged;
- whether `.gitignore` or a Flue-specific ignore mechanism affects packages;
- whether generated/cache directories are excluded automatically;
- whether likely secret files inside a skill directory fail the build or remain the user's responsibility with warnings;
- whether symlinks are disallowed, followed safely, or rejected explicitly;
- warning/error threshold policy for large files and total package size.

Recommended direction:

- Package all ordinary skill files by default to match the raw-directory model.
- Reject unsafe symlink escapes.
- Ignore known repository/tool metadata only if explicitly documented.
- Warn on large files initially; consider build failure only after real usage data.
- Provide a clear diagnostic that imported skill directories become deployable application content.

## Packaged file runtime access model

The prototype uses a framework-owned packaged-file read namespace keyed by package identity. Before finalization, decide whether this remains the primary model or whether some sandboxes need opt-in materialization for execution of scripts/assets.

Required regardless of the implementation:

- reading arbitrary packaged files works safely;
- binary behavior is defined;
- connector-backed sandboxes do not get new unrestricted capabilities accidentally;
- script execution expectations are documented/tested for supported sandboxes.

Recommended direction:

- Keep a read-only packaged overlay for general instructions/references/assets.
- Add explicit materialization/execution support only where a supported skill/sandbox use case requires it; do not silently copy packages into mutable session workspaces at initialization.

## Stable package identity

The prototype derives IDs from a canonical absolute directory path. That proves collision isolation but is not desirable as a final artifact identity because identical builds in different local/CI paths produce different IDs.

Final implementation must use an identity derived from a stable project/build-relative module identity, for example:

```txt
skill:<validated-name>:<hash-of-project-relative-canonical-skill-path>
```

or another deterministic representation that:

- distinguishes distinct same-named packaged skills;
- is stable across machines and build directories for identical authored source layout;
- does not expose arbitrary absolute host paths.

## Cloudflare configuration and deployment ownership

The prototype successfully uses existing Flue-generated Wrangler input configuration via `configPath` with the official Cloudflare Vite plugin. Before removing existing production flow, prove or finalize:

- generated Durable Object bindings and migrations;
- `FlueRegistry` configuration;
- user binding merge behavior including AI/R2/Worker Loader/container-related inputs where supported;
- generated build output/deploy command behavior;
- whether hidden deploy redirect output remains necessary or should be removed;
- local versus remote Cloudflare development support.

Recommended direction: retain Flue's deterministic config/binding/migration merge logic as input to official Vite integration unless programmatic configuration demonstrably preserves every necessary operational path more cleanly.

---

# Anti-spaghetti migration rules

These rules govern implementation sequencing and review acceptance.

1. **Every transitional branch needs a deletion milestone.**
   - If an old and new path coexist during migration, the PR/commit series must state exactly which later phase deletes the old path.

2. **Do not add new behavior to legacy imported-skill code.**
   - Bug fixes strictly required to maintain comparison/testing are acceptable.
   - New capability belongs in the Vite/reference architecture.

3. **Do not expose transitional unions as a stable contract.**
   - `SkillDefinition | SkillReference` may exist only while both implementation paths run during the migration branch.
   - Its deletion is a hard acceptance gate.

4. **Switch tests from comparison mode to replacement mode quickly.**
   - Early tests may compare old/new behavior.
   - Once a production adapter switches, tests should assert only the chosen reference contract for static imports.

5. **Do not merge a half-migration as the intended release state.**
   - Local checkpoint commits and migration-branch commits are encouraged.
   - A releasable/mergeable end state must meet the deletion and parity gates below, or be explicitly scoped as a non-release internal branch.

6. **Preserve real platform behavior, not accidental implementation layers.**
   - Preserve Hono routing, Durable Objects, migrations, state/session durability, bindings, channels, dispatch, WebSockets, and supported sandbox capabilities.
   - Remove intermediate bundles, duplicated compilers, ambiguous output redirects, or watcher workarounds when the new platform integration makes them unnecessary.

7. **Prefer refactoring shared infrastructure before copying new target variants.**
   - The new design exists to unify the graph. Avoid adding equivalent Vite logic independently to Node and Cloudflare templates where it can live in shared build infrastructure.

---

# Migration workstreams and phase order

The phases below are ordered to preserve a recoverable implementation path while actively eliminating legacy complexity. Each phase should be separately reviewable where practical, but phases that leave dual contracts must be completed on a migration branch rather than released as a stable product state.

## Phase 0: Preserve spike evidence and establish the migration branch

### Goal

Preserve the verified prototype as a recoverable checkpoint, then move from experimental naming/parallel comparison into production-shaped implementation work.

### Work items

1. Inspect the current git state:

```bash
git status --short
git diff --stat HEAD
git log --oneline -10
git stash list
```

2. If the verified prototype remains uncommitted, review that it contains only intended spike work and create a local checkpoint commit if authorized by the branch owner. Suggested intent of commit message:

```txt
spike: prove Vite skill references and Cloudflare integration
```

3. Preserve the existing earlier abandoned Cloudflare-only prototype stash, if still present, for reference only. Do not merge it into the Vite migration.

4. Re-run the prototype verification matrix before refactoring:

```bash
# packages/runtime
pnpm run check:types
pnpm run build
pnpm run test
pnpm run test:spike:cloudflare

# packages/cli
pnpm run check:types
pnpm run build
```

5. Record any changed test counts or dependency/version drift in the implementation handoff/commit description.

### Acceptance criteria

- There is a recoverable commit or branch reference for the proven spike.
- Baseline migration work begins from passing prototype tests.
- No abandoned target-specific rewriter is folded into the new architecture.

---

## Phase 1: Convert prototype modules into final shared Vite build infrastructure

### Goal

Replace experimental/prototype framing with a shared production-shaped Vite graph implementation, while tests still permit comparison with legacy output until adapters switch.

### Key files to inspect/refactor

- `packages/cli/src/lib/vite-skill-reference-plugin.ts`
- `packages/cli/src/lib/build.ts`
- `packages/cli/src/lib/types.ts`
- `packages/cli/src/lib/build-plugin-node.ts`
- `packages/cli/src/lib/build-plugin-cloudflare.ts`
- `packages/cli/package.json`
- `packages/cli/tsdown.config.ts`

### Work items

1. Rename/refactor the skill plugin from prototype terminology into its intended shared build role.
   - Suggested conceptual name: `skillReferencePlugin` or `agentSkillsPlugin`.
   - Keep it target-neutral.

2. Extract reusable Vite configuration assembly from conditional build branches.
   - Shared plugins should be installed once for both targets.
   - Shared dependency resolver/bootstrap logic should not be buried inside Node-specific code if Cloudflare or future targets need it.

3. Replace absolute-path-derived skill IDs with deterministic project-relative IDs.
   - Add tests showing identical logical fixture layout produces equivalent IDs irrespective of temporary absolute root.
   - Retain same-name/different-relative-path isolation tests.

4. Finalize packaged file policy.
   - Add tests for permitted arbitrary files, hidden/symlink/excluded policy, large file warning behavior, binary behavior, and unsafe cases.
   - Update error text to tell users that importing a skill packages its included files into the deployed application.

5. Keep attributed-import enforcement strict.
   - Supported forms must include direct attributed static imports and attributed static re-exports.
   - Reject plain `SKILL.md` imports, unsafe query bypasses, and spellable internal marker bypasses.
   - Decide explicitly whether dynamic attributed imports are unsupported; if unsupported, fail with a clear diagnostic and test it.

6. Establish published dependency ownership.
   - The final CLI code must not dynamically invoke dependencies available only as local dev dependencies in a published package.
   - Decide whether `vite` and `@cloudflare/vite-plugin` are direct dependencies, optional dependencies, or peer dependencies with actionable installation diagnostics.
   - Set and test compatible ranges for Vite, Cloudflare Vite plugin, and Wrangler/config behavior.

### Tests

Maintain and extend:

- Vite imported skill direct import and barrel re-export tests.
- Syntax rejection tests.
- complete-directory packaging tests.
- HMR/invalidation tests.
- deterministic identity tests.
- packaging-policy tests.

### Acceptance criteria

- The shared Vite skill plugin is production-shaped, target-neutral, and no longer labeled as an experiment internally.
- Package IDs are deterministic across build locations.
- Package file policy and binary handling are tested and documented in code-facing diagnostics or documentation drafts.
- Published dependency installation strategy is implemented/tested.

---

## Phase 2: Make `SkillReference` the only static imported-skill runtime contract

### Goal

Convert runtime and static-import typing from transitional dual behavior to the final `SkillReference` model.

### Key files to inspect/refactor

- `packages/runtime/src/types.ts`
- `packages/runtime/src/index.ts`
- `packages/runtime/types/skill-md.d.ts`
- `packages/runtime/src/result.ts`
- `packages/runtime/src/session.ts`
- `packages/runtime/src/agent.ts`
- `packages/runtime/src/context.ts`
- `packages/runtime/src/skill-frontmatter.ts`

### Required conceptual distinction

Do not remove `SkillDefinition` merely because static imports no longer return it. Determine whether it remains a legitimate representation for runtime-created or workspace-discovered skills. The required removal is narrower and important:

- **Remove `SkillDefinition` as the output of static imported `SKILL.md` modules.**
- **Remove legacy build-time eager embedded-resource logic whose only purpose was that imported representation.**

### Work items

1. Change static declaration typing to one imported contract:

```ts
declare module '*/SKILL.md' {
	import type { SkillReference } from '@flue/runtime';
	const skill: SkillReference;
	export default skill;
}
```

2. Make `SkillReference` and relevant activation APIs stable/public as needed.

3. Refactor packaged-skill runtime logic into coherent modules instead of indefinitely appending branches to general session/tool files.
   - Consider a focused internal packaged-skill module responsible for package resolution, read-path formatting, content decoding, and activation prompt construction.
   - Keep session orchestration readable and avoid growing imported-skill special cases throughout unrelated logic.

4. Maintain access semantics:
   - registered packaged reference is available to its harness operations;
   - direct `session.skill(reference)` has operation-scoped package access when not registered;
   - imported-but-unused references do not leak accessible files into prompts;
   - same-name packages resolve by identity;
   - connectors that omit ordinary read capability receive only packaged-path reads, not arbitrary filesystem reads.

5. Decide and implement workspace collision behavior.
   - If a packaged registered skill and workspace-discovered skill advertise the same user-visible name, fail explicitly or establish a deterministic documented namespace/precedence rule.
   - Do not silently shadow.

6. Unify Agent Skills validation for packaged and workspace-discovered catalog skills.
   - Reuse strict spec parsing/validation.
   - Preserve intentional lazy workspace loading behavior.
   - Remove permissive duplicate frontmatter parsing logic if still present.

### Tests

Required runtime tests include:

- imported static type expectations where type tests exist;
- registered packaged activation by name/reference;
- direct activation without registration;
- no unregistered ordinary-prompt resource exposure;
- same-name/different-id isolation;
- packaged/workspace name collision behavior;
- connector-provided `read` wrapping behavior;
- connector without `read` receives packaged-only reader and cannot read ordinary sandbox files;
- text additional file access;
- binary and large binary asset access;
- strict workspace discovery validation parity.

### Acceptance criteria

- Static imported `SKILL.md` values have only the `SkillReference` type and behavior.
- Runtime behavior is organized around a documented packaged-skill capability model.
- Runtime-discovered skill behavior remains meaningful and follows the same validity contract.
- The transitional `SkillDefinition | SkillReference` imported-static contract is deleted.

---

## Phase 3: Replace the Node production build path with shared Vite output

### Goal

Make `flue build --target node`, `flue dev --target node`, and any Node-backed `flue run` behavior consume the shared Vite graph and final static skill-reference contract.

### Key files to inspect/refactor

- `packages/cli/src/lib/build.ts`
- `packages/cli/src/lib/build-plugin-node.ts`
- Node development/run orchestration files under `packages/cli/src/lib/`
- Node runtime/build tests in `packages/runtime/test/`

### Work items

1. Replace experimental `ViteNodePlugin` branching with the actual `NodePlugin` implementation.
   - There must not be a permanent production/experimental class split.
   - Remove strategy conditionals that exist solely to compare `esbuild` versus `vite` once the switch is made.

2. Produce the deployable Node server artifact through Vite using the shared Flue plugins.

3. Preserve required Node behavior:
   - Node 22.18+ target/support expectations;
   - Hono default/custom app behavior;
   - HTTP agent/workflow/channel routes;
   - Node WebSocket behavior;
   - `flue run` workflow invocation and SSE behavior;
   - source maps and understandable error locations;
   - supported dependency externalization behavior;
   - native dependency behavior needed by sandbox/tool dependencies.

4. Characterize and solve Vite replacement compatibility rather than retaining esbuild by default.
   - Dynamic CommonJS/native dependency cases need tests or documented intentional support constraints.
   - Use Vite/Rolldown externalization/configuration where needed.

5. Remove Node-specific legacy skill preprocessing use immediately once Node switches.

### Tests

- Existing Node build-plugin/runtime artifact tests under Vite.
- Imported `SkillReference` through a built Node artifact.
- Registered/direct activation where executable fixture support permits.
- HTTP app routes and mounted channel app routes.
- WebSocket behavior.
- `flue run` behavior.
- Dependency/native-module fixture coverage sufficient for currently supported sandbox/tool paths.

### Acceptance criteria

- The default Node target selects only the Vite-backed implementation.
- Node static skills always use `SkillReference`.
- No legacy static skill preprocessing is involved in Node builds.
- Existing meaningful Node server behavior passes under the new implementation.
- The experimental `ViteNodePlugin` class/strategy is removed or renamed into the only `NodePlugin` implementation.

---

## Phase 4: Replace the Cloudflare production build/dev path with official Vite integration

### Goal

Make actual Cloudflare CLI commands use the official Cloudflare Vite/workerd integration, preserving required Worker/Durable Object behavior while deleting the prebundle architecture.

### Key files to inspect/refactor

- `packages/cli/src/lib/build.ts`
- `packages/cli/src/lib/build-plugin-cloudflare.ts`
- `packages/cli/src/lib/cloudflare-wrangler-merge.ts`
- `packages/cli/src/lib/dev.ts`
- Cloudflare-related examples/tests under `examples/` and `packages/runtime/test/`

### Work items

1. Replace experimental `ViteCloudflarePlugin` branching with the actual `CloudflarePlugin` implementation.
   - Cloudflare generated config points at the source entry consumed by Vite/official plugin, not `_entry.bundled.js`.

2. Integrate `@cloudflare/vite-plugin` into real `flue build --target cloudflare` behavior.
   - Determine generated artifact/output ownership.
   - Keep Flue's deterministic generation of DO exports/bindings/migrations unless a clearly superior configuration model is fully proven.

3. Integrate official workerd-backed behavior into real local `flue dev --target cloudflare` behavior.
   - Remove custom reload/restart machinery only after each behavior it supplied is either naturally covered by Vite or deliberately replaced.
   - Avoid rewrites/restarts when generated topology/config output has not changed.

4. Prove platform behavior before removing old support:
   - default and custom Hono applications;
   - direct agent HTTP routes;
   - workflow invocation and run/result/stream behavior;
   - generated agent/workflow Durable Object exports;
   - `FlueRegistry` and SQLite-backed state/migration correctness;
   - channel applications and dispatch where supported;
   - WebSocket agent/workflow transport;
   - ordinary user bindings such as Workers AI/R2 fixtures;
   - Worker Loader/sandbox/container support if it is part of current supported product behavior.

5. Decide local/remote Cloudflare development contract.
   - The official Vite path is the intended local dev/build architecture.
   - If remote Wrangler-backed development remains necessary, expose/document it intentionally; do not let it force a second static skill/build graph.

6. Decide/remove old deployment/config side effects.
   - Reassess hidden `.wrangler/deploy/config.json` redirect generation.
   - Reassess implicit sandbox Durable Object aliasing and container-specific workaround logic.
   - Keep only behaviors that are explicitly supported and tested in the new model.

### Tests

The Cloudflare production switch must have executable integration coverage, not only generated-source string assertions:

- official Vite build output for generated Worker/DO application;
- workerd-backed direct HTTP/workflow behavior;
- imported skill reference and activated packaged-file behavior;
- DO state/migration/registry behavior;
- channel route behavior;
- WebSocket behavior modeled after `examples/cloudflare-websocket/` and existing tests;
- binding/config passthrough fixtures;
- sandbox/container/Worker Loader fixture or an explicit supported-feature decision;
- local edit/HMR tests for regular modules, helpers, skill files, and topology regeneration.

### Acceptance criteria

- The default Cloudflare target uses official Vite integration for build and local development.
- The generated Worker input is source graph preserving; `_entry.bundled.js` is not needed.
- Cloudflare static skills use the exact same `SkillReference` contract as Node.
- Required Durable Object, migration, binding, Hono, WebSocket, and supported sandbox behavior passes.
- The experimental `ViteCloudflarePlugin` class/strategy is removed or renamed into the only `CloudflarePlugin` implementation.

---

## Phase 5: Delete legacy imported-skill/build architecture and transitional branches

### Goal

Complete the migration by deleting history-driven implementation paths. This phase is mandatory; the migration is not complete if it is deferred indefinitely.

### Mandatory deletion ledger

Inspect each file before deletion/refactoring because some shared validation helpers may be retained in a new home. Remove the obsolete responsibilities, even if a file name remains for a different purpose.

| Legacy responsibility | Current/relevant location | Required final action |
| --- | --- | --- |
| esbuild static imported-skill transform producing eager `SkillDefinition` | `packages/cli/src/lib/skill-plugin.ts` | Delete from production architecture; delete file if no remaining responsibility. |
| broad/intermediate skill preprocessing bundle | `packages/cli/src/lib/skill-bundle.ts` | Delete. |
| legacy selected-resource build-time packaging used for static imported definitions | `packages/cli/src/lib/skill-frontmatter.ts` | Delete or refactor so only genuinely shared strict parsing remains elsewhere; no static eager imported-definition packager. |
| Cloudflare `_entry.bundled.js` generation/config main path | `packages/cli/src/lib/build.ts`, `packages/cli/src/lib/build-plugin-cloudflare.ts` | Delete all use/output/tests. |
| legacy Node skill preprocessing branch | `packages/cli/src/lib/build.ts` | Delete all use/output/tests. |
| experimental-versus-production adapter subclasses and `bundle` comparison modes | `packages/cli/src/lib/build-plugin-node.ts`, `build-plugin-cloudflare.ts`, `types.ts`, `build.ts` | Collapse to single Vite-backed target adapters and remove obsolete strategies. |
| static import union type | `packages/runtime/types/skill-md.d.ts` | Replace with `SkillReference` only. |
| imported eager bundled-resource activation path retained solely for static imports | `packages/runtime/src/result.ts`, `session.ts`, `agent.ts` | Delete if no legitimate non-static consumer remains; retain only clearly justified runtime-definition behavior. |
| tests asserting legacy static-import semantics or experimental side-by-side behavior | `packages/runtime/test/` | Replace with final contract tests; delete comparison-only assertions/config where no longer needed. |

### Additional cleanup review

Also review whether successful official Vite integration permits deletion/simplification of:

- custom Cloudflare reloader/watch behavior in `packages/cli/src/lib/dev.ts`;
- hidden deploy redirect generation;
- implicit sandbox alias/magic configuration;
- obsolete generated-output cleanup/tombstone code;
- duplicated generated Node/Cloudflare runtime module normalization, coordinated with `plans/runtime-cli-simplification-roadmap.md`.

Do not delete real platform features merely because their implementation needs moving. Keep coverage for behavior before deleting its old implementation.

### Acceptance criteria

- Search results show no production references to legacy imported-skill transformer or `_entry.bundled.js` flow.
- Static skill imports type and behave only as `SkillReference`.
- Default Node and Cloudflare targets each have one build path, both using shared Vite plugin infrastructure.
- No test suite needs an “experimental spike path” to prove normal supported behavior; expensive platform integration tests may remain in a separate command if that is intentional for CI/runtime cost, but they must exercise production code paths.

---

## Phase 6: Documentation, examples, and release readiness

### Goal

Document the chosen architecture and user-facing behavior without exposing migration history as product complexity.

### Work items

1. Update root/project architecture guidance and relevant package docs:
   - Vite/shared graph ownership;
   - Node and Cloudflare output behavior;
   - official Cloudflare Vite plugin/platform requirements;
   - any remote development workflow.

2. Document Agent Skill authoring:
   - raw directory layout;
   - attributed import syntax;
   - `SkillReference` behavior;
   - `skills: [reference]` versus `session.skill(reference)` semantics;
   - packaged file inclusion/exclusion policy;
   - binary asset/read/script execution policy;
   - workspace-discovered skill distinction and validation requirements.

3. Update examples to use the final architecture and contract.
   - Include at least one imported raw skill with an additional top-level file.
   - Include a Cloudflare example exercising official Vite integration and an appropriate binding/DO surface.

4. Add changelog/release note entries for breaking behavior:
   - static imported skills now evaluate to references instead of eager definitions;
   - strict workspace skill validation if newly enforced;
   - changed Cloudflare build/dev/deploy setup;
   - any intentionally removed legacy sandbox/config behavior.

5. Verify publish/install behavior from packed packages, not only monorepo linked dependencies.
   - A consumer fixture installing the built/published-shape CLI/runtime should be able to build Node and Cloudflare applications under documented dependency setup.

### Acceptance criteria

- Documentation describes one supported final architecture.
- Example applications and install-shape tests use production code paths.
- Breaking changes and migration instructions are explicit.
- There is no undocumented reliance on monorepo-only dev dependencies.

---

# Verification matrix for the final migration

## Required commands during implementation

Use repository scripts as they exist at execution time. At plan creation, the known required checks are:

```bash
# packages/runtime
pnpm run check:types
pnpm run build
pnpm run test
pnpm run test:spike:cloudflare  # rename/re-purpose as production integration test when migration lands

# packages/cli
pnpm run check:types
pnpm run build
```

If a lint command exists or is added in repository guidance/package scripts, run it before completing each implementation milestone.

## Skill build/plugin tests

| Scenario | Required expected behavior |
| --- | --- |
| Direct attributed static import | Produces `SkillReference`; packages directory. |
| Attributed static re-export/barrel | Produces same reference behavior. |
| Transitive ordinary module graph | Skill is included naturally through Vite reachability. |
| Plain `SKILL.md` import | Rejected with actionable attribute diagnostic. |
| Query attempts such as `?raw`, `?url`, internal marker spellings | Rejected unless a deliberately supported public syntax replaces attributes uniformly. |
| Invalid skill metadata/name/directory mismatch | Fails with clear official-spec-aligned diagnostic. |
| Extra top-level/nested permitted file | Packaged and accessible. |
| Two same-named skills at distinct paths | Distinct deterministic references and non-colliding resources. |
| Identical source layout at different absolute build roots | Same deterministic package identity. |
| Symlink/hidden/ignored/large file behavior | Matches finalized packaging policy. |

## Runtime packaged skill tests

| Scenario | Required expected behavior |
| --- | --- |
| Registered reference in an agent profile | Metadata advertised; skill activatable; files readable when allowed. |
| `session.skill(reference)` without registration | Activation works and grants that package only for the operation. |
| Merely imported but unused/unregistered reference | Does not expose package files to ordinary prompts. |
| Registered same-name package and directly activated different-ID package | Activated reference reads its own files only. |
| Text packaged supporting files | Read correctly and lazily. |
| Binary assets | Preserved through documented base64/binary access semantics. |
| Large binary assets | Retrievable through bounded/paginated reads. |
| Connector provides `read` | Packaged paths work without corrupting normal connector semantics. |
| Connector omits `read` | Packaged-only read available when needed; arbitrary filesystem reads are not granted. |
| Workspace/package advertised name collision | Explicit documented error or deterministic policy, never silent shadowing. |
| Workspace `SKILL.md` validation | Same validity contract as packaged skill metadata. |

## Vite development graph tests

| Change | Required expected behavior |
| --- | --- |
| Modify `SKILL.md` metadata/body | Updated reference/prompt/package visible without stale value. |
| Modify arbitrary packaged file | Updated packaged file visible. |
| Add permitted file | New file appears in package. |
| Delete packaged file | File disappears. |
| Add/delete nested directory content | Package updates correctly. |
| Remove skill import from authored graph | Package is not retained in dev registry. |
| Modify normal imported helper/module | Application behavior updates through normal Vite graph. |
| Add/remove topology module | Flue regenerates required target topology/config and runtime updates intentionally. |

## Node target tests

- Runnable produced server artifact.
- Default/custom Hono app behavior.
- Direct agent route.
- Workflow route/run invocation and `flue run` behavior.
- Mounted channel app route and dispatch behavior where applicable.
- Node WebSocket behavior.
- Static packaged skill reference and activation/file access.
- Supported native/dynamic dependency/externalization fixture behavior.

## Cloudflare target tests

Tests must execute against official Cloudflare Vite/workerd integration for behavior that depends on Worker platform execution.

- Generated Worker builds through official plugin.
- Direct agent request works.
- Workflow request/run/result behavior works.
- Agent/workflow Durable Object exports and routing work.
- `FlueRegistry`, session state, and migration behavior work.
- Default/custom Hono apps work.
- Channel route and dispatch behavior work where supported.
- WebSocket behavior works.
- User binding configuration passes through correctly.
- Imported packaged skills work under workerd.
- Supported sandbox/container/Worker Loader behavior works or is explicitly removed with approved product decision and documentation.
- Local dev source/skill HMR behavior works.

## Package/install/operations tests

- Published-shape dependency installation can build a Node fixture.
- Published-shape dependency installation can build/run an appropriate Cloudflare fixture under documented setup.
- Deployment output/config behavior is documented and does not rely on obsolete hidden redirect state unless intentionally retained.
- Remote-development behavior has a documented, tested answer if it remains supported.

---

# Completion definition

The unified Vite/`SkillReference` migration is complete only when all of the following are true:

1. Default Node and Cloudflare CLI commands use Vite-based authored-module graph handling.
2. Cloudflare platform execution/build/dev uses official Cloudflare Vite integration for the supported local/build workflow.
3. Static attributed `SKILL.md` imports have one public output contract: `SkillReference`.
4. Node and Cloudflare provide equivalent imported-skill behavior.
5. Complete intended Agent Skill directories package according to a documented, tested safety/content policy.
6. Runtime activation/access semantics are safe, lazy, collision-free, and connector-capability preserving.
7. Workspace-discovered and packaged skills obey one validation contract, while retaining intentionally different loading modes.
8. Required Node and Cloudflare behavioral surfaces pass executable tests.
9. The legacy imported-skill transformer/prebundle and `_entry.bundled.js` Cloudflare architecture are deleted.
10. Transitional experimental versus production adapters and imported-type unions are deleted.
11. Documentation/examples/package installation describe and exercise the final architecture.

A branch that has successful new tests but still retains old and new build/imported-skill systems as supported permanent code does **not** meet this definition.

---

# Suggested implementation commit/PR sequence

Exact commits may vary, but the sequence should visibly converge toward deletion rather than growing parallelism:

1. **Checkpoint the verified Vite/SkillReference prototype**
   - preserve executable spike evidence before structural refactoring.

2. **Refactor Vite skill/plugin infrastructure into final shared form**
   - deterministic ids, final packaging policy, dependency strategy, clean plugin naming.

3. **Finalize runtime `SkillReference` capability model and validation parity**
   - organized packaged-skill runtime modules, access/collision/connector semantics, static type contract.

4. **Switch Node production adapter to Vite and remove its legacy static skill path**
   - update Node tests to final behavior.

5. **Switch Cloudflare production adapter/dev/build to official Vite integration**
   - prove platform parity; remove `_entry.bundled.js` and replaced dev/config behavior.

6. **Delete legacy imported-skill/compiler/transition code**
   - collapse adapters/strategies; remove union typing and comparison-only tests.

7. **Documentation/examples/install-shape/release work**
   - ensure the user sees one clean architecture.

If implementation discovers a blocker requiring temporary coexistence longer than one adjacent migration milestone, stop and document the blocker explicitly before adding more compatibility branches.

---

# Immediate next actions

For the engineer beginning implementation from the current spike state:

1. Inspect status/history and preserve the verified prototype in a local checkpoint commit if permitted.
2. Re-run the full prototype verification matrix.
3. Begin Phase 1 by refactoring the Vite skill plugin into final shared infrastructure rather than adding more experimental target variants.
4. Implement deterministic project-relative package identity and the final packaged-file safety policy before wiring production target selection.
5. Switch production adapters one target at a time on the migration branch, with deletion of replaced legacy responsibilities immediately following their replacement tests.
6. Do not consider the effort complete until Phase 5 deletion gates and Phase 6 documentation/install gates are satisfied.
