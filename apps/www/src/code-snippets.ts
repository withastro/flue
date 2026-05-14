// Prompt copied to the user's clipboard by the "Copy Prompt" CTA in the hero.
export const COPY_PROMPT = `fetch https://flueframework.com/start.md to create a new agent`;

export const HERO = `export default async function ({ init, payload, env }) {
  // Initialize a new agent. 
  // Provide a hosted sandbox, or use Flue's built-in virtual sandbox.
  const harness = await init({ model: 'anthropic/claude-sonnet-4-6' });
  const session = await harness.session();

  // Call skills as reusable workflows with structured output:
  const { data } = await session.skill('triage', {
    args: { issueNumber: payload.issueNumber },
    result: v.object({ fixApplied: v.boolean(), summary: v.string() }),
  });

  // Keep track of work in the session, just like Claude Code or Codex:
  const comment = await session.prompt('Write a GitHub comment summarizing the triage.');

  // Keep absolute control over the agent's most critical decisions:
  if (data.fixApplied) {
    await session.shell(\`git add -A && git commit -m \${JSON.stringify(\`fix: \${data.summary}\`)}\`);
  }

  // Protect your sensitive tokens and API keys with fine-grained control:
  await session.fs.writeFile('/tmp/comment.md', comment.text);
  await session.shell(\`gh issue comment \${Number(payload.issueNumber)} --body-file /tmp/comment.md\`, { 
    env: { GITHUB_TOKEN: env.GITHUB_TOKEN },
  });
}`;

export const SUPPORT_AGENT = `import { getVirtualSandbox } from '@flue/runtime/cloudflare';
import type { FlueContext } from '@flue/runtime';

// POST /agents/support/:id
export const triggers = { webhook: true };

// Built for: Cloudflare Workers, R2
export default async function ({ init, payload, env }: FlueContext) {
  // Mount your R2 bucket (declared as a binding in wrangler.jsonc) as
  // the agent's filesystem at /workspace, backed by Durable Object
  // SQLite + R2 under the hood. The agent searches it with bash —
  // grep, glob, read — without spinning up a container.
  const sandbox = await getVirtualSandbox(env.KNOWLEDGE_BASE_BUCKET);
  const harness = await init({ sandbox, model: 'openrouter/moonshotai/kimi-k2.6' });
  const session = await harness.session();
  // Prompt! The agent harness includes your workspace AGENTS.md,
  // skills, and roles (aka subagents) to complete your task as 
  // desired. Use \`session.skill()\` to call a skill directly.
  return await session.prompt(
    \`Respond to this customer message: \${payload.message}\`,
    { role: 'support-agent' },
  );
}`;

export const ISSUE_TRIAGE = `import type { FlueContext } from '@flue/runtime';
import { Octokit } from '@octokit/core';
import * as v from 'valibot';

// Triggered in CI via \`flue run\` CLI — no HTTP endpoint needed.
export const triggers = {};

// Built for: Node, GitHub Actions
export default async function ({ init, payload, env }: FlueContext) {
  const { issueNumber } = payload;
  const harness = await init({ model: 'anthropic/claude-opus-4-7' });
  const session = await harness.session();
  // Run the 'triage' skill to triage the GitHub issue.
  const { data } = await session.skill('triage', {
    args: { issueNumber },
    result: v.object({
      severity: v.picklist(['low', 'medium', 'high', 'critical']),
      reproducible: v.boolean(),
      summary: v.string(),
    }),
  });
  // Post the triage result back to GitHub.
  // The agent/sandbox never sees your sensitive GITHUB_TOKEN.
  const body = \`**Severity:** \${data.severity}\\n**Reproducible:** \${data.reproducible}\\n\\n\${data.summary}\`;
  await (new Octokit({ auth: env.GITHUB_TOKEN })).request(
    'POST /repos/{owner}/{repo}/issues/{num}/comments', 
    { owner: 'withastro', repo: 'flue', num: issueNumber, body },
  );
}`;

export const CODING_AGENT = `import type { FlueContext } from '@flue/runtime';
import { Daytona } from '@daytona/sdk';
import { daytona } from '../connectors/daytona';

// POST /agents/code/:id
export const triggers = { webhook: true };

// Built for: Node, Daytona
export default async function ({ init, payload, env }: FlueContext) {
  // Each agent gets a real container via Daytona.
  const client = new Daytona({ apiKey: env.DAYTONA_API_KEY });
  const sandbox = await client.create();
  const harness = await init({ sandbox: daytona(sandbox), model: 'openai/gpt-5.5' });
  const session = await harness.session();
  // Setup the sandbox (for illustrative purposes only). 
  // In production, you'd want to bake setup into the container image,
  // or use a snapshot (if available from your sandbox provider).
  await session.shell(\`git clone \${payload.repo} /workspace/project\`);
  await session.shell('npm install', { cwd: '/workspace/project' });
  return await session.prompt(payload.prompt);
}`;

export const DATA_AGENT = `import type { FlueContext } from '@flue/runtime';
import { Bash, InMemoryFs, MountableFs, ReadWriteFs } from 'just-bash';

// POST /agents/data/:id
export const triggers = { webhook: true };

// Built for: Node
export default async function ({ init, payload }: FlueContext) {
  // Mount the current directory at /workspace, so the agent can read,
  // write, grep, and glob from your project files using bash.
  const fs = new MountableFs({ base: new InMemoryFs() });
  fs.mount('/workspace', new ReadWriteFs({ root: process.cwd() }));

  // Create a custom virtual sandbox with 'just-bash'. Enable Python use
  // so the agent can write code to analyze data, generate reports, etc.
  const harness = await init({
    sandbox: () => new Bash({ fs, cwd: '/workspace', python: true }),
    model: 'anthropic/claude-sonnet-4-6',
  });
  const session = await harness.session();
  // Prompt! The agent harness includes your workspace AGENTS.md,
  // skills, and roles (aka subagents) to analyze the data and
  // complete your task as desired.
  return await session.prompt(
    \`Answer this user question: \${payload.message}\`,
    { role: 'data-analyst' },
  );
}`;
