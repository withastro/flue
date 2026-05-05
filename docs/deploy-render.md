# Deploy Agents on Render

Deploy Flue's Node.js build output on Render. This guide builds on [Deploy Agents on Node.js](./deploy-node.md): it assumes you understand Flue agents, sessions, roles, skills, sandboxes, and the `flue` CLI. Here, you start from the Render template, deploy it, test it, and then extend its Render configuration.

By the end, you will have a live Render Web Service running Flue agents. You will also know how to add Render-managed persistence, scheduled agent runs, and queue-backed workers.

## 1. Deploy the template

Use the [Flue template](https://render.com/templates/flue) as the starter for this guide. It gives you a working Render Web Service and a `render.yaml` Blueprint that you can inspect, edit, and extend.

The template already configures:

- A Node.js Web Service.
- A `render.yaml` Blueprint.
- `flue build --target node` as the build step.
- `node dist/server.mjs` as the start command.
- `/health` as the health check path.
- Provider key setup, starting with `ANTHROPIC_API_KEY`.

Deploy the template from Render and provide your `ANTHROPIC_API_KEY` when prompted. If you deploy from the template page, you do not need to create another Blueprint. Use the template's `render.yaml` as the file you edit when you add services or change settings.

After the first deploy finishes, copy your service URL from the Render Dashboard. The examples below use `https://<service>.onrender.com`.

## 2. Test the live service

First, check the health endpoint:

```bash
curl https://<service>.onrender.com/health
```

Then call the template's translation agent:

```bash
curl https://<service>.onrender.com/agents/translate/demo \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello world", "language": "French"}'
```

You should receive a JSON response with a translation and a confidence value. This confirms the Web Service is live, the Flue server started correctly, and your provider key is available at runtime.

Next, test a conversational session:

```bash
curl https://<service>.onrender.com/agents/assistant/session-1 \
  -H "Content-Type: application/json" \
  -d '{"message": "What is the capital of Japan?"}'
```

Send a follow-up with the same agent ID:

```bash
curl https://<service>.onrender.com/agents/assistant/session-1 \
  -H "Content-Type: application/json" \
  -d '{"message": "How many people live there?"}'
```

Using the same ID gives Flue a stable runtime scope for the conversation. On the Node.js target, that default session state is in memory unless you add a custom persistence store.

## 3. Review the Web Service config

Open the template's `render.yaml`. Its Web Service should follow this shape:

```yaml
# yaml-language-server: $schema=https://render.com/schema/render.yaml.json
services:
  - type: web
    name: flue-agents
    runtime: node
    plan: free
    buildCommand: npm ci && npx flue build --target node
    startCommand: node dist/server.mjs
    healthCheckPath: /health
    envVars:
      - key: ANTHROPIC_API_KEY
        sync: false
```

These fields are the Render-specific bridge from the Node guide to production:

- `runtime: node` tells Render to build and run the project with Node.js.
- `buildCommand` installs dependencies and builds Flue's Node target.
- `startCommand` runs the generated Flue server.
- `healthCheckPath: /health` lets Render verify each deploy before it serves traffic.
- `sync: false` tells Render to prompt for the provider key instead of reading it from Git.

Flue's Node target reads Render's `PORT` environment variable, exposes `/health`, and serves agents at `/agents/<name>/<id>`.

If you copy the template into a different repo, keep this configuration in that repo's root `render.yaml`. If you are deploying your own repo instead of the hosted template, open the Blueprint flow with your repo URL:

```txt
https://dashboard.render.com/blueprint/new?repo=https://github.com/<user>/<repo>
```

If you have the Render CLI installed, validate the Blueprint before you push:

```bash
render blueprints validate
```

The examples in this guide use Render's public Blueprint schema at `https://render.com/schema/render.yaml.json`.

## 4. Change model configuration

The template uses environment variables for provider configuration. Add any provider keys your agents need in the Render Dashboard or in `render.yaml` with `sync: false`:

- `ANTHROPIC_API_KEY` for Anthropic models.
- `OPENAI_API_KEY` for OpenAI models.
- `OPENROUTER_API_KEY` for OpenRouter models.

If your app reads a model ID from the environment, add `MODEL_ID` alongside the matching provider key:

```yaml
envVars:
  - key: MODEL_ID
    value: anthropic/claude-sonnet-4-6
  - key: ANTHROPIC_API_KEY
    sync: false
```

After the next deploy, call the translation agent again:

```bash
curl https://<service>.onrender.com/agents/translate/model-test \
  -H "Content-Type: application/json" \
  -d '{"text": "Good morning", "language": "Spanish"}'
```

If the request succeeds, Render deployed the updated environment and Flue can still reach the model provider.

## 5. Add session persistence

On Node.js, Flue's default session storage is in memory. That is useful for development and stateless agents, but it is not durable across Render deploys, restarts, or multiple service instances.

For durable conversations, implement a Flue `SessionStore` in your app and back it with a Render data store. The Render-specific part is wiring that data store into the existing Web Service.

Render Postgres is the best default for durable session history. To use it, extend the template's `render.yaml` with a database and add `DATABASE_URL` to the existing Web Service:

```yaml
# yaml-language-server: $schema=https://render.com/schema/render.yaml.json
databases:
  - name: flue-db
    plan: basic-256mb

services:
  - type: web
    name: flue-agents
    runtime: node
    plan: free
    buildCommand: npm ci && npx flue build --target node
    startCommand: node dist/server.mjs
    healthCheckPath: /health
    envVars:
      - key: DATABASE_URL
        fromDatabase:
          name: flue-db
          property: connectionString
      - key: ANTHROPIC_API_KEY
        sync: false
```

After your app uses `DATABASE_URL` in its `SessionStore`, redeploy and repeat the assistant test with the same session ID. Then trigger a manual deploy and call the same session again. If the agent keeps the conversation context after the deploy, persistence is working.

Render Key Value can work for lightweight session-style storage. Use Postgres when you need long-term history, querying, or backups. To use Key Value, add the Key Value service and wire `REDIS_URL` into the existing Web Service:

```yaml
# yaml-language-server: $schema=https://render.com/schema/render.yaml.json
services:
  - type: keyvalue
    name: flue-sessions
    plan: starter
    ipAllowList: []

  - type: web
    name: flue-agents
    runtime: node
    plan: free
    buildCommand: npm ci && npx flue build --target node
    startCommand: node dist/server.mjs
    healthCheckPath: /health
    envVars:
      - key: REDIS_URL
        fromService:
          type: keyvalue
          name: flue-sessions
          property: connectionString
      - key: ANTHROPIC_API_KEY
        sync: false
```

## 6. Add a scheduled agent

Use a Render Cron Job when an agent should run on a schedule and exit when it finishes. Common examples include nightly summaries, weekly reports, periodic audits, external API syncs, and cache refreshes.

Cron Jobs are a good fit for agents you invoke with `flue run` instead of an HTTP request. Add a cron service to the template's `render.yaml`:

```yaml
# yaml-language-server: $schema=https://render.com/schema/render.yaml.json
services:
  - type: cron
    name: nightly-digest
    runtime: node
    plan: starter
    schedule: "0 8 * * *"
    buildCommand: npm ci
    startCommand: npx flue run digest --target node --id nightly-digest --payload '{"date":"today"}'
    envVars:
      - key: ANTHROPIC_API_KEY
        sync: false
```

Cron schedules are evaluated in UTC. Quote the `schedule` value so YAML does not parse `*` as an alias.

After Render creates the Cron Job, use **Trigger Run** in the Dashboard to run it immediately. Check the logs for the final `flue run` result. This gives you a quick feedback loop without waiting for the next scheduled run.

Cron Jobs run the start command each time the schedule fires. If your install prunes dev dependencies, make sure `@flue/cli` is available at runtime.

## 7. Add a queue worker

Use a Render Background Worker when a process should consume jobs from a queue continuously. The worker does not receive HTTP traffic. It connects to a queue, pulls a job, invokes a Flue agent, writes the result, and repeats.

For Redis-compatible queues, add Render Key Value and a worker service to `render.yaml`. Use `maxmemoryPolicy: noeviction` so queue keys are not evicted:

```yaml
# yaml-language-server: $schema=https://render.com/schema/render.yaml.json
services:
  - type: keyvalue
    name: flue-jobs
    plan: starter
    ipAllowList: []
    maxmemoryPolicy: noeviction

  - type: worker
    name: flue-worker
    runtime: node
    plan: starter
    buildCommand: npm ci
    startCommand: node worker.js
    maxShutdownDelaySeconds: 120
    envVars:
      - key: REDIS_URL
        fromService:
          type: keyvalue
          name: flue-jobs
          property: connectionString
      - key: ANTHROPIC_API_KEY
        sync: false
```

After the worker deploys, enqueue one test job and watch the worker logs. A useful first test is a job that asks the worker to invoke the translation agent with a small payload and write the result to logs or Postgres.

Handle `SIGTERM` in long-running workers. Render sends `SIGTERM` before stopping an instance, then waits up to `maxShutdownDelaySeconds` before forcing shutdown.

## Choose the right Render service

Use this mapping when deciding how to extend the template:

| Need | Render service | Configuration |
| --- | --- | --- |
| Public HTTP agent | Web Service | `flue build --target node`, then `node dist/server.mjs` |
| Scheduled agent run | Cron Job | `flue run` in the start command |
| Continuous queue consumer | Background Worker | Worker process invokes Flue from queue jobs |
| Durable session history | Postgres | `DATABASE_URL` from `fromDatabase` |
| Lightweight session storage | Key Value | `REDIS_URL` from `fromService` |

The template starts with a Web Service. Add persistence when conversations need to survive deploys and restarts. Add Cron Jobs or Background Workers only when your agent needs scheduled or queue-backed execution.
