---
name: flue
description: Use when building, debugging, reviewing, or documenting Flue agents, workflows, channels, skills, tools, sandboxes, targets, routing, persistence, observability, or CLI usage; routes coding agents to version-matched Flue documentation through the CLI.
---

# Flue

Use `flue docs` to read the documentation bundled with the installed `@flue/cli` version. Choose relevant paths from the catalog below and run `flue docs read <path>`. If no catalog entry matches your task, run `flue docs search <query>`, then read the most relevant result with `flue docs read <path>`.

For example, `flue docs search "durable execution"` searches with the query `durable execution`. If it returns the path `concepts/durable-execution`, run `flue docs read concepts/durable-execution` to read that page.

## Documentation Catalog

<!-- flue-docs-catalog:start -->

```text
api/action-api -- Action API
  Reference for defining reusable finite Actions with @flue/runtime.
api/agent-api -- Agent API
  Reference for defining agents and running agent operations with @flue/runtime.
api/data-persistence-api -- Data Persistence API
  Reference for Flue persistence adapters, stores, and session data.
api/errors-reference -- Errors Reference
  Reference Flue transport errors, runtime failures, and development diagnostics.
api/events-reference -- Events Reference
  Reference runtime activity, attached-agent event types, and global observation APIs.
api/provider-api -- Provider API
  Register custom model providers and override built-in provider transport.
api/routing-api -- Routing API
  Compose Flue routes in an authored application entrypoint.
api/sandbox-api -- Sandbox Adapter API
  Adapt a provider sandbox SDK into Flue's public sandbox contract.
api/streaming-protocol -- Streaming Protocol
  Reference for reading Flue agent conversations and workflow events over Durable Streams.
api/workflow-api -- Workflow API
  Reference for creating and invoking workflows with @flue/runtime.
cli/add -- flue add
  Reference for discovering and applying Flue implementation blueprints.
cli/build -- flue build
  Reference for creating deployable Flue application artifacts.
cli/dev -- flue dev
  Reference for starting a watch-mode local Flue development server.
cli/docs -- flue docs
  Reference for listing, reading, and searching the bundled Flue documentation.
cli/init -- flue init
  Reference for creating an initial Flue project configuration file.
cli/overview -- CLI
  Use the Flue CLI to configure, develop, exercise, inspect, and build an application.
cli/run -- flue run
  Reference for executing one agent prompt or workflow invocation from the command line.
cli/update -- flue update
  Reference for updating integrations from newer Flue blueprint upgrade guides.
concepts/agents -- What is an agent?
  What an AI agent actually is, why a model alone isn't one, and what makes a Flue agent different.
concepts/durable-execution -- Durable Agents
  Understand how Flue agents and workflows handle server restarts, interrupted connections, and other disruptions.
ecosystem/channels/discord -- Discord
ecosystem/channels/github -- GitHub
ecosystem/channels/google-chat -- Google Chat
ecosystem/channels/intercom -- Intercom
ecosystem/channels/linear -- Linear
ecosystem/channels/messenger -- Facebook Messenger
ecosystem/channels/notion -- Notion
ecosystem/channels/resend -- Resend
ecosystem/channels/salesforce-marketing-cloud -- Salesforce Marketing Cloud
ecosystem/channels/shopify -- Shopify
ecosystem/channels/slack -- Slack
ecosystem/channels/stripe -- Stripe
ecosystem/channels/teams -- Microsoft Teams
ecosystem/channels/telegram -- Telegram
ecosystem/channels/twilio -- Twilio
ecosystem/channels/whatsapp -- WhatsApp
ecosystem/channels/zendesk -- Zendesk
ecosystem/databases/libsql -- libSQL
ecosystem/databases/mongodb -- MongoDB
ecosystem/databases/mysql -- MySQL
ecosystem/databases/postgres -- Postgres
ecosystem/databases/redis -- Redis
ecosystem/databases/supabase -- Supabase
ecosystem/databases/turso -- Turso
ecosystem/databases/valkey -- Valkey
ecosystem/deploy/aws -- Deploy Agents on AWS
ecosystem/deploy/cloudflare -- Deploy to Cloudflare
ecosystem/deploy/docker -- Deploy Agents with Docker
ecosystem/deploy/fly -- Deploy Agents on Fly.io
ecosystem/deploy/github-actions -- Build Agents for GitHub Actions
ecosystem/deploy/gitlab-ci -- Build Agents for GitLab CI/CD
ecosystem/deploy/node -- Deploy Agents on Node.js
ecosystem/deploy/railway -- Deploy Agents on Railway
ecosystem/deploy/render -- Deploy Agents on Render
ecosystem/deploy/sst -- Deploy Agents on SST
ecosystem/sandboxes/boxd -- boxd
ecosystem/sandboxes/cloudflare -- Cloudflare Sandbox
ecosystem/sandboxes/cloudflare-shell -- Cloudflare Shell
ecosystem/sandboxes/daytona -- Daytona
ecosystem/sandboxes/e2b -- E2B
ecosystem/sandboxes/exedev -- exe.dev
ecosystem/sandboxes/islo -- islo
ecosystem/sandboxes/mirage -- Mirage
ecosystem/sandboxes/modal -- Modal
ecosystem/sandboxes/vercel -- Vercel Sandbox
ecosystem/tooling/braintrust -- Braintrust
ecosystem/tooling/opentelemetry -- OpenTelemetry
ecosystem/tooling/sentry -- Sentry
ecosystem/tooling/vitest-evals -- Vitest Evals
getting-started/quickstart -- Getting Started
  Set up a Flue project automatically or create your first agent manually.
guide/actions -- Actions
  Define finite agent-backed operations that can be reused by workflows and agents.
guide/building-agents -- Agents
  Create an agent, configure its capabilities, and send it messages over time.
guide/channels -- Channels
  Receive verified provider events and connect them to Flue applications.
guide/database -- Database
  Configure database-backed state for Flue agents and workflow runs.
guide/evals -- Evals
  Evaluate Flue agents with repeatable Vitest suites using vitest-evals.
guide/models -- LLM (Models & Providers)
  Select models, configure providers, and tune reasoning behavior in Flue agents.
guide/observability -- Observability
  Inspect workflow runs, monitor agent activity, and export telemetry from your application.
guide/project-layout -- Project Layout
  Understand the source files and generated output in a Flue project.
guide/react -- React
  Build React interfaces for live agent conversations and workflow runs.
guide/routing -- Routing
  Compose Flue with application routes, middleware, and custom HTTP ingress.
guide/sandboxes -- Sandboxes
  Give agents a workspace for files and command-driven work.
guide/schedules -- Schedules
  Invoke Flue workflows or dispatch agent input on a schedule with Cloudflare or Node.js.
guide/skills -- Skills
  Add Agent Skills to Flue agents and invoke them from sessions.
guide/subagents -- Subagents
  Let agents delegate focused work to named specialists.
guide/targets/cloudflare -- Cloudflare
  Understand the Cloudflare-specific runtime behavior and APIs for Flue applications.
guide/targets/node -- Node.js
  Understand the Node.js-specific runtime behavior and APIs for Flue applications.
guide/tools -- Tools
  Give agents application capabilities through custom tools and MCP servers.
guide/workflows -- Workflows
  Create, invoke, and expose finite agent-backed operations.
introduction/why-flue -- Why Flue?
  Build autonomous AI agents and powerful workflows with a programmable TypeScript harness, and run them anywhere.
reference/configuration -- Configuration
  Reference for flue.config.ts options.
sdk/agents -- client.agents
  Invoke persistent agent instances and read their conversations.
sdk/client -- createFlueClient(...)
  Configure an SDK client for a deployed Flue application.
sdk/errors -- Errors
  SDK HTTP and stream error types.
sdk/events -- Events and records
  SDK event, workflow-run record, and normalized model-turn types.
sdk/overview -- SDK overview
  Reference for consuming deployed Flue agents and workflows with @flue/sdk.
sdk/runs -- client.runs
  Inspect and stream HTTP-exposed workflow runs.
sdk/workflows -- client.workflows
  Start workflow runs and receive their run ID.
```

<!-- flue-docs-catalog:end -->
