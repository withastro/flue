# Agent Design Principles

This note is for building agents, not for patching one observed failure.

When an agent fails on a specific example, do not fix the example. Identify the underlying class of failure and improve the agent at that level.

## Core rules

- Generalize from the failure. Ask: what broader reasoning mistake produced this behavior?
- Use deterministic code for mechanical constraints only: schemas, permissions, persistence, routing boundaries, query limits.
- Use LLM judgment for uncertainty, ambiguity, interpretation, and whether the request is understood well enough to proceed.
- Do not add narrow detectors for one phrase, one report name, or one user wording unless the problem is truly mechanical.
- If first-pass context is insufficient to understand the request, the agent should ask a follow-up question instead of manufacturing a plausible task.
- Do not convert nearby evidence into assumed meaning. Related tables, docs, or metrics do not prove the user's intent.
- Separate intent uncertainty from technical uncertainty.
- Technical uncertainty can often be delegated to tools or specialist agents.
- Intent uncertainty usually requires a user clarification.
- Keep role boundaries sharp. `explorer` is not a decision-maker. It should look at sources, collect evidence, and summarize what it found and what is missing.
- `explorer` should not decide what the user means, what route is correct, whether ambiguity is acceptable, or whether the system should proceed. Those judgments belong to `waiter`.
- Run targeted live LLM tests against real prompts that represent the behavior you want. Iterate on prompts, roles, schemas, and evaluations until the observed behavior matches the intended contract.
- Use stronger models selectively. If you are testing judgment, ambiguity handling, or instruction following, raise the model only for the role whose judgment is under test.
- Respect role constraints in tests. If a role is supposed to stay cheap and non-judgmental in production, such as `explorer`, do not make it expensive just to get the behavior you want.
- Specialists should receive coherent work orders, not ambiguous requests disguised as concrete tasks.
- Reviews should reject proxy work: a polished answer to the wrong task is still a failure.

## Practical heuristic

Before changing agent behavior, ask:

1. Is this a mechanical problem or a judgment problem?
2. If it is a judgment problem, can I improve the prompt, role, examples, schema, or eval instead of adding a special-case rule?
3. Am I teaching the agent a principle, or teaching it one anecdote?

Prefer principles over patches.
