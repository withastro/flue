---
title: Why Flue?
description: Build autonomous AI agents with a programmable TypeScript harness, and run them anywhere.
lastReviewedAt: 2026-07-21
---

**Flue** is the open agent framework, from the creators of [Astro](https://astro.build/). Use a React-like hooks API to build agents in TypeScript using your favorite LLMs. Run them locally or deploy them anywhere: Node.js, Cloudflare, GitHub Actions, GitLab CI/CD, etc.

If you are looking to build something LLM-powered -- a script, a workflow, a CI job, a product or service, anything! -- then Flue is likely for you.

## Features

**Flue is a complete framework for building agents.** It includes everything you need to build, run, and deploy agents. Some highlights include:

- **[Agents](/docs/guide/building-agents/):** Autonomous agents that keep context across conversations and events.
- **[Sandboxes](/docs/guide/sandboxes/):** A secure environment where agents run code and do real work.
- **[Subagents](/docs/guide/subagents/):** Let your agent delegate specialized work to the right expert.
- **[Skills](/docs/guide/skills/):** Package expertise that agents load whenever a task needs guidance.
- **[Tools](/docs/guide/tools/):** Agents call APIs, query data, and make changes — using the code you define.
- **[MCP Servers](/docs/guide/mcp/):** Connect agents to thousands of tools in the open MCP ecosystem.
- **[Persistent State](/docs/guide/agent-hooks/#persisted-state):** Write data on each agent and update its capabilities as state changes.
- **[Chat](/docs/guide/channels/):** Drop your agents into Slack, Teams, Discord, GitHub, and more.

## Design Principles

Here are the core design principles that explain why we built Flue, the problems it exists to solve, and why Flue may be the best choice for your project or team.

Flue is…

1. **[Harness-first](#harness-first):** The agent harness is Flue's core, not a feature.
2. **[Dynamic](#dynamic):** An agent is a program to write, not an object to configure.
3. **[Durable](#durable):** We do the hard work of durability so you don't have to.
4. **[Open](#open):** Open models, sandboxes, and hosting platforms — no lock-in.
5. **[Built to scale](#built-to-scale):** Designed for non-trivial agents — from a starter project to a billion-dollar company.

### Harness-first

**Flue agents are proper agents, in the same mold as Claude Code or OpenClaw.** Flue builds on [Pi](https://pi.dev/), the open agent harness behind OpenClaw, and integrates it deeply into every agent you build. Each agent gets the full harness — the tools, skills, instructions, and, when you attach one, the sandbox it needs to work autonomously toward a goal.

That is the difference between Flue and an SDK: the harness is the core of the framework, not a feature of it.

See [Agents](/docs/guide/building-agents/) to learn more.

### Dynamic

**Flue has two core primitives that unlock truly dynamic agent behavior: functions and hooks.** The agent function lets you design your agent as a function (not a static config object, as many other frameworks would force you to do). Agent hooks let you extend your agent with declarative functionality.

Together, functions and hooks make agents reactive and stateful. With [persistent state](/docs/guide/agent-hooks/#persisted-state), an agent has literal state: data it can read and write across its whole conversation. Capabilities can follow that state — a tool that appears once prerequisites are met, a [sandbox](/docs/guide/sandboxes/) that attaches only when the task calls for one. Agents are written like components because web developers already know how to program declarative, reactive systems.

See [Agent Hooks](/docs/guide/agent-hooks/) for the full toolkit.

### Durable

**Durability is the hardest part of running agents in production, so Flue does that work for you.** Building a demo agent is easy; keeping one alive is not. Servers restart, providers time out, and clients disconnect mid-response. The code you would write to survive all of that has nothing to do with your agent — it is recovery plumbing, and it is easy to get wrong.

Flue builds it in. Every session is recorded to a durable, replayable log, so accepted work is never lost: interrupted sessions resume automatically when the runtime comes back, and clients reconnect without starting over. You write the agent, and the runtime keeps it alive.

See [Durability](/docs/guide/durability/) for the exact contract on each deploy target.

### Open

**Flue is open at every layer — models, sandboxes, and hosting platforms — so you are never locked in.** Many agent frameworks and SDKs are closed in some direction: they assume their own models, run only in their own sandbox, or deploy only to their own cloud. We think that's backwards.

Flue is deliberately open:

- **Open models:** Connect to any supported LLM provider.
- **Open sandboxes:** Connect to a remote provider, or use the built-in virtual sandbox.
- **Open deploys:** Build your agent for Node.js, Cloudflare, GitHub, GitLab, etc.

The same openness applies to protocols: Flue builds on open standards like [MCP](/docs/guide/mcp/) and [Durable Streams](https://durablestreams.com/) instead of inventing its own.

See [Sandboxes](/docs/guide/sandboxes/) and [Deploy](/docs/guide/deploy/) for more details.

### Built to scale

**Flue is designed to scale with complexity.** A trivial agent — connect a webhook to an agent with a few capabilities and return the result — should be easy, and Flue keeps it easy. But trivial agents are not all that an agent framework should optimize for.

The agents that no one else serves well today are the non-trivial ones: the agent that powers an entire internal service, product, company. Building at that level is a different problem entirely, and it is the problem Flue prioritizes. When a design decision would trade the non-trivial agent for demo convenience, Flue takes the non-trivial side.

Flue is built to scale with you, from a simple starter project all the way to a billion-dollar company. Every other principle on this page serves that goal.
