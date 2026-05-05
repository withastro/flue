# Deploy Flue Agents on Render

Run Flue's Node.js build output on Render, starting from the [Flue template](https://render.com/templates/flue). This guide builds on [Deploy Agents on Node.js](./deploy-node.md) and focuses on the Render-specific setup.

By the end, you will have a live Render Web Service running Flue agents, and you will know how to add Render-managed persistence and scheduled agent runs.

## Prerequisites

- Comfort with the concepts in [Deploy Agents on Node.js](./deploy-node.md).
- An API key for your model provider. The template prompts for `ANTHROPIC_API_KEY` by default.

## What you'll build

You will take the template from one-click deploy to a working Flue service you can call from any HTTP client:

1. Deploy a Flue Web Service on Render.
2. Send real requests to the `translate` and `assistant` agents.
3. Read the `render.yaml` that makes the deploy work.
4. Add durable sessions or scheduled runs when your agent needs them.

## 1. Deploy the template

Open the [Flue template](https://render.com/templates/flue) and start the one-click flow. Render walks you through:

1. Authorizing Render's GitHub OAuth app.
2. Copying the template repo to your GitHub account.
3. Returning to Render and creating a free account if you are not signed in.
4. Opening the Blueprint deploy page for the new repo.

On the deploy page, paste your AI provider API key when prompted, then click **Deploy**. The Blueprint provisions a Node.js Web Service that runs `npm ci && npx flue build --target node`, starts it with `node dist/server.mjs`, and uses `/health` for health checks.

When the deploy finishes, copy your service URL from the Render Dashboard. The rest of this guide uses `https://<service>.onrender.com`.

> You have a live Render Web Service with a Flue server behind it.

## 2. Test the live service

Start with the health endpoint:

```bash
curl https://<service>.onrender.com/health
```

A successful response confirms Render is forwarding traffic to the process started by `node dist/server.mjs`.

Now call the `translate` agent:

```bash
curl https://<service>.onrender.com/agents/translate/demo \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello world", "language": "French"}'
```

The response should match the agent's structured output, like:

```json
{
  "translation": "Bonjour le monde",
  "confidence": "high"
}
```

The translation itself can vary by model. The shape is what matters.

> The Web Service is live, the Flue server started correctly, and your provider key is reaching the model at runtime.

Try a short conversation with the `assistant` agent:

```bash
curl https://<service>.onrender.com/agents/assistant/session-1 \
  -H "Content-Type: application/json" \
  -d '{"message": "What is the capital of Japan?"}'
```

Then send a follow-up using the same agent ID:

```bash
curl https://<service>.onrender.com/agents/assistant/session-1 \
  -H "Content-Type: application/json" \
  -d '{"message": "How many people live there?"}'
```

Reusing the ID keeps Flue's session scope stable. On Node.js, that session state lives in memory unless you wire up a custom store.

> **A conversational session works end to end.**
>
> If you only need webhook-triggered agents with in-memory sessions, you can stop here.

## 3. Review the Web Service config

Open the template's `render.yaml`. Its Web Service follows this shape:

```yaml
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

This is the Render side of what the Node guide already covers:

- `buildCommand` compiles Flue's Node target.
- `startCommand` runs the generated server, which binds to `PORT` and serves agents at `/agents/<name>/<id>`.
- `healthCheckPath` lets Render verify each deploy before it shifts traffic.
- `sync: false` tells Render to prompt for the secret instead of reading it from Git.

If you ever move this setup into a different repo, drop the same `render.yaml` at its root and open the Blueprint flow with that repo's URL:

```txt
https://dashboard.render.com/blueprint/new?repo=https://github.com/<user>/<repo>
```

If the Render CLI is installed, you can validate before pushing:

```bash
render blueprints validate
```

The snippets in this guide validate against Render's public schema at `https://render.com/schema/render.yaml.json`.

> You can now read the Blueprint and know what each Render-facing field does.

## 4. Change model configuration

Provider keys belong in environment variables, either in the Render Dashboard or in `render.yaml` with `sync: false`. Common choices:

- `ANTHROPIC_API_KEY` for Anthropic.
- `OPENAI_API_KEY` for OpenAI.
- `OPENROUTER_API_KEY` for OpenRouter.

If your app reads a model ID from the environment, set it next to the matching provider key:

```yaml
envVars:
  - key: MODEL_ID
    value: anthropic/claude-sonnet-4-6
  - key: ANTHROPIC_API_KEY
    sync: false
```

Once the next deploy goes live, call the translation agent again:

```bash
curl https://<service>.onrender.com/agents/translate/model-test \
  -H "Content-Type: application/json" \
  -d '{"text": "Good morning", "language": "Spanish"}'
```

A successful response means the new env values reached the running service and Flue can still talk to the provider.

> You can swap models and providers without touching the rest of the Render setup.

## 5. Add session persistence

Skip this section if your agents are stateless or if in-memory sessions are enough. Otherwise, jump in.

In-memory sessions disappear on every deploy or restart, and they don't help once you scale beyond one instance. To make conversations durable, implement a Flue `SessionStore` in your app and back it with a Render data store.

Render Postgres is the best default for durable session history. Extend the template's `render.yaml` with a database and wire `DATABASE_URL` into the Web Service:

```yaml
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

Once your app reads `DATABASE_URL` in its `SessionStore`, redeploy and replay the assistant test with the same session ID. Trigger a manual deploy and call the same session again. If it remembers the earlier turn, persistence is working.

> Your sessions now survive deploys, restarts, and scale-out.

If you only need lightweight session-style storage, Render Key Value can stand in for Postgres. Replace the `databases` block with a `keyvalue` service and wire `REDIS_URL` into the Web Service via `fromService` (see the [Key Value docs](https://render.com/docs/key-value)).

To verify persistence end to end:

1. Commit the updated `render.yaml` and let Render apply the new data store.
2. Update your `SessionStore` to read `DATABASE_URL` or `REDIS_URL`.
3. Call the `assistant` agent with a fresh session ID and ask a question.
4. Trigger a manual deploy from the Render Dashboard.
5. Call the same session ID again. The agent should still remember the earlier turn.

If the conversation context survives the redeploy, persistence is wired up correctly.

## 6. Add a scheduled agent

Some agents shouldn't sit behind an HTTP endpoint. Nightly summaries, weekly reports, periodic audits, API syncs, and cache refreshes work better as scheduled jobs. Render Cron Jobs run a command on a schedule and exit when the work is done, which is a clean fit for agents you invoke with `flue run`.

Add a cron service to the template's `render.yaml`:

```yaml
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

Two things to remember:

- Cron schedules use UTC. Quote the `schedule` value so YAML doesn't parse `*` as an alias.
- The cron runs the start command each time it fires. If your install prunes dev dependencies, keep `@flue/cli` available at runtime.

To verify the cron without waiting for the schedule:

1. Commit the updated `render.yaml` and let Render create the cron service.
2. Open the cron service in the Render Dashboard.
3. Click **Trigger Run**.
4. Open the **Logs** tab and watch the run progress.
5. Confirm the final `flue run` output for the `digest` agent appears in the logs.

If the run completes cleanly, your scheduled agent is ready for production.

> You can run a Flue agent on a schedule and verify the result straight from Render logs.

## Going further

For continuous, queue-backed agents, reach for a Render Background Worker. A common setup: a Web Service enqueues a job, a Background Worker pulls it from Render Key Value, the worker invokes a Flue agent, and the result lands in your data store. When Key Value is backing a queue, set `maxmemoryPolicy: noeviction` so jobs are never evicted.

For more, see Render's [Background Workers](https://render.com/docs/background-workers) docs and the [Blueprint reference](https://render.com/docs/blueprint-spec).

## Troubleshooting

When a step doesn't behave as expected, run through these quick checks:

| Symptom | Check |
| --- | --- |
| Health check fails | Make sure `startCommand` is `node dist/server.mjs` and that the build produced `dist/server.mjs`. |
| Agent call returns a provider error | Confirm the matching provider key is set in the service's environment variables. |
| Build can't find `flue` | Make sure `@flue/cli` is installed and available during the build or start command. |
| Agent forgets context after a deploy | Wire up a custom `SessionStore` backed by Postgres or Key Value. |
| Cron Job doesn't run when you expect | Re-check the `schedule` value: it must be quoted and is evaluated in UTC. |

