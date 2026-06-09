# Analytics Agent Merge Readiness

## Status

The Flue analytics agent is ready to merge as the AGI query-processing engine for the local web/slack app path. It reaches practical parity with the Claude Code SDK version for the core self-serve analytics workflows, while giving us cleaner orchestration boundaries and a better place to optimize later.

## Design Principle

What can be deterministic should be deterministic. Use code, schemas, explicit payload fields, registries, policy checks, and bounded state machines for routing, permissions, session naming, skill invocation, persistence paths, and artifact handling. Use LLM calls for interpretation, synthesis, judgment, and domain work only where deterministic code would be brittle or insufficient.

## Completed

- Reliable inter-agent contract:
  - Waiter owns intake, work-order creation, postflight gating, final response, and rework framing.
  - Explorer is a shared bounded research utility, not a kitchen station.
  - Stations receive structured work orders and return schema-validated results.
  - Postflight gate accepts, revises once, clarifies, or blocks.
- Explicit orchestration:
  - Mainline, side-question, rework, and topic-switch session planning exists.
  - Preflight explorer uses detached per-run sessions.
  - Station sessions are routed and named deterministically.
  - User "send back to kitchen" is modeled as rework with higher-scrutiny waiter behavior.
  - Waiter cannot call Flue's built-in task tool; all explorer/station calls are explicit runtime branches.
  - Forced workflow commands run shallowly when workflow mutation is disabled, instead of starting a full workflow station.
  - Requests the waiter cannot map to analytics, knowledge, workflow, or documentation can be rejected before explorer or station work.
- Skill invocation:
  - Project skills are bundled under `resources/skills`.
  - `project_skill_list` and `project_skill_read` expose skills progressively to agents.
  - The deterministic command contract is `/{skill-directory-name} user instructions`.
  - The skill directory name is the skill id and trigger string; migrated frontmatter aliases are informational only.
  - The FastAPI/Slack boundary parses skill commands and passes `forcedSkillId` / `forcedRoute` into Flue.
- Tool parity foundation:
  - dbt manifest search.
  - BigQuery validation/query helpers, including distinct/top-value exploration.
  - Metabase research/help/card creation, policy gated.
  - Slack search/thread read.
  - Google Drive search/list/read/download/create/upload, policy gated.
  - Jira automation scope/history/ticket/PR tools, mutation gated.
  - KB/source-catalog tools.
  - Firestore/GCS persistence tools.
  - Local/report artifact tools.
- Flue-FastAPI boundary:
  - FastAPI starts the bundled Flue server.
  - Web and Slack both invoke the same AGI bridge.
  - Session config carries user identity, form factor, attachments, OAuth tokens, personal context, personal skills, and forced skill metadata.
  - Flue session persistence supports GCS for stateless deployment.
  - Output files are uploaded to GCS/report storage.
- Deployment packaging:
  - `agi-agent/` contains built Flue `dist`, resources, source catalog, scripts, and skills.
  - Local app env defaults point at dev resources.
  - Claude-copy remains only as backup/reference during migration.

## Validation

- Flue analytics tool tests pass: `84 passed`.
- Flue node build passes for `examples/analytics`.
- FastAPI bridge Python compile passes.
- Targeted FastAPI tests pass for forced skill payload and deterministic skill command parsing.
- Local web/slack resource sync is complete in the AGI scaffold.

## Merge Scope

This merge should be treated as the AGI/Flue engine parity merge, not the final optimization pass.

Merge-worthy behavior:

- Core analytics questions can route through waiter/explorer/station/postflight.
- Named skills can be deterministically invoked.
- Existing Claude skills are available as Flue project skills for parity.
- Web and Slack share the same Flue bridge and session config.
- GCS/Firestore are first-class persistence substrates.

Known caveats that should not block the first merge:

- Some migrated skills still contain Claude-era procedural assumptions and should be incrementally rewritten as native Flue workflow templates, station skills, or dedicated workflow agents.
- Repo/code mutation workflows currently keep relatively loose local-tool access, similar to the existing Claude Code agent. This is acceptable for the first parity release, but needs stricter production-grade sandbox/workspace policy before broad rollout.
- Scheduler substrate is not implemented.
- Cost optimization is intentionally deferred until behavior stabilizes.
- More end-to-end elective tests should be added around representative analytics, Metabase, and named-skill flows.

## Next After Merge

- Consider the first-principles redesign direction in
  `FIRST_PRINCIPLES_REDESIGN.md`: move more state-machine control, capability
  policy, persistence, and user-facing message boundaries into deterministic app
  orchestration; keep LLMs focused on interpretation, synthesis, domain work,
  and final response writing.
- Preserve durable architectural decisions in `DECISIONS.md`; use
  `FIRST_PRINCIPLES_REDESIGN.md` for forward-looking redesign notes and this
  file for task/readiness tracking.
- Fast-follow cleanup from merge review:
  - Split `waiter.ts` into clearer modules: contracts, orchestration, station runner, postflight, and prompt builders.
  - Consolidate `project_skill_*` and `workflow_template_*` surfaces, or remove the transitional workflow-template path once project skills are the single invocation substrate.
  - Done: skip the waiter intake LLM call when `forcedSkillId` is already provided by the deterministic slash-command parser.
  - Move `route_for_skill` out of FastAPI Python code into a small skill registry or skill metadata once the route contract settles.
  - Align model defaults across `.env.secrets.example`, README, and architecture docs.
  - Audit existing LLM prompts for decisions that should be code paths instead: exact skill invocation, policy gates, session names, artifact destinations, retry bounds, and source/tool allowlists.
- Run a local web end-to-end pass with a small set of smoke prompts.
- Port the highest-value migrated skills from parity form into native Flue patterns.
- Add scheduler substrate for recurring reports and workflow follow-ups.
- Add conversation continuation by id: when a user includes a production conversation id in the message, deterministically resolve the GCS-backed conversation history, load the prior context, and continue from that state instead of treating the request as a fresh thread.
- Tighten sandbox/workspace policy for repo mutation workflows:
  - Give workflow stations a per-conversation workspace root such as `/tmp/agi-workspaces/{conversationId}`.
  - Confine local file tools to that root and sync the workspace to GCS under the same conversation id.
  - Keep this release loose for parity with the Claude agent, but move toward contracted repo tools or containerized bash so stations operate only inside the conversation workspace.
- Add LLM-judged elective e2e tests for the employee-growth Metabase card and PLAAS caveat questions.
- Optimize model choices/caching after usage traces show stable behavior.
