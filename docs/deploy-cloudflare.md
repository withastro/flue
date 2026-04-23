# Deploy Agents on Cloudflare

Build and deploy Flue agents on Cloudflare Workers. This guide walks you through the different kinds of agents you can build — from simple prompt-and-response endpoints to full coding agents backed by persistent storage and container sandboxes.

## Hello World

The simplest agent — no container, no storage, just a prompt and a typed result.

### 1. Set up your project

```bash
mkdir my-flue-worker && cd my-flue-worker
npm init -y
npm install @flue/sdk valibot agents @cloudflare/sandbox
npm install -D @flue/cli wrangler
```

`agents` is Cloudflare's Agents SDK — Flue uses it to route HTTP requests to a per-agent Durable Object. `@cloudflare/sandbox` provides the container Sandbox Durable Object that Flue re-exports for agents that need a real container (see [Container agents](#container-agents) below). Both are runtime dependencies of the generated Worker bundle.

### 2. Create your first agent

`.flue/agents/translate.ts`:

```typescript
import type { FlueContext } from '@flue/sdk/client';
import * as v from 'valibot';

export const triggers = { webhook: true };

export default async function ({ init, payload }: FlueContext) {
  const session = await init();

  const result = await session.prompt(`Translate this to ${payload.language}: "${payload.text}"`, {
    result: v.object({
      translation: v.string(),
      confidence: v.picklist(['low', 'medium', 'high']),
    }),
  });

  return result;
}
```

A few things to note:

