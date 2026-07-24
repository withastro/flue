---
title: Skills
description: Teach agents reusable expertise with progressively disclosed instructions and supporting files.
lastReviewedAt: 2026-07-21
---

A **skill** packages reusable expertise — instructions written in markdown, optionally with supporting files — that an agent loads only when it needs it. Where a [tool](/docs/guide/tools/) executes application code, a skill teaches a procedure.

Skills follow the open [Agent Skills](https://agentskills.io) format, so a skill written for Flue works in other harnesses that speak the format, and third-party skills drop into your agents unchanged.

## What is a skill?

Every skill has three parts:

- **`name`** — a short identifier (`refunds`, `review-pr`) the model uses to activate it.
- **`description`** — one or two sentences stating what the skill does _and when to use it_. This is the only part the model always sees, so it carries the entire routing decision.
- **`instructions`** — the full procedure, loaded only on activation.

A skill may also carry **supporting files** — checklists, templates, reference documents — that stay unloaded until the model explicitly reads one.

Skills are **progressively disclosed**: each mounted skill costs one always-present catalog line (name + description) in the system prompt, and nothing more until the model decides the task at hand matches. Then it activates the skill, receives the full instructions, and reads supporting files only as needed. An agent can carry dozens of skills without paying for their content on every turn.

## Author a skill directory

A skill on disk is a directory containing a `SKILL.md` file. The frontmatter holds the name and description; the markdown body is the instructions. Anything else in the directory becomes a supporting file:

```text
src/skills/refunds/
├─ SKILL.md        # frontmatter + instructions
└─ POLICY.md       # supporting file, loaded only if read
```

```markdown title="src/skills/refunds/SKILL.md"
---
name: refunds
description: Process a customer refund request end-to-end. Use when a customer asks for a refund or disputes a charge.
---

Follow this procedure for every refund request:

1. Confirm the order ID and the reason for the refund.
2. Read `POLICY.md` and check the eligibility rules for that reason.
3. If eligible, issue the refund with the `issue_refund` tool and confirm the amount to the customer.
4. If not eligible, explain which rule applies and offer the alternatives listed in the policy.
```

The description is what the model reads when deciding whether the skill applies — state the capability and the trigger ("Use when…"). Keep `SKILL.md` focused on the procedure, and move bulky reference material into supporting files the instructions point at.

### Frontmatter fields

Flue validates every `SKILL.md` against the [Agent Skills specification](https://agentskills.io/specification), whether the skill is imported or discovered in a workspace:

- `name` (required) — lowercase letters, numbers, and hyphens; no leading, trailing, or consecutive hyphens; at most 64 characters; must match the skill directory name.
- `description` (required) — non-empty, at most 1024 characters. Tells the agent what the skill does and when to use it.
- `license` (optional) — accepted; informational only.
- `compatibility` (optional) — accepted; at most 500 characters; informational only.
- `metadata` (optional) — accepted; string-to-string mapping; not interpreted by Flue.
- `allowed-tools` (optional) — accepted, not enforced. The field is experimental in the spec and support may vary between implementations; Flue does not restrict the session's toolset.

Unknown frontmatter fields are ignored, so skills that carry extra host-specific fields still load. The spec's [`skills-ref` validator](https://github.com/agentskills/agentskills/tree/main/skills-ref) flags unknown fields if you want stricter authoring checks.

## Import and mount a skill

Import the `SKILL.md` file by its module specifier, like any other module. At build time, Flue recognizes the import, validates the frontmatter, and packages the entire directory with your application. The import's value is a typed `SkillReference`; mount it with the [`useSkill`](/docs/reference/agent-hooks-api/#useskill) hook:

```ts title="src/agents/support-agent.ts"
'use agent';
import { useModel, useSkill } from '@flue/runtime';
import refunds from '../skills/refunds/SKILL.md';

export function SupportAgent() {
  useModel('anthropic/claude-haiku-4-5');
  useSkill(refunds);
  return 'Answer customer support questions clearly and accurately.';
}
```

There is no registration step and no runtime file copying — the import is the declaration, and it works everywhere your project builds: the dev server, `vite build`, and `flue run`. Type declarations for `SKILL.md` and `.md` imports ship with `@flue/runtime`, and in dev, editing any file in the skill directory picks up the change automatically.

An import from a package works the same way:

```ts
import review from '@acme/review-skills/review/SKILL.md';
```

The package must publish `SKILL.md` and its supporting files; if it defines package exports, it must export the imported `SKILL.md` subpath.

A few rules to know:

- Skill imports must be **static** — a dynamic `import('./skills/x/SKILL.md')` is a build error.
- Each skill name mounts **once per render**; mounting the same name twice throws.
- Packaging skips repository noise (`node_modules`, `.git`, `dist`, and similar), warns on files over 1MB, and **refuses to package secrets** — `.env` files, private keys, credential stores, and symbolic links are hard errors.

Mounts can be conditional, like every resource hook — gate `useSkill(...)` on [persistent state](/docs/guide/agent-hooks/#persisted-state) to unlock a skill mid-conversation. The runtime announces catalog changes to the model without invalidating your cached prompt; see [Dynamic resources](/docs/reference/agent-api/#dynamic-resources) for the mechanics.

## Inline skills with `defineSkill`

When the content is short, generated, or assembled from data, declare the skill in code with [`defineSkill(...)`](/docs/reference/agent-api/#defineskill):

```ts title="src/skills/escalation.ts"
import { defineSkill } from '@flue/runtime';

export const escalation = defineSkill({
  name: 'escalation',
  description:
    'Escalate an unresolved case to a human specialist. Use when the customer asks for a human or the issue is out of scope.',
  instructions:
    'Summarize the case so far, tag the conversation with the escalation reason, and hand off with the `escalate_case` tool.',
});
```

Pass the result to `useSkill(escalation)` exactly like an import. A definition is equivalent to a skill directory: `instructions` is the `SKILL.md` body, and an optional `files` map carries supporting resources keyed by relative path:

```ts
const reviewSkill = defineSkill({
  name: 'review-pr',
  description: 'Review a pull request against the team checklist. Use when asked to review code.',
  instructions: 'Read CHECKLIST.md, then review the diff against every item.',
  files: { 'CHECKLIST.md': checklistText },
});
```

`defineSkill` validates the definition and returns it frozen — no packaging happens at definition time. When the skill is first needed, the runtime packages it into the same shape a `SKILL.md` import produces, writing spec-valid frontmatter itself.

`defineSkill` also converts markdown that isn't named `SKILL.md`. A bare `.md` import loads as a plain string — nothing is packaged — so pass it through `defineSkill` to make it a skill:

```ts
import { defineSkill } from '@flue/runtime';
import runbook from './incident-runbook.md'; // plain markdown text

export const incidents = defineSkill({
  name: 'incidents',
  description:
    'Run the incident response procedure. Use when an outage or security event is reported.',
  instructions: runbook,
});
```

`useSkill(...)` also accepts a definition object written directly in the call, with the same validation. See [`SkillDefinition`](/docs/reference/agent-api/#skilldefinition) for every field and constraint.

## How activation works

Mounted skills appear in an **Available Skills** section of the system prompt — one line each, name and description. Alongside it, the runtime provides an `activate_skill` tool. When the model judges that a task matches a skill's description, it calls the tool with the skill's name and receives the full instructions as the tool result.

Because instructions arrive as a tool result, the system prompt never changes when a skill activates, and the provider's cached prompt prefix survives. Activating an unknown name is not an error — the result lists the skills that are available.

Because activation is a tool call, your instructions can direct it:

```ts
useSkill(refunds);
return 'Activate the `refunds` skill before handling any refund request.';
```

The same steering works from application code. A [harness tool](/docs/guide/tools/#harness-tools)'s `harness.prompt(...)` runs with the agent's rendered configuration — same system prompt, skill catalog, and tools — so naming the skill in the prompt text is enough for the model to activate it there too, workspace-discovered skills included.

For content the agent should _always_ have, don't use a skill: import the markdown as a string and fold it into your instructions, or pass it to [`useInstruction(...)`](/docs/reference/agent-hooks-api/#useinstruction).

## Supporting files at runtime

A packaged skill's supporting files travel inside your application bundle, not the agent's workspace. Nothing is copied into the sandbox: the runtime serves each file read-only at a virtual path, and the activation briefing lists every resource with the exact path to read it from. The model's file-reading tools resolve those paths transparently — including a `read_skill_resource` tool the runtime adds whenever a mounted skill carries supporting files — while the workspace itself stays untouched.

The same bundle serves the same files on your laptop, in Node.js, or on Cloudflare — no per-environment filesystem setup, and an agent can never accidentally edit its own skill content.

## Workspace skills

There is one more way an agent with a [sandbox](/docs/guide/sandboxes/) picks up skills: discovery from its workspace. At session start, the runtime scans `.agents/skills/` in the sandbox's working directory, and every valid `<name>/SKILL.md` it finds joins the catalog alongside your declared skills — no import, no `useSkill(...)` call:

```text
<cwd>/.agents/skills/
└─ greet/
   └─ SKILL.md
```

Workspace skills stay in the workspace. Their instructions are read from disk at activation time — so mid-session edits are picked up — and their supporting files are ordinary workspace files the model reads directly. A malformed workspace `SKILL.md` is skipped with a warning rather than failing the session (imported skills, by contrast, are validated strictly at build time, where an error is actionable). A workspace skill whose name collides with a declared skill is an error.

Use workspace skills when the expertise ships with the workspace — a repository checkout, CI environment, or prepared runtime workspace with its own conventions for any agent that works in it — and declared skills when it belongs to your application.

## Next steps

- [Agent Skills specification](https://agentskills.io/specification) — the full `SKILL.md` format, shared across compatible harnesses.
- [Agent Hooks](/docs/guide/agent-hooks/) — how `useSkill` composes with the rest of an agent's capabilities.
- [Agent Hooks API](/docs/reference/agent-hooks-api/#useskill) — the full contract for `useSkill`, `defineSkill`, and `SkillDefinition`.
- [Tools](/docs/guide/tools/) — executable application capabilities, and when a tool beats a skill.
- [Subagents](/docs/guide/subagents/) — delegate a whole procedure to a specialist agent instead of teaching it.
- [Sandboxes](/docs/guide/sandboxes/) — the workspace where workspace skills are discovered.
