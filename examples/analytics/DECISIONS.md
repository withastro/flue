# Flue Analytics Agent Decisions

Durable architectural decisions for the AGI Flue analytics agent. This file is
for decisions we expect future work to respect. Forward-looking redesign ideas
belong in `FIRST_PRINCIPLES_REDESIGN.md`; task lists belong in `plan.md`.

## 2026-06-08: Keep Flue Framework And AGI App Separate

**Decision:** Keep the Flue framework repo separate from
`evenup-internal-tools/apps/dbt-explorer-api`. The product-owned AGI agent should
eventually live under the app repo, while `examples/analytics` remains the
prototype/source for framework iteration until migration is complete.

**Reasoning:** Flue and AGI have different ownership and deployment concerns.
The GKE image should be self-contained in `dbt-explorer-api`, but framework
changes should stay in the Flue repo.

**Consequence:** For the current merge, the app carries the built Flue artifact
under `agi-agent/dist`. Agent source changes are developed in
`examples/analytics`, then built and copied into the app bundle.

## 2026-06-08: Waiter Owns User Experience End To End

**Decision:** The waiter owns intake, work-order framing, postflight review, and
the only user-facing final/follow-up messages.

**Reasoning:** Splitting intent understanding from final review loses context
about what the user actually wanted. The waiter can use phase-specific prompts
and schemas, but the user experience should have one accountable owner.

**Consequence:** Stations and explorer produce structured internal outputs.
App/Slack visible messages must come from waiter `reply` values with
`replyType` of `final` or `followup_question`.

## 2026-06-08: Explorer Is A Shared Research Service

**Decision:** Explorer is a shared bounded research service, not a kitchen
station and not a hidden orchestrator.

**Reasoning:** Waiter owns preflight intent; stations own domain execution.
Explorer has source/tool knowledge, but should not silently decide route,
business intent, or broaden the research agenda.

**Consequence:** The current implementation uses a caller-directed exploration
request. The target design is waiter/station-authored exploration plans with
explicit initial sources, fallback sources, checks, and fallback policy. Regex
source selection is acceptable only as compatibility fallback until that target
contract is implemented.

## 2026-06-08: Source Broadening Requires Caller Permission

**Decision:** Slack, Drive, repo, and Jira are optional sources. They should be
used when explicitly requested, when waiter/station has a concrete reason to
expect source-of-truth evidence there, or when canonical sources are insufficient
and fallback policy permits broadening.

**Reasoning:** These sources are expensive, noisy, permission-sensitive, and can
pull the agent away from the user intent if used as default exploration.

**Consequence:** Analytics defaults should prefer manifest and BigQuery.
Knowledge defaults should prefer KB. Repo/Jira are especially appropriate for
`eng_history`, shipped-change, PR, ticket, implementation, or API/code behavior
questions, not because of broad substring matches.

## 2026-06-08: Deterministic Boundaries, LLM Judgment

**Decision:** What can be deterministic should be deterministic: session names,
skill trigger parsing, policy gates, auth strategy, mutating permissions,
artifact paths, and user-facing message categories.

**Reasoning:** Deterministic code is easier to test and reason about. LLM calls
should focus on interpretation, synthesis, judgment, and domain work where
rules would be brittle.

**Consequence:** Slash skill invocation uses exact `/{skill-directory-name}`.
Metabase creation, Drive writes, Jira/PR mutation, and workflow mutation are
explicitly policy gated. Postflight output is constrained to user-facing reply
types.

## 2026-06-08: BigQuery Auth Is Service Account First

**Decision:** BigQuery auth should try service account credentials first, then
retry with user OAuth only for permission/access failures when user credentials
are available.

**Reasoning:** GKE has a service account and should use it by default. Web users
may have elevated access for sensitive queries, but user auth should not be the
only path or a silent default for all failures.

**Consequence:** The credential mode is `service_account_then_user_oauth`.
Tool results report the concrete auth mode that actually succeeded.

## 2026-06-08: Conversation Ledger Is Additive For This Merge

**Decision:** The agent returns a structured `ledger`, but app-side durable
ledger persistence is deferred.

**Reasoning:** Returning the ledger establishes the contract without increasing
merge risk in FastAPI persistence. Dedicated GCS/Firestore ledger storage can be
added after the Flue engine merge.

**Consequence:** Live evals and AGI invocation results can inspect the ledger
now. Production storage should later write ledgers to GCS/local by environment
and optionally store Firestore pointers.

## 2026-06-08: Live Evals Are Separate From Unit Tests

**Decision:** Live LLM/tool evals are elective commands, not part of the normal
unit test suite.

**Reasoning:** They cost money, depend on live auth/data, and should be judged
semantically by Codex/humans plus lightweight deterministic checks.

**Consequence:** Use `pnpm eval:live` for live validation. Unit tests cover
contracts, schemas, policy behavior, and deterministic boundaries.
