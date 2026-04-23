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

2. Early on, ask me these questions before scaffolding anything:
   a. Where do I want to deploy? (e.g. Cloudflare, Node.js, GitHub Actions, Vercel, Fly.io, etc.)
   b. Any sandbox services I'd like to use? (e.g. Daytona, E2B, Modal — or Flue's default local/virtual sandbox)
   c. Which LLM provider / model family should the agent use? (e.g. Anthropic Claude, OpenAI GPT, Google Gemini.) This tells you which environment variable and default model ID to reference later.
   d. What do I want to build? A short description is fine — you can scaffold a simple first version.
   e. Where on disk should the project go? Flue agents can live as a standalone repo, or under \`.flue/\` inside an existing project. Ask me which fits my setup.

3. From the homepage, pick the deploy guide that best matches my answer to (a), follow the link, and read that guide.

4. When you need a model identifier for the scaffolded agent (e.g. \`'anthropic/claude-sonnet-4-20250514'\`), **look it up at https://models.dev/** for the provider I picked in (c) — don't guess from memory. Model IDs change frequently and your training data is likely out of date.

5. Scaffold a minimal first version of what I described. Keep it small — I'd rather iterate than start with a kitchen-sink scaffold.

**Rule:** Never invent values for API keys or other secrets. If the setup needs a secret (like the provider API key implied by 2c), either ask me to provide it or show me the exact command to set it myself — following whatever the deploy guide recommends. Running the agent with a fake key will fail in confusing ways later.
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
  // Prompt! The agent harness includes your workspace AGENTS.md,
  // skills, and roles (aka subagents) to complete your task as 
  // desired. Use \`session.skill()\` to call a skill directly.
  return await session.prompt(
    \`Respond to this customer message: \${payload.message}\`,
    { role: 'support-agent' },
  );
}`;

export const ISSUE_TRIAGE = `// Built for: Node, GitHub Actions
import type { FlueContext } from '@flue/sdk/client';
import { Octokit } from '@octokit/core';
import * as v from 'valibot';

// Triggered in CI via the CLI — no HTTP endpoint needed.
export const triggers = {};

export default async function ({ init, payload, env }: FlueContext) {
  const session = await init();
  // Run the 'triage' skill to triage the GitHub issue.
  const triage = await session.skill('triage', {
    args: { issueNumber: payload.issueNumber },
    result: v.object({
      severity: v.picklist(['low', 'medium', 'high', 'critical']),
      reproducible: v.boolean(),
      summary: v.string(),
    }),
  });
  // Post the triage result back to GitHub.
  // The agent/sandbox never sees your sensitive GITHUB_TOKEN.
  const octokit = new Octokit({ auth: env.GITHUB_TOKEN });
  await octokit.request('POST /repos/{owner}/{repo}/issues/{num}/comments', {
    owner: 'withastro',
    repo: 'flue',
    num: payload.issueNumber,
    body: \`**Severity:** \${triage.severity}\\n**Reproducible:** \${triage.reproducible}\\n\\n\${triage.summary}\`,
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
  const session = await init({ sandbox: daytona(sandbox) });
  // Setup the sandbox (for illustrative purposes only). 
  // In production, you'd want to bake setup into the container image,
  // or use a snapshot (if available from your sandbox provider).
  await session.shell(\`git clone \${payload.repo} /workspace/project\`);
  await session.shell('npm install', { cwd: '/workspace/project' });
  return await session.prompt(payload.prompt);
}`;

export const DATA_AGENT = `// Built for: Node
import type { FlueContext } from '@flue/sdk/client';
import { getVirtualSandbox } from '@flue/sdk/node';
import * as v from 'valibot';

// POST /agents/data/:id
export const triggers = { webhook: true };

export default async function ({ init, payload }: FlueContext) {
  // Mount the data analyst context to the agent session — this contains
  // all the files (context) & skills (abilities) needed for the agent to
  // complete its task. The agent can run \`ls\`, \`grep\`, write Python, 
  // and make read-only queries to fetch data from your analytics service.
  const session = await init({ sandbox: await getVirtualSandbox('./data') });
  // Prompt! The agent harness includes your workspace AGENTS.md,
  // skills, and roles (aka subagents) to analyze the data and
  // complete your task as desired.
  return await session.prompt(
    \`Answer this user question: \${payload.message}\`,
    { role: 'data-analyst' },
  );
}`;
