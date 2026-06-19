import type { APIRoute } from 'astro';

const DEPLOY_GUIDES = [
	['Deploy on Node.js', 'https://flueframework.com/docs/ecosystem/deploy/node/index.md'],
	['Deploy on Cloudflare', 'https://flueframework.com/docs/ecosystem/deploy/cloudflare/index.md'],
	[
		'Deploy on GitHub Actions',
		'https://flueframework.com/docs/ecosystem/deploy/github-actions/index.md',
	],
	['Deploy on GitLab CI/CD', 'https://flueframework.com/docs/ecosystem/deploy/gitlab-ci/index.md'],
	['Deploy on Render', 'https://flueframework.com/docs/ecosystem/deploy/render/index.md'],
] as const;

const DEPLOY_GUIDE_LIST = DEPLOY_GUIDES.map(([title, url]) => `   - ${title}: ${url}`).join('\n');

const START_INSTRUCTIONS = `# Skill: Create a New Flue Agent

You are helping the user create their first Flue agent. Start with one agent module, and add a workflow only when the user's goal needs a finite, result-oriented operation around that agent.

## Step 1: Gather Context

First, fetch and read the Flue homepage and quickstart:

https://flueframework.com/
https://flueframework.com/docs/getting-started/quickstart/index.md

## Step 2: Discover Requirements

Determine the following. Ask the user only for information you do not already know from the conversation. If the user has already made a choice, treat that choice as binding.

1. What would they like to build?
   - Let their answer determine the smallest useful starter shape.
   - If they do not answer, or are not sure yet, create a minimal \`hello-world\` agent module only. Do not create a workflow by default.
   - Choose **agent only** for a continuing assistant or event-driven agent with an identity and sessions that can accept interactions over time. Examples: a chat assistant, support agent, coding agent, or message-driven triage agent.
   - Choose **agent + workflow** when they also need a bounded job that runs once and returns a result. Examples: summarize a ticket, generate a report, handle a CI task, or execute scheduled/batch orchestration.
   - Do not create a workflow merely to test or talk to an agent. An agent can be used locally with \`flue connect\`.
2. Where should the project live on disk?
   - Use filesystem tools to inspect the current working directory first, then confirm the target directory with the user.
   - Flue supports three authored source layouts:
     - \`.flue\` layout: \`./.flue/agents/\` and \`./.flue/workflows/\`.
     - \`src\` layout: \`./src/agents/\` and \`./src/workflows/\`.
     - Root layout: \`./agents/\` and \`./workflows/\`.
   - Flue selects the first existing source directory in this order: \`.flue/\`, \`src/\`, then the project root.
   - Prefer the \`src\` layout for new projects. Use \`.flue\` when adding a self-contained Flue source area to a larger application. Preserve the root layout for an existing compact project.
   - Never mix layouts. Flue discovers entrypoints from only the selected source directory.
3. Where should it deploy? For example: Cloudflare Workers, Node.js, GitHub Actions, GitLab CI/CD, Vercel, Fly.io.
   - Available deploy guides:
${DEPLOY_GUIDE_LIST}
   - If they choose a host without a deploy guide, use the Node.js guide as the baseline unless they ask for something else.
4. Do they have an LLM provider/model in mind?
   - Optional, but recommended. Setup is easier if you know which provider they plan to use, because you can scaffold the right model specifier and environment variable names.
   - We suggest these exact model specifiers:
     - \`anthropic/claude-sonnet-4-6\` - latest Sonnet
     - \`anthropic/claude-opus-4-7\` - latest Opus
     - \`openai/gpt-5.5\` - GPT-5.5
     - \`openrouter/moonshotai/kimi-k2.6\` - latest Kimi
   - If the user wants a different provider or model, use this list to get the best model specifier: \`https://flueframework.com/models.json\`
   - If their requested model is unavailable, ask before substituting another model. Don't continue until you have a model specifier.

Before implementing, restate the chosen requirements to yourself as an implementation contract:

- Agent purpose: \`<purpose>\`
- Starter shape: \`agent only\` or \`agent + workflow\`
- Project directory: \`<absolute or relative path>\`
- Source layout: \`.flue\`, \`src\`, or \`root\`
- Agent module path: \`./.flue/agents/<name>.ts\`, \`./src/agents/<name>.ts\`, or \`./agents/<name>.ts\`
- Workflow module path, if needed: \`none\` or the selected layout's \`workflows/<name>.ts\`
- Deploy target: \`<target>\`
- Model specifier: \`<exact model specifier>\`

## Step 3: Build the Smallest Useful Starter Project

1. Pick the deploy guide that best matches the user's target, fetch it, and follow its package, target, configuration, secrets, and deployment guidance.
   - Some deploy-guide starter examples may use a workflow. Treat those as deployment examples, not as a requirement to create a workflow. Preserve the selected starter shape.
2. Create or update the project in the requested directory using the selected source layout.
3. Always create one minimal **agent module** matching the user's idea, keeping it closer to "hello world" than a production app.
   - Put it in the selected layout's immediate \`agents/\` directory, using a lower-kebab-case filename such as \`src/agents/hello-world.ts\`.
   - It must default-export \`createAgent(() => ({ model: '<exact model specifier>', instructions: '<short purpose-specific instruction>' }))\`.
   - Do not export \`route\` unless the user needs direct HTTP access. For a basic local starter, use \`flue connect <agent-name> local\` instead.
4. If the selected shape is **agent + workflow**, create one minimal **workflow module** for the finite job.
   - Put it in the selected layout's immediate \`workflows/\` directory, using a lower-kebab-case filename.
   - Export \`run(...)\`, initialize a harness directly with \`const harness = await init({ model: '<exact model specifier>', instructions: '<short purpose-specific instruction>' })\`, open a session, perform one purpose-specific operation, and return its result. Do not import the addressable agent module into the workflow.
   - Export workflow \`route\` only if the user needs that invocation surface.
5. Add \`tsconfig.json\` for TypeScript editor/typechecking support.
   - If no \`tsconfig.json\` exists, create this minimal one:
     \`\`\`json
     {
       "compilerOptions": {
         "target": "ES2024",
         "module": "ESNext",
         "moduleResolution": "Bundler",
         "strict": true,
         "skipLibCheck": true
       },
       "include": ["src/**/*.ts", "agents/**/*.ts", "workflows/**/*.ts", ".flue/**/*.ts"],
       "exclude": ["dist"]
     }
     \`\`\`
   - If \`tsconfig.json\` already exists, do not replace it. Make the smallest safe change needed to include the generated authored-source files.
   - TypeScript may ignore hidden directories by default, so projects using the \`.flue\` layout usually need \`.flue/**/*.ts\` included explicitly.
6. Add only the dependencies and config required by the selected deploy guide and chosen starter shape.
7. Run the most relevant validation command you can, such as build, typecheck, \`flue connect\` for an agent, or a local workflow invocation when a workflow was created. If you cannot run it, explain why.
8. Finish with the exact next commands the user should run, including how to set any required secrets and how to interact with the addressable agent or invoke the workflow.

## Step 4: Verify Implementation

Before finishing, verify that the implementation matches the user's explicit choices:

- **Project location**: Files were created in the requested directory.
- **Source layout**: Files use only the selected \`.flue\`, \`src\`, or root layout; entrypoints were placed only in the selected source directory.
- **Agent module**: One agent module exists in the selected layout's \`agents/<name>.ts\` and default-exports \`createAgent(...)\`.
- **Workflow choice**: No workflow was added for an agent-only starter; for an agent + workflow starter, one workflow module initializes a harness directly with \`init(AgentRuntimeConfig, options?)\`.
- **Deploy target**: Config and commands match the user's selected deploy target.
- **LLM provider/model**: Model specifier is one of the suggested values, or an exact value from \`https://flueframework.com/models.json\` if the user requested another model.
- **Secrets**: No fake API keys, tokens, or secrets were invented.
- **Dependencies**: Only dependencies required by the selected deploy guide and starter shape were added.

If any item does not match the user's choices, fix it before you finish.

In your final response, include a short checklist with the project directory, source layout, agent module path, workflow module path or \`none\`, deploy target, model specifier, and validation result.

## Important Instructions and Constraints to be Successful

- Important: Never invent API keys or secrets.
  - Instead: You can scaffold out obvious placeholders, but always ask the user to provide the API secrets/keys/tokens themselves. You can still help the user by showing them the command to run to set the secret, based on their local dev setup and chosen host.
- Important: A direct prompt to an agent or a dispatched agent input is not a workflow run. Use workflow terminology only for an invocation of a workflow module.
- Important: Once \`@flue/cli\` is installed in the project, the full Flue documentation is available offline through the CLI and always matches the installed version. Prefer it over fetching website URLs for follow-up questions:
  - \`npx flue docs search <query>\` — search the documentation (JSON results)
  - \`npx flue docs read <path>\` — print one documentation page as Markdown
  - \`npx flue docs\` — list all documentation pages
- Important: For local development, prefer \`flue dev --target node\` or \`flue dev --target cloudflare\`. The dev server defaults to port 3583, watches for file changes, and rebuilds + reloads on edits.
  - Instead of: combining \`flue build\` with \`wrangler dev\` (the previous workflow). \`flue dev --target cloudflare\` covers that case directly and stays in sync with what \`wrangler deploy\` will bundle.
- Important: \`flue run --target cloudflare\` is not supported.
  - Instead: \`flue run\` only supports \`--target node\`. To exercise a Cloudflare HTTP endpoint locally, use \`flue dev --target cloudflare\` and call the exposed endpoint. For deployed Cloudflare invocations, build with \`flue build --target cloudflare\` and call the deployed endpoint after \`wrangler deploy\`.
`;

export const GET: APIRoute = () => {
	return new Response(START_INSTRUCTIONS, {
		headers: {
			'Content-Type': 'text/markdown; charset=utf-8',
		},
	});
};