- **`triggers = { webhook: true }`** — This agent is invoked via HTTP. Flue creates a route for it automatically.
- **`init()` with no arguments** — By default, Flue gives every agent a virtual sandbox powered by [just-bash](https://github.com/vercel-labs/just-bash). No container needed. Virtual sandboxes are dramatically faster, cheaper, and more scalable than containers — perfect for high-traffic agents.
- **Result schemas** — The [Valibot](https://valibot.dev) schema defines the expected output shape. Flue parses the agent's response and returns a typed object.

### 3. Build and deploy

```bash
npx flue build --target cloudflare
npx wrangler deploy
```

`flue build --target cloudflare` compiles your workspace into a `./dist` directory containing a Cloudflare Workers-compatible artifact. `wrangler deploy` pushes it live.

### 4. Set your API key

> **Heads up:** Your agent will fail with a "No API key" error until you set an API key for your chosen model provider. Now that your Worker exists (from the first deploy above), you can set one as a secret.

The simplest way is to store it as a Worker secret with Wrangler:

```bash
npx wrangler secret put ANTHROPIC_API_KEY
```

Use the env var name your provider expects — `ANTHROPIC_API_KEY` for Anthropic, `OPENAI_API_KEY` for OpenAI, and so on. If you're routing through an AI gateway or have a different setup, follow your own process — as long as the expected variable is set as a Worker secret, the agent will pick it up. `wrangler secret put` deploys a new version of your Worker immediately, so the key is live as soon as the command completes.

We recommend doing this **after** your first `wrangler deploy` so the Worker exists when you set the secret.

### 5. Try it locally

For local development, use `wrangler dev` to run the worker locally:

```bash
npx flue build --target cloudflare
npx wrangler dev
```

Then test it:

```bash
curl http://localhost:8787/agents/translate/test-1 \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello world", "language": "French"}'
```

You can also test any agent from the CLI before deploying:

```bash
npx flue run translate --target cloudflare --session-id test-1 \
  --payload '{"text": "Hello world", "language": "French"}'
```

## Using the sandbox

By default, the virtual sandbox starts empty — no files, no skills, no context. This is fine for stateless prompt-and-response agents like the translator above. But many agents need files to work with.

Because the agent has shell access, it can set up its own workspace on the fly:

```typescript
import type { FlueContext } from '@flue/sdk/client';

export const triggers = { webhook: true };

export default async function ({ init, payload }: FlueContext) {
  const session = await init();

  // The agent has a full virtual filesystem and shell.
  // Set up context files before prompting.
  await session.shell(`mkdir -p /workspace/data`);
  await session.shell(`cat > /workspace/data/config.json << 'EOF'
{
  "rules": ["Be concise", "Use bullet points", "Cite sources"],
  "tone": "professional"
}
EOF`);

  return await session.prompt(
    `Read the config in /workspace/data/config.json.
     Generate a report about: ${payload.topic}`,
  );
}
```

The agent can use its built-in tools — grep, glob, read — to search and read these files. This is still running on a virtual sandbox (no container), so it's fast and cheap.

## R2-backed agents

Inline files work for small, static content. But for larger datasets — a knowledge base, documentation corpus, product catalog — you want persistent storage. Flue integrates with [Cloudflare R2](https://developers.cloudflare.com/r2/) to mount a bucket directly as the agent's filesystem.

### The support agent pattern

This is one of the most powerful patterns on Cloudflare: a support agent that searches a knowledge base to answer customer questions. The knowledge base lives in R2, and Flue mounts it as the sandbox filesystem — the agent searches it with grep, glob, and read, just like a real filesystem.

`.flue/agents/support.ts`:

```typescript
import { getVirtualSandbox } from '@flue/sdk/cloudflare';
import type { FlueContext } from '@flue/sdk/client';

export const triggers = { webhook: true };

export default async function ({ init, payload, env }: FlueContext) {
  const sandbox = await getVirtualSandbox(env.KNOWLEDGE_BASE);
  const session = await init({ sandbox });

  return await session.prompt(
    `You are a support agent. Search the knowledge base for articles
    relevant to this request, then write a helpful response.

    Customer: ${payload.message}`,
    {
      role: 'triager',
    },
  );
}
```

### Adding the R2 binding

Add the R2 bucket to your `wrangler.jsonc`:

```jsonc
{
  "name": "my-support-agent",
  "main": "dist/index.js",
  "compatibility_date": "2025-01-01",
  "compatibility_flags": ["nodejs_compat"],
  "r2_buckets": [
    {
      "binding": "KNOWLEDGE_BASE",
      "bucket_name": "my-knowledge-base",
    },
  ],
}
```

Upload your knowledge base to R2 using Wrangler:

```bash
# Upload individual files
wrangler r2 object put my-knowledge-base/articles/getting-started.md --file ./docs/getting-started.md

# Or upload a directory
for f in ./docs/**/*.md; do
  key="articles/${f#./docs/}"
  wrangler r2 object put "my-knowledge-base/$key" --file "$f"
done
```

### Why this works well

- **No container** — Still running on a virtual sandbox. Fast startup, low cost.
- **Persistent data** — The knowledge base lives in R2 and persists across requests.
- **Agent-native search** — The agent uses grep and glob to find relevant articles, just like it would in a real filesystem.
- **Session persistence** — Because this deploys to Cloudflare Workers with Durable Objects, message history and session state are automatically persisted. A customer can revisit a support session days later and pick up where they left off.

## Container agents

The examples above all run on virtual sandboxes — no container needed. But for agents that need a full Linux environment — git, Node.js, a browser, system packages — you want a real container.

Cloudflare has native container support via [`@cloudflare/sandbox`](https://developers.cloudflare.com/containers/). Each session gets its own isolated container with a persistent filesystem, shell, and full Linux userspace. The container image is defined in a `Dockerfile` that `flue build` generates for you.

`.flue/agents/assistant.ts`:

```typescript
import type { FlueContext } from '@flue/sdk/client';
import { getSandbox } from '@cloudflare/sandbox';

export const triggers = { webhook: true };

export default async function ({ init, sessionId, env, payload }: FlueContext) {
  // Each session gets its own container via Cloudflare's native sandbox.
  // The container is tied to the Durable Object — it persists across
  // requests for the same session.
  const sandbox = getSandbox(env.Sandbox, sessionId);
  const session = await init({ sandbox });

  return await session.prompt(payload.message);
}
```

The `Sandbox` binding is a Durable Object that Flue configures automatically in the generated `wrangler.jsonc`. No extra setup needed — `flue build --target cloudflare` generates both the wrangler config and a default `Dockerfile` for the container.

### Secure egress with outbound Workers

When your agent runs in a container, it may need to call external APIs — GitHub, npm registries, internal services. The traditional approach is to inject API tokens as environment variables, but that means the agent (and the LLM) has direct access to those secrets.

Cloudflare Sandboxes solve this with [outbound Workers](https://blog.cloudflare.com/sandbox-auth/) — a programmable egress proxy that intercepts outgoing HTTP/HTTPS requests from the container. Secrets are injected at the proxy layer, so the container never sees them. This is configured on the Cloudflare Sandbox class, outside of your Flue agent code:

```typescript
class MySandbox extends Sandbox {
  static outboundByHost = {
    'api.github.com': (request, env, ctx) => {
      const headers = new Headers(request.headers);
      headers.set('Authorization', `Bearer ${env.GITHUB_TOKEN}`);
      return fetch(request, { headers });
    },
  };
}
```

This is a zero-trust model — no token is ever granted to the untrusted sandbox. The proxy runs on the same machine as the container, so latency is minimal. You can also use outbound Workers to log requests, block specific domains, or enforce dynamic policies that change over the lifetime of a session.

For full details, see the [outbound Workers documentation](https://developers.cloudflare.com/containers/platform-details/outbound-traffic/).

### When to use containers

| Virtual sandbox                  | Container sandbox                           |
| -------------------------------- | ------------------------------------------- |
| Millisecond startup              | Seconds to start (cached images are faster) |
| Grep, glob, read, basic shell    | Full Linux: git, Node.js, Python, browsers  |
| R2 or inline files               | Real persistent filesystem                  |
| High-traffic / high-scale agents | Coding agents, complex dev environments     |

Most agents don't need a container. Start with a virtual sandbox and only move to containers when you need the full environment.

## Session persistence

When deploying to Cloudflare, Flue uses Durable Objects to automatically persist session state — message history, context, and sandbox state all survive across requests. This means you can build conversational agents where users pick up exactly where they left off.

This is built in when you deploy with `--target cloudflare`. No extra configuration needed.

## Skills and roles

**Skills** are reusable agent tasks defined as markdown files in `.agents/skills/`. They give the agent a focused instruction set for a specific job:

`.agents/skills/greet/SKILL.md`:

```markdown
---
name: greet
description: Generate a personalized greeting for a given name.
---

Given the name provided in the arguments, generate a warm, personalized
greeting. Keep it to one or two sentences.
```

**Roles** shape agent behavior across prompts. They live in `.flue/roles/`:

`.flue/roles/triager.md`:

```markdown
---
description: A support agent that triages customer requests
---

You are a support triager. Search the knowledge base thoroughly before
responding. Always cite the specific articles you referenced. Be empathetic
but concise.
```

Use them in your agent:

```typescript
// Run a skill with arguments and a typed result
const greeting = await session.skill('greet', {
  args: { name: 'World' },
  result: v.object({ greeting: v.string() }),
});

// Use a role to shape behavior
const response = await session.prompt('Help me reset my password', {
  role: 'triager',
});
```

## Building and deploying

Flue compiles your workspace into a deployable artifact. For Cloudflare, this means a Workers-compatible bundle:

```bash
# Build for Cloudflare
npx flue build --target cloudflare

# Local development
npx wrangler dev

# Deploy to production
npx wrangler deploy
```

Every agent with `triggers = { webhook: true }` gets an HTTP endpoint automatically. The route follows the pattern `/agents/<name>/<session-id>` — for example, `.flue/agents/translate.ts` becomes `/agents/translate/:sessionId`.

```bash
# Hit your deployed agent
curl https://my-support-agent.<your-subdomain>.workers.dev/agents/support/session-123 \
  -H "Content-Type: application/json" \
  -d '{"message": "How do I reset my password?"}'
```

### Choosing a sandbox strategy

Here's the progression of sandbox types available on Cloudflare, from simplest to most powerful:

1. **Empty virtual sandbox** — `init()` with no arguments. Fast, cheap, stateless. Good for prompt-and-response agents.
2. **Virtual sandbox with shell setup** — Use `session.shell()` to write files and configure the workspace. Still fast and cheap, good for agents that need small amounts of static context.
3. **R2-backed virtual sandbox** — `getVirtualSandbox(env.BUCKET)`. Persistent storage, searchable filesystem. Ideal for knowledge bases, support agents, data processing.
4. **Container sandbox** — Full Linux environment via `@cloudflare/sandbox`. For coding agents, complex dev environments, and anything that needs real system tools.

Start simple. Move up when you need to.
