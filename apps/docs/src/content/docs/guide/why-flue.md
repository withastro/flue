---
title: Why Flue?
description: Build autonomous AI agents with a programmable TypeScript harness, and run them anywhere.
lastReviewedAt: 2026-07-21
---

**Flue** is the open agent framework, from the creators of [Astro](https://astro.build/). Use a React-like hooks API to build agents in TypeScript using your favorite LLMs. Run them locally or deploy them anywhere, including Node.js, Cloudflare, GitHub Actions, and GitLab CI/CD.

If you want to build something LLM-powered, such as a script, a workflow, a CI job, or a product or service, then Flue is likely for you.

## Features

Flue is a complete framework for building agents. It includes everything you need to build, run, and deploy agents. Some highlights:

- **[Agents](/docs/guide/building-agents/):** Autonomous agents that keep context across conversations and events.
- **[Sandboxes](/docs/guide/sandboxes/):** A secure environment where agents run code and do work.
- **[Subagents](/docs/guide/subagents/):** Let your agent delegate specialized work to the right expert.
- **[Skills](/docs/guide/skills/):** Package expertise that agents load whenever a task needs guidance.
- **[Tools](/docs/guide/tools/):** Agents call APIs, query data, and make changes with the code you define.
- **[MCP Servers](/docs/guide/mcp/):** Connect agents to thousands of tools in the open MCP ecosystem.
- **[Persistent State](/docs/guide/agent-hooks/#persisted-state):** Write data on each agent and update its capabilities as state changes.
- **[Chat](/docs/guide/channels/):** Drop your agents into Slack, Teams, Discord, GitHub, and more.

## Design Principles

These core design principles explain why we built Flue, the problems it exists to solve, and why Flue may fit your project or team.

Flue is…

1. **[Harness-first](#harness-first):** The agent harness is Flue's core, not a feature.
2. **[Dynamic](#dynamic):** An agent is a program to write, not an object to configure.
3. **[Durable](#durable):** We do the hard work of durability so you don't have to.
4. **[Open](#open):** Open models, sandboxes, and hosting platforms, with no lock-in.
5. **[Built to scale](#built-to-scale):** Designed for non-trivial agents, from a starter project to a billion-dollar company.

### Harness-first

Flue agents are complete agents, in the same mold as Claude Code or OpenClaw. Flue builds on [Pi](https://pi.dev/), the open agent harness behind OpenClaw, and integrates it deeply into every agent you build. Each agent gets the full harness, with the tools, skills, and instructions it needs to work autonomously toward a goal, plus a sandbox when you attach one.

That is the difference between Flue and an SDK. In Flue, the harness is the core of the framework, not a feature of it.

See [Agents](/docs/guide/building-agents/) to learn more.

### Dynamic

Flue builds dynamic agent behavior from two core building blocks, functions and hooks. The agent function lets you design your agent as a function instead of the static config object that many other frameworks require. Agent hooks let you extend your agent with declarative functionality.

Together, functions and hooks make agents reactive and stateful. With [persistent state](/docs/guide/agent-hooks/#persisted-state), an agent has data it can read and write across its whole conversation. Capabilities can follow that state. A tool can appear once prerequisites are met, and a [sandbox](/docs/guide/sandboxes/) can attach only when the task calls for one. Agents are written like components because web developers already know how to program declarative, reactive systems.

See [Agent Hooks](/docs/guide/agent-hooks/) for the full set of hooks.

### Durable

Durability is the hardest part of running agents in production, so Flue does that work for you. Building a demo agent is easy. Keeping one alive is not. Servers restart, providers time out, and clients disconnect mid-response. The code you would write to survive all of that has nothing to do with your agent. It is recovery code, and it is easy to get wrong.

Flue builds it in. Every session is recorded to a durable, replayable log, so accepted work is never lost. Interrupted sessions resume automatically when the runtime comes back, and clients reconnect without starting over. You write the agent, and the runtime keeps it alive.

See [Durability](/docs/guide/durability/) for the guarantees on each deploy target.

### Open

Flue is open at every layer (models, sandboxes, and hosting platforms), so you are not locked in. Many agent frameworks and SDKs are closed in some direction. They assume their own models, run only in their own sandbox, or deploy only to their own cloud. We think that's backwards.

Flue is open by design:

- **Open models:** Connect to any supported LLM provider.
- **Open sandboxes:** Connect to a remote provider, or use the built-in virtual sandbox.
- **Open deploys:** Build your agent for Node.js, Cloudflare, GitHub, GitLab, etc.

Flue also builds on open protocols like [MCP](/docs/guide/mcp/) and [Durable Streams](https://durablestreams.com/) instead of inventing its own.

See [Sandboxes](/docs/guide/sandboxes/) and [Deploy](/docs/guide/deploy/) for more details.

### Built to scale

Flue is designed to scale with complexity. A trivial agent, such as a webhook connected to an agent with a few capabilities that returns the result, should be easy, and Flue keeps it easy. But trivial agents are not all that an agent framework should optimize for.

Today, no one else serves non-trivial agents well. These are the agents that power an entire internal service, product, or company. Building at that level is a different problem, and it is the problem Flue prioritizes. When a design decision would trade the non-trivial agent for demo convenience, Flue takes the non-trivial side.

Flue is built to scale with you, from a simple starter project all the way to a billion-dollar company. Every other principle on this page serves that goal.
