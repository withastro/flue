---
title: Skills
description: Add Agent Skills to Flue agents and invoke them from sessions.
lastReviewedAt: 2026-06-12
---

Flue supports [Agent Skills](https://agentskills.io/specification): reusable instructions and supporting resources that agents can load for specialized, repeatable work, such as applying a review process, following an operational workflow, or using shared project guidance. Skills can be bundled with your application or supplied by the runtime workspace where an agent operates.

Skills guide agent work; they do not add executable capabilities. Use [tools](/docs/guide/tools/) or [sandboxes](/docs/guide/sandboxes/) when an agent needs actions or workspace access.

## Add a skill

Flue lets you import an Agent Skill from your project or an installed package. Flue packages its instructions and supporting files with your application so an initialized harness can use it without depending on files in its runtime workspace.

To keep an application-owned skill next to the agents and workflows that use it, add its directory to your project. This guide uses `src/skills/`:

```text title="Application-owned skill"
src/
├─ agents/
│  └─ assistant.ts
├─ skills/
│  └─ review/
│     ├─ SKILL.md
│     └─ references/
│        └─ checklist.md
└─ workflows/
   └─ review-change.ts
```

The example stores the skill in `src/skills/` alongside other authored source, but its location does not make it available on its own. Import its `SKILL.md` to include it in the application and make it available to an agent. See [Project Layout](/docs/guide/project-layout/) for how Flue organizes authored source.

## Import a skill

Import your skills with the `skill` import attribute (a new feature in modern JavaScript). Once imported, pass the imported reference to the agent's `skills` configuration:

```ts title="src/agents/assistant.ts"
import { createAgent } from '@flue/runtime';
import review from '../skills/review/SKILL.md' with { type: 'skill' };
import triage from '../skills/triage/SKILL.md' with { type: 'skill' };
import investigate from '../skills/investigate/SKILL.md' with { type: 'skill' };

export default createAgent(() => ({
  model: 'anthropic/claude-sonnet-4-6',
  skills: [review, triage, investigate],
}));
```

Each import produces a skill reference and includes that skill directory in the application build. Passing those references in `skills` makes the skills available to this agent by their declared names.

Skills can also be imported from installed packages:

```ts
import review from '@acme/review-skills/review/SKILL.md' with { type: 'skill' };
```

The package must publish `SKILL.md` and its supporting files. If it defines package exports, it must export the imported `SKILL.md` subpath.

Imported skill directories are deployed application content: ordinary supporting files beside `SKILL.md` are included without additional imports. Do not store credentials, private keys, or runtime secrets in a skill directory that your application imports. Flue rejects common sensitive files and symbolic links inside imported skill directories when packaging them.

Flue also loads skills from the sandbox where a harness runs, with no import required. At context initialization, it discovers [Agent Skills](https://agentskills.io/specification)-compatible directories under `<cwd>/.agents/skills/`:

```text title="Workspace-provided skill"
<cwd>/
└─ .agents/
   └─ skills/
      └─ review/
         ├─ SKILL.md
         └─ references/
            └─ checklist.md
```

Each discovered skill is available by its declared name without a TypeScript import or an entry in `skills`, and its supporting files remain in that sandbox workspace. This lets a repository checkout, CI environment, or prepared runtime workspace provide its own skills to a harness. See [Sandboxes](/docs/guide/sandboxes/) for controlling the filesystem and working directory visible at runtime.

If an imported skill registered on an agent and a discovered workspace skill declare the same name, initialization fails rather than choosing one implicitly.

## Frontmatter support

Flue validates every `SKILL.md` against the [Agent Skills specification](https://agentskills.io/specification), whether the skill is imported or discovered in a workspace. The table below lists Flue's support level for each frontmatter field:

| Field           | Spec     | Flue support                                                                                                                                                  |
| --------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`          | Required | Validated: lowercase letters, numbers, and hyphens; no leading, trailing, or consecutive hyphens; at most 64 characters; must match the skill directory name. |
| `description`   | Required | Validated: non-empty, at most 1024 characters. Tells the agent what the skill does and when to use it.                                                        |
| `license`       | Optional | Accepted; informational only.                                                                                                                                 |
| `compatibility` | Optional | Accepted; at most 500 characters; informational only.                                                                                                         |
| `metadata`      | Optional | Accepted; string-to-string mapping; not interpreted by Flue.                                                                                                  |
| `allowed-tools` | Optional | Accepted, not enforced. The field is experimental in the spec and support may vary between implementations; Flue does not restrict the session's toolset.     |

Unknown frontmatter fields are ignored, so skills that carry extra host-specific fields still load. The spec's [`skills-ref` validator](https://github.com/agentskills/agentskills/tree/main/skills-ref) flags unknown fields if you want stricter authoring checks.

## Invoke a skill

Normally you can trust the agent to use the skills you provide it, as needed, to complete its work.

In workflows, you can manually trigger a skill through the `session.skill(name: string)` API method. This works with both registered imported skills and workspace-discovered skills.

```ts title="src/workflows/review-change.ts"
import type { FlueContext } from '@flue/runtime';
import * as v from 'valibot';
import review from '../skills/review/SKILL.md' with { type: 'skill' };

export async function run({ init, payload }: FlueContext<{ change: string }>) {
  const harness = await init({
    model: 'anthropic/claude-sonnet-4-6',
    skills: [review],
  });
  const session = await harness.session();

  const response = await session.skill('review', {
    args: { change: payload.change },
    result: v.object({
      approved: v.boolean(),
      summary: v.string(),
    }),
  });

  return response.data;
}
```

`args` provides input for this invocation of the skill. The `result` schema makes `response.data` a validated structured result; omit it when you want text output from `response.text`. The string passed to `session.skill(...)` is the declared skill name, not a path to `SKILL.md`.

See the [Agent API](/docs/api/agent-api/) for operation options and response types.

## Next steps

- [Agent Skills specification](https://agentskills.io/specification) — create and structure compatible skills.
- [Agents](/docs/guide/building-agents/) — configure an agent's model and capabilities.
- [Tools](/docs/guide/tools/) — add executable capabilities that a skill may direct an agent to use.
- [Sandboxes](/docs/guide/sandboxes/) — control the runtime workspace where discovered skills and their files are available.
- [Agent API](/docs/api/agent-api/) — look up session operation options and result types.
