# Deploy Agents on Render

Deploy Flue agents to Render as a Node.js web service. This guide starts from the [Flue template](https://render.com/templates/flue), builds on [Deploy Agents on Node.js](./deploy-node.md), and focuses on the Render-specific setup: Blueprints, service configuration, environment variables, and managed persistence.

By the end, you will have a live Render web service running Flue agents, and you will know how to add Render-managed persistence on top.

## Prerequisites

- Familiarity with the [Deploy Agents on Node.js](./deploy-node.md) guide.
- An API key for your model provider. The template prompts for `ANTHROPIC_API_KEY` by default.

## 1. Deploy the template

Open the [Flue template](https://render.com/templates/flue) and click **Deploy to Render**. Render walks you through:

1. Authorizing Render's GitHub OAuth app.
2. Copying the template repo to your GitHub account.
3. Returning to Render and creating a free account if you are not signed in.
4. Opening the Blueprint deploy page for the new repo.

On the deploy page, paste your AI provider API key when prompted, then click **Deploy**. The Blueprint provisions a Node.js web service that runs `npm ci && npx flue build --target node`, starts it with `node dist/server.mjs`, and uses `/health` for health checks.

The template uses `plan: free` so first-time deploys cost nothing. Free instances spin down after 15 minutes of inactivity, and the next request pays a multi-second cold start while the Node process restarts. For agents that see sporadic traffic in production, bump the service to `starter` or higher in `render.yaml` (or from the Render Dashboard) to keep it warm.

When the deploy finishes, copy your service URL from the Render Dashboard. The rest of this guide uses `https://<service>.onrender.com`.

## 2. Test the live service

Start with the health endpoint:

```bash
curl https://<service>.onrender.com/health
```

A successful response confirms Render is forwarding traffic to the process started by `node dist/server.mjs`. If a call hangs or returns an error, open your service in the Render Dashboard and watch the **Logs** tab while you re-run the request. Every Flue agent invocation prints there.

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

Try a short conversation with the `assistant` agent:

```bash
curl https://<service>.onrender.com/agents/assistant/session-1 \
  -H "Content-Type: application/json" \
  -d '{"message": "What is the capital of Japan?"}'
```

Then send a follow-up using the same session ID:

```bash
curl https://<service>.onrender.com/agents/assistant/session-1 \
  -H "Content-Type: application/json" \
  -d '{"message": "How many people live there?"}'
```

Reusing the ID keeps Flue's session scope stable. On Node.js, that session state lives in memory unless you wire up a custom store.

Render closes idle HTTP connections after about 100 seconds. Most prompt-and-response agents finish well inside that window, but if you build agents that run long tool chains or large multi-step prompts, plan for either streamed responses or a scheduled / background runner (see [Going further](#going-further)) instead of a single blocking request.

If you only need webhook-triggered agents with in-memory sessions, you can stop here.

## 3. Review the web service config

Open the template's `render.yaml`. Its web service follows this shape:

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
- `sync: false` keeps the secret out of the Blueprint. Render prompts for the value on first deploy and stores it on the service.

If you ever move this setup into a different repo, drop the same `render.yaml` at its root, then create a new Blueprint from the Render Dashboard (**New > Blueprint**) and pick that repo.

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
curl https://<service>.onrender.com/agents/translate/verify \
  -H "Content-Type: application/json" \
  -d '{"text": "Good morning", "language": "Spanish"}'
```

A successful response means the new env values reached the running service and Flue can still talk to the provider.

## 5. Add session persistence

In-memory sessions disappear on every deploy or restart, and they don't help once you scale beyond one instance. If your agents need conversations that survive that, back them with a Render data store by implementing a Flue `SessionStore`. The Node guide's [Session persistence](./deploy-node.md#session-persistence) section covers the `SessionStore` interface (`save`, `load`, `delete`) and how to pass it via `init({ persist })`.

> **Starting fresh and want persistence built in?** Deploy the [Flue + Postgres template](https://render.com/templates/flue-with-postgresql) instead of the base template. It ships everything in this section preconfigured: a Render Postgres database wired into the web service via `DATABASE_URL`, a Postgres-backed `SessionStore` at `.flue/session-store.ts`, and the assistant agent already calling `init({ persist })`. The walkthrough below is for adding the same setup to a service you've already deployed from the base template.

Render Postgres is the best default for durable session history. Extend the template's `render.yaml` with a database and wire `DATABASE_URL` into the web service:

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

Add the Postgres client and wire up a `SessionStore` that reads `DATABASE_URL`:

```bash
npm install pg
npm install -D @types/pg
```

`.flue/session-store.ts`:

```typescript
import type { SessionStore, SessionData } from '@flue/runtime';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

let ready: Promise<void> | null = null;
async function ensureTable() {
  if (!ready) {
    ready = pool
      .query(
        `CREATE TABLE IF NOT EXISTS flue_sessions (
           id         text PRIMARY KEY,
           data       jsonb NOT NULL,
           updated_at timestamptz NOT NULL DEFAULT now()
         )`,
      )
      .then(() => undefined);
    // Reset on failure so the next call can retry instead of replaying
    // the original rejection forever.
    ready.catch(() => {
      ready = null;
    });
  }
  await ready;
}

export const sessionStore: SessionStore = {
  async save(id, data) {
    await ensureTable();
    await pool.query(
      `INSERT INTO flue_sessions (id, data, updated_at)
       VALUES ($1, $2::jsonb, now())
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [id, JSON.stringify(data)],
    );
  },
  async load(id) {
    await ensureTable();
    const { rows } = await pool.query<{ data: SessionData }>(
      `SELECT data FROM flue_sessions WHERE id = $1`,
      [id],
    );
    return rows[0]?.data ?? null;
  },
  async delete(id) {
    await ensureTable();
    await pool.query(`DELETE FROM flue_sessions WHERE id = $1`, [id]);
  },
};
```

Pass the store to the `assistant` agent's `init()`:

```typescript
import { sessionStore } from '../session-store';

const harness = await init({
  model: 'anthropic/claude-sonnet-4-6',
  persist: sessionStore,
});
```

The `connectionString` from `fromDatabase` is Render's internal Postgres URL, which doesn't require SSL. If you ever swap to the external connection string, add `ssl: { rejectUnauthorized: false }` to the `Pool` config.

To verify persistence end to end, run a fact-recall test that survives a process restart:

1. Commit the updated `render.yaml` and the new `SessionStore`, then wait for the database-aware deploy to go live.
2. Plant a fact in a fresh session:

   ```bash
   curl https://<service>.onrender.com/agents/assistant/persist-test \
     -H "Content-Type: application/json" \
     -d '{"message": "Remember this number for me: 42."}'
   ```

3. Restart the service from the Render Dashboard (**Manual Deploy > Restart Service**) so the in-memory state of the previous process is gone.
4. Once the service is healthy, ask for the fact back:

   ```bash
   curl https://<service>.onrender.com/agents/assistant/persist-test \
     -H "Content-Type: application/json" \
     -d '{"message": "What number did I ask you to remember?"}'
   ```

If the response references `42`, your `SessionStore` is reading and writing through Postgres correctly. If the agent has no idea, persistence isn't being read on session resume.

## Going further

A few patterns this guide doesn't cover yet:

- **Scheduled runs.** Some agents work better as periodic jobs than as webhooks (nightly summaries, weekly reports, cache refreshes). Deploy them as a Render cron job whose `startCommand` is `npx flue run <agent> --target node --id <id>`. Each fire builds, runs the agent once, and exits.
- **Queue-backed workers.** For continuous, queue-backed agents, reach for a Render background worker. A common setup: a web service enqueues a job, a background worker pulls it from Render Key Value, the worker invokes a Flue agent, and the result lands in your data store. When Key Value is backing a queue, set `maxmemoryPolicy: noeviction` so jobs are never evicted.

For more, see Render's [Cron Jobs](https://render.com/docs/cron-jobs), [Background Workers](https://render.com/docs/background-workers), and the [Blueprint reference](https://render.com/docs/blueprint-spec).

## Troubleshooting

When a step doesn't behave as expected, run through these quick checks:

| Symptom                              | Check                                                                                             |
| ------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Health check fails                   | Make sure `startCommand` is `node dist/server.mjs` and that the build produced `dist/server.mjs`. |
| Agent call returns a provider error  | Confirm the matching provider key is set in the service's environment variables.                  |
| Build can't find `flue`              | Make sure `@flue/cli` is installed and available during the build or start command.               |
| Agent forgets context after a deploy | Wire up a custom `SessionStore` backed by Postgres or Key Value.                                  |
