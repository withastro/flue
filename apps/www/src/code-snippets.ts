// Prompt copied to the user's clipboard by the "Copy Prompt" CTA in the hero.
// Designed to be pasted into a capable coding agent (Claude Code, Cursor,
// Copilot, etc.) as a self-contained onboarding flow: the agent reads the
// homepage + README, interviews the user, follows the matching deploy guide,
// and scaffolds a minimal Flue agent.
//
// Tone: the user is speaking TO the agent. Steps are directive but light —
// the agent ultimately drives the flow.
export const COPY_PROMPT = `Help me set up a new Flue project. Flue is a TypeScript framework for building sandbox AI agents.

Please do the following:

1. Fetch and read these two pages:
   - https://flueframework.com/
   - https://raw.githubusercontent.com/withastro/flue/refs/heads/main/README.md

2. Early on, ask me these four questions before scaffolding anything:
   a. Where do I want to deploy? (e.g. Cloudflare, Node.js, GitHub Actions, Vercel, Fly.io, etc.)
   b. Any sandbox services I'd like to use? (e.g. Daytona, E2B, Modal — or Flue's default local/virtual sandbox)
   c. What do I want to build? A short description is fine — you can scaffold a simple first version.
   d. Where on disk should the project go? Flue agents can live as a standalone repo, or under \`.flue/\` inside an existing project. Ask me which fits my setup.

3. From the homepage, pick the deploy guide that best matches my answer to (a), follow the link, and read that guide.

4. Scaffold a minimal first version of what I described. Keep it small — I'd rather iterate than start with a kitchen-sink scaffold.
`;

export const HERO = `export default async function ({ init, payload, env }) {
  // Initialize a new agent session, or resume an existing one.
  // By default, Flue spins up a lightweight virtual sandbox + filesystem.
  const session = await init();

  // Leverage agent skills as typed, reusable LLM calls with structured output:
  const triage = await session.skill('triage', {
    args: { issueNumber: payload.issueNumber },
    result: v.object({ summary: v.string(), fixApplied: v.boolean() }),
  });

  // Keep absolute, deterministic control over the most critical decisions:
  if (triage.fixApplied) {
    await session.shell(\`git add -A && git commit -m "fix: \${triage.summary}"\`);
  }

  // Run any CLI tool in the agent's sandbox (git, gh, curl, ...):
  const comment = await session.prompt('Write a GitHub comment summarizing the triage.');
  await session.shell(\`gh issue comment \${payload.issueNumber} --body-file -\`, { stdin: comment });
}`;

export const SUPPORT_AGENT = `// Built for: Cloudflare
import { getVirtualSandbox } from '@flue/sdk/cloudflare';
import type { FlueContext } from '@flue/sdk/client';

// POST /agents/support/:id
export const triggers = { webhook: true };

export default async function ({ init, payload, env }: FlueContext) {
  // Mount a bucket as your agent's filesystem in a virtual sandbox.
  // The agent can grep, glob, and read from the knowledge base with 
  // bash, without the need of a traditional, expensive container.
  const sandbox = await getVirtualSandbox(env.KNOWLEDGE_BASE);
  const session = await init({ sandbox });

  return await session.prompt(
    \`You are a support agent. Search the knowledge base for articles
    relevant to this request, then write a helpful response.

    Customer: \${payload.message}\`,
    { role: 'triager' },
  );
}`;

export const ISSUE_TRIAGE = `// Built for: Node, GitHub Actions
import type { FlueContext } from '@flue/sdk/client';
import * as v from 'valibot';

// Triggered in CI via the CLI — no HTTP endpoint needed.
export const triggers = {};

export default async function ({ init, payload }: FlueContext) {
  const session = await init({ sandbox: 'local' });
  return await session.skill('triage', {
    args: { issueNumber: payload.issueNumber },
    result: v.object({
      severity: v.picklist(['low', 'medium', 'high', 'critical']),
      reproducible: v.boolean(),
      summary: v.string(),
    }),
  });
}`;

export const CODING_AGENT = `// Built for: Node, Daytona
import type { FlueContext } from '@flue/sdk/client';
import { Daytona } from '@daytona/sdk';
import { daytona } from '@flue/connectors/daytona';

// POST /agents/code/:id
export const triggers = { webhook: true };

export default async function ({ init, payload, env }: FlueContext) {
  // Each session gets a real container via Daytona.
  const client = new Daytona({ apiKey: env.DAYTONA_API_KEY });
  const sandbox = await client.create();
  const session = await init({
    sandbox: daytona(sandbox, { cleanup: true }),
  });

  await session.shell(\`git clone \${payload.repo} /workspace/project\`);
  await session.shell('npm install', { cwd: '/workspace/project' });

  return await session.prompt(payload.prompt);
}`;

export const DATA_AGENT = `// Built for: Node
import type { FlueContext } from '@flue/sdk/client';
import * as v from 'valibot';

// POST /agents/data/:id
export const triggers = { webhook: true };

export default async function ({ init, payload, env }: FlueContext) {
  const session = await init({ sandbox: 'local' });
  const plan = await session.skill('query-planner', {
    args: { query: payload.query },
    result: v.object({ sql: v.string() }),
  });
  // Query the company's analytics API from inside the sandbox.
  const results = await session.shell(
    \`curl -s -X POST "\${env.ANALYTICS_API_URL}/query" \\
       -H "Authorization: Bearer \${env.ANALYTICS_API_KEY}" \\
       -H "Content-Type: application/json" \\
       -d '{"sql": "\${plan.sql}"}'\`,
  );
  return await session.prompt(
    \`Summarize these results for the user: \${results}\`,
    { result: v.object({ answer: v.string(), insights: v.array(v.string()) }) },
  );
}`;
