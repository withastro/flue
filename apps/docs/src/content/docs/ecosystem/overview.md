---
title: Ecosystem
description: Choose deployment environments and sandbox integrations for Flue applications.
---

The Flue ecosystem connects deployable applications to hosting environments and sandbox providers. Start with [Develop & Build](/docs/guide/develop-and-build/) to develop locally and create build output, then use this section for a specific deployment destination or sandbox integration.

Use [Evaluating Flue Agents](/docs/ecosystem/evals/) when you want to run behavior-quality evals against the public workflow and agent routes your application ships.

## Deployment environments

Flue builds application artifacts for Node.js and Cloudflare. Deployment pages document how those artifacts fit a particular host or execution environment.

| Destination    | Use it for                                                         | Continue to…                                                 |
| -------------- | ------------------------------------------------------------------ | ------------------------------------------------------------ |
| Node.js        | An ordinary long-running Node server or container.                 | [Deploy on Node.js](/docs/ecosystem/deploy/node/)            |
| Cloudflare     | A Worker with generated Durable Object-backed runtime integration. | [Deploy on Cloudflare](/docs/ecosystem/deploy/cloudflare/)   |
| Render         | A managed Node web service with optional managed persistence.      | [Deploy on Render](/docs/ecosystem/deploy/render/)           |
| GitHub Actions | One-shot Node workflow execution in CI.                            | [Use GitHub Actions](/docs/ecosystem/deploy/github-actions/) |
| GitLab CI/CD   | One-shot Node workflow execution in CI.                            | [Use GitLab CI/CD](/docs/ecosystem/deploy/gitlab-ci/)        |

For local development and build output, see [Develop & Build](/docs/guide/develop-and-build/).

## Sandbox connectors

A sandbox connector adapts an application-owned compute or workspace environment into the Flue sandbox contract. A connector controls files and commands available to the agent; it is separate from session conversation storage and workflow run history.

The connector catalog includes remote Linux environments, platform-owned workspaces and containers, and local VM integrations. Choose a provider from the **Sandboxes** navigation group.

## Core guides

- [Sandboxes](/docs/guide/sandboxes/) explains how to choose a filesystem and execution boundary.
- [Agents](/docs/guide/building-agents/) explains continuing session persistence versus workspace durability.
- [Routing](/docs/guide/routing/) explains which deployed application surfaces are public.
