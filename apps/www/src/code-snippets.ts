// Prompt copied to the user's clipboard by the "Copy Prompt" CTA in the hero.
export const COPY_PROMPT = `fetch https://flueframework.com/start.md to create a new agent`;

export const HERO = `export default async function ({ init, payload, env }) {
  // Initialize a session with a default model.
  // By default, Flue spins up a lightweight virtual sandbox + filesystem.
  const session = await init({ model: 'anthropic/claude-sonnet-4-6' });

  // Leverage agent skills as typed, reusable LLM calls with structured output:
  const triage = await session.skill('triage', {
    args: { issueNumber: payload.issueNumber },
    result: v.object({ summary: v.string(), fixApplied: v.boolean() }),
  });

  // Keep absolute, deterministic control over the most critical decisions:
  if (triage.fixApplied) {
    await session.shell('git add -A && git commit --file -', { stdin: \`fix: \${triage.summary}\` });
  }

  // Run any CLI tool in the agent's sandbox (git, gh, curl, ...):
  const comment = await session.prompt('Write a GitHub comment summarizing the triage.');
  await session.shell(\`gh issue comment \${Number(payload.issueNumber)} --body-file -\`, { stdin: comment });
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
  const session = await init({ sandbox, model: 'openrouter/moonshotai/kimi-k2.6' });
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
  const session = await init({ model: 'anthropic/claude-opus-4-7' });
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
  const session = await init({ sandbox: daytona(sandbox), model: 'openai/gpt-5.5' });
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
  const session = await init({
    sandbox: await getVirtualSandbox('./data'),
    model: 'anthropic/claude-sonnet-4-6',
  });
  // Prompt! The agent harness includes your workspace AGENTS.md,
  // skills, and roles (aka subagents) to analyze the data and
  // complete your task as desired.
  return await session.prompt(
    \`Answer this user question: \${payload.message}\`,
    { role: 'data-analyst' },
  );
}`;
