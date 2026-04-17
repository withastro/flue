export const HERO = `// .flue/agents/triage.ts

export default async function ({ init, payload }) {
  const session = await init({ sandbox: new YourFavoriteSandboxProvider() }); 
  const result = await session.skill('triage', {
    args: { issueNumber: payload.issueNumber },
    result: v.object({ summary: v.string(), fix_applied: v.boolean() }),
  });
  if (result.fix_applied) {
    await session.shell('git add -A');
    await session.shell('git commit -m "fix: ' + result.summary + '"');
  }
  const comment = await session.prompt(\`Write a GitHub comment summarizing this triage: \${result.summary}\`);
  await session.shell(\`gh issue comment \${payload.issueNumber} --body-file -\`, { stdin: comment });
}`;

export const SUPPORT_AGENT = `// .flue/agents/support.ts
import { getVirtualSandbox } from '@flue/sdk/cloudflare';
import type { FlueContext } from '@flue/sdk/client';

export const triggers = { webhook: true };

export default async function ({ init, payload, env }: FlueContext) {
  // Mount the R2 knowledge base as the agent's filesystem.
  // The agent can grep, glob, and read articles with bash,
  // without needing to spin up an entire container sandbox.
  const sandbox = await getVirtualSandbox(env.KNOWLEDGE_BASE);
  const session = await init({ sandbox });

  return await session.prompt(
    \`You are a support agent. Search the knowledge base for articles
    relevant to this request, then write a helpful response.

    Customer: \${payload.message}\`,
    { role: 'triager' },
  );
}`;

export const ISSUE_TRIAGE = `// .flue/agents/triage.ts
import { defineCommand, type FlueContext } from '@flue/sdk/client';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/** Triggered via CI, so no need to expose this as API... yet. */
export const triggers = {webhook: false};

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

export const CODING_AGENT = `// .flue/agents/code.ts
import type { FlueContext } from '@flue/sdk/client';
import { Daytona } from '@daytona/sdk';
import { daytona } from '@flue/connectors/daytona';

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

export const DATA_AGENT = `// .flue/agents/data.ts
import type { FlueContext } from '@flue/sdk/client';

export const triggers = { webhook: true };

export default async function ({ init, payload }: FlueContext) {
  const session = await init({ sandbox: 'local' });
  const plan = await session.skill('query-planner', {
    args: { query: payload.query },
    result: v.object({
      sql: v.string(),
      visualization: v.picklist(['table', 'chart', 'summary']),
    }),
  });
  const results = await session.shell(\`duckdb company.db "\${plan.sql}"\`);
  return await session.prompt(
    \`Summarize these results for the user: \${results}\`,
    { result: v.object({ answer: v.string(), insights: v.array(v.string()) }) },
  );
}`;
