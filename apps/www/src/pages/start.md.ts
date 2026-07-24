import type { APIRoute } from 'astro';

const RUN_GUIDES = [
	[
		'Run in GitHub Actions',
		'https://flueframework.com/docs/ecosystem/deploy/github-actions/index.md',
	],
	['Run in GitLab CI/CD', 'https://flueframework.com/docs/ecosystem/deploy/gitlab-ci/index.md'],
] as const;

const DEPLOY_GUIDES = [
	['Deploy on Node.js', 'https://flueframework.com/docs/ecosystem/deploy/node/index.md'],
	['Deploy on Cloudflare', 'https://flueframework.com/docs/ecosystem/deploy/cloudflare/index.md'],
	['Deploy on Render', 'https://flueframework.com/docs/ecosystem/deploy/render/index.md'],
] as const;

const RUN_GUIDE_LIST = RUN_GUIDES.map(([title, url]) => `     - ${title}: ${url}`).join('\n');
const DEPLOY_GUIDE_LIST = DEPLOY_GUIDES.map(([title, url]) => `     - ${title}: ${url}`).join('\n');

const START_INSTRUCTIONS = `# Skill: Create a New Flue Agent

You are helping the user create their first Flue agent. Scaffold the project shell with \`flue init\`, then customize the starter it generates for the user's actual agent — do not hand-author the config and boilerplate files \`flue init\` already writes.

## Step 1: Gather Context

First, fetch and read the Flue homepage and getting started guide:

https://flueframework.com/
https://flueframework.com/docs/guide/getting-started/index.md

## Step 2: Discover Requirements

Determine the following. Ask the user only for information you do not already know from the conversation. If the user has already made a choice, treat that choice as binding.

1. What would they like to build?
   - Let their answer determine the smallest useful starter shape.
   - If they do not answer, or are not sure yet, keep the \`hello-world\` agent \`flue init\` scaffolds as-is — there is nothing extra to write.
   - The primitive is always an **agent**: a continuing assistant or event-driven agent with an identity and durable conversations. Examples: a chat assistant, support agent, coding agent, or message-driven triage agent.
   - When they also need a bounded, deterministic job (summarize a ticket, generate a report, run a scheduled task), model it as a **tool** the agent can call: a \`useTool({ name, description, harness: true, run: ({ harness }) => { ... } })\` call inside the agent function, with the returned instruction telling the model when to call it. Do not add a tool merely to test an agent — use \`flue run <path-to-agent-module> --message "..."\` for one local prompt.
2. Where should the project live on disk?
   - Use filesystem tools to inspect the current working directory first, then confirm the target directory with the user.
   - Note whether it's empty (a fresh project — the common case) or already has files (adding Flue to an existing app) — see Step 3.2 for why that changes how you invoke \`flue init\`.
3. How will they run it? \`flue run\` and a deployed HTTP server are equally first-class ways to use Flue — \`flue run\` is a complete way to ship an agent, not a "local-only" fallback for one that's really meant to be deployed.
   - **\`flue run\` only — their machine or a CI runner, no HTTP server, ever.** Fits personal tools, coding-agent-style agents, cron jobs, and CI contexts. Maps to \`flue init\`'s \`--target node\` with no \`--deploy\`.
     - Guides for CI contexts:
${RUN_GUIDE_LIST}
   - **Behind a server, reachable over HTTP.** Pick a host — Cloudflare Workers, Node.js (bare, Render, Fly.io, ...). Maps to \`--target cloudflare\` (the HTTP server setup is implied) or \`--target node --deploy\`.
     - Deploy guides:
${DEPLOY_GUIDE_LIST}
     - No guide for the chosen host? Use the Node.js guide as the baseline unless they ask for something else.
   - If they're not sure yet, default to \`flue run\` only: it needs nothing beyond \`flue init\`, and \`--deploy\` can be added to the same project later.
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
- Starter shape: \`agent only\` or \`agent + tool\`
- Project directory: \`<absolute or relative path>\` — \`empty\` or \`existing project\`
- How it runs: \`flue run only\` or \`deployed behind a server\`
- \`flue init\` flags: \`--target <node|cloudflare>\` \`[--deploy]\`
- Host/CI context (when deployed or CI-run): \`<target>\`
- Model specifier: \`<exact model specifier>\`

## Step 3: Scaffold with \`flue init\`, Then Customize

1. Run the scaffold from the project directory (or pass it as the positional argument), always passing \`--target\` explicitly:
   \`\`\`
   npx @flue/cli init <directory> --target <node|cloudflare> [--deploy]
   \`\`\`
   An agent shell has no TTY, so \`flue init\`'s interactive prompts fail with "cannot prompt here" if \`--target\` is omitted. This writes \`flue.config.ts\`, \`package.json\`, \`tsconfig.json\`, \`.gitignore\`, \`.env\`, \`src/agents/hello.ts\`, \`AGENTS.md\`, and \`README.md\` — plus, for \`--deploy\`/Cloudflare, \`vite.config.ts\` and \`src/app.ts\`, and \`src/cloudflare.ts\`/\`wrangler.jsonc\` (Cloudflare) or \`src/db.ts\` (Node). \`flue init\` writes files only; it never installs dependencies. This is the same command whichever path Step 2.3 landed on — only the flags differ.
2. **Existing (non-empty) directory:** without \`--force\`, \`flue init\` refuses to scaffold into it at all, and there's no interactive fallback — an agent shell has no TTY to answer the "scaffold anyway?" prompt. \`--force\` clears that refusal, but it also overwrites every file in the skeleton that already exists, including a \`package.json\`, \`vite.config.ts\`, or \`src/app.ts\` the user is already relying on.
   - Check the directory against the skeleton's filenames first: \`flue.config.*\`, \`package.json\`, \`tsconfig.json\`, \`.gitignore\`, \`.env\`, \`src/agents/\`, \`AGENTS.md\`, \`README.md\`, plus \`vite.config.ts\`/\`src/app.ts\` for \`--deploy\` and \`src/cloudflare.ts\`/\`wrangler.jsonc\` or \`src/db.ts\` for the target.
   - None of those exist yet: pass \`--force\` — there is nothing for it to overwrite, so it only clears the confirmation prompt.
   - Some exist and the user wants to keep them: don't pass \`--force\`. Scaffold into a fresh subdirectory instead (for example \`flue init ./flue\`) and fold the pieces into the existing project by hand — the Flue dependencies into \`package.json\`, the \`flue()\` plugin into \`vite.config.ts\`, the agent mount into \`app.ts\`.
3. Rename the generated starter to match the user's agent; leave everything else \`flue init\` wrote alone.
   - Rename \`src/agents/hello.ts\` to a lower-kebab-case filename for the agent (for example \`src/agents/support.ts\`) and rename the exported \`Hello\` function to a matching capitalized name (for example \`Support\`) — the function's name is its durable identity.
   - Replace the \`useModel(...)\` call with \`'<exact model specifier>'\` and the returned string with \`<short purpose-specific instruction>\`.
   - For an \`agent + tool\` starter, add \`useTool({ name, description, harness: true, run: ({ harness }) => { ... } })\` inside the function and mention the tool in the returned instruction.
   - If \`--deploy\` scaffolded \`src/app.ts\`, update its import and \`app.route(...)\` call to the renamed module path and function.
   - For the Cloudflare target, update the \`new_sqlite_classes\` entry in \`wrangler.jsonc\` from \`"FlueHelloAgent"\` to \`"Flue<NewName>Agent"\` — the generated Durable Object class name tracks the renamed function.
   - Update the \`flue run\` example paths in the generated \`AGENTS.md\` and \`README.md\` to the renamed module.
4. If they're running this in a CI context (GitHub Actions, GitLab CI/CD) rather than an ad hoc local \`flue run\`, fetch that guide and follow its workflow-file steps — \`flue init\` scaffolds the agent and the \`flue run\` command, not the CI wiring.
5. Add only the extra dependencies the starter shape needs beyond what \`flue init\` (or Step 3.2's manual fold-in) already added — for example a client library a tool calls out to.
6. Run \`npm install\` (or the detected package manager's equivalent). Then validate with \`flue run <path-to-agent-module> --message "..."\` once the user's model credentials are available — this is the primary smoke test whether or not \`--deploy\` was chosen. Also run the generated \`check:types\` script and, for \`--deploy\`, a \`vite build\`. If you cannot run these, explain why.
7. Finish with the exact next commands the user should run: how to set any required secrets, one \`flue run\` example prompt, and — only when \`--deploy\` was chosen — \`vite dev\` for the local server.

## Step 4: Verify Implementation

Before finishing, verify that the implementation matches the user's explicit choices:

- **Scaffold**: The project shell came from \`flue init\`, not hand-authored config — \`flue.config.ts\`, \`package.json\`, and the target-appropriate files exist (or, for a fold-in into an existing project, the equivalent pieces were added by hand).
- **Project location**: Files were created in the requested directory.
- **Agent module**: The renamed agent module starts with \`'use agent';\` and exports one capitalized agent function whose name matches its purpose; no leftover \`Hello\`/\`hello.ts\` reference remains.
- **Routing**: For \`--deploy\`, \`src/app.ts\` mounts the renamed agent via \`app.route('/agents/<name>', createAgentRouter(<AgentFunction>))\`.
- **Cloudflare migration**: For the Cloudflare target, \`wrangler.jsonc\`'s \`new_sqlite_classes\` entry matches the renamed \`Flue<Name>Agent\` class.
- **How it runs**: Config and commands match the user's choice — \`flue run\` only, or deployed behind the selected server/host.
- **LLM provider/model**: Model specifier is one of the suggested values, or an exact value from \`https://flueframework.com/models.json\` if the user requested another model.
- **Secrets**: No fake API keys, tokens, or secrets were invented; \`.env\` still holds only a placeholder until the user fills it in.
- **Dependencies**: Only dependencies \`flue init\` scaffolded (or Step 3.2's hand-added equivalents) plus anything the starter shape genuinely needs were added.

If any item does not match the user's choices, fix it before you finish.

In your final response, include a short checklist with the project directory, how it runs, agent module path, model specifier, and validation result.

## Important Instructions and Constraints to be Successful

- Important: Never invent API keys or secrets.
  - Instead: \`flue init\` writes \`.env\` with an empty placeholder; always ask the user to provide the real value. You can still help by showing them the command to set the secret, based on their local dev setup and chosen host.
- Important: Let \`flue init\` scaffold the project shell. Do not hand-write \`flue.config.ts\`, \`package.json\`, \`tsconfig.json\`, \`vite.config.ts\`, or \`src/app.ts\` from scratch — hand-authoring is only for folding Flue into files that already existed before \`flue init\` ran (Step 3.2).
- Important: \`--force\` now overwrites every file \`flue init\` would otherwise skip, not just \`flue.config.ts\`. Never pass it into a directory with files the user wants kept — see Step 3.2.
- Important: \`flue run\` is not a lesser path than deploying. An agent that only ever runs via \`flue run\` (personal tools, CI/cron jobs) is a complete, supported way to ship a Flue agent — don't steer the user toward \`--deploy\` or a server unless they actually need one reachable over HTTP.
- Important: Flue has no separate "workflow" primitive. A bounded job is a tool the agent calls (add \`harness: true\` for one that needs sandbox or model access); a durable conversation is the only durable unit. Do not import or reference \`defineWorkflow\` — it does not exist.
- Important: Once \`@flue/cli\` is installed in the project, the full Flue documentation is available offline through the CLI and always matches the installed version. Prefer it over fetching website URLs for follow-up questions:
  - \`npx flue docs search <query>\` — search the documentation (JSON results)
  - \`npx flue docs read <path>\` — print one documentation page as Markdown
  - \`npx flue docs\` — list all documentation pages
- Important: \`flue run\` executes one agent module locally under Node with no HTTP server: \`npx flue run src/agents/<name>.ts --message "Hello"\` streams the agent's activity, prints the reply, and prints the conversation id. Pass \`--id <conversation-id>\` to continue the same conversation across invocations. It loads the project's \`.env\` automatically, shell values winning (\`--env <path>\` selects another file).
- Important: For a deployed server, use \`vite dev\` for local development (the \`flue()\` plugin serves the application, watches for file changes, and hot-reloads on edits) and \`vite build\` for production; the Node target emits \`dist/server.mjs\` to run with \`node dist/server.mjs\`. There are no \`flue dev\` or \`flue build\` commands. \`vite dev\` also loads \`.env\` automatically.
`;

export const GET: APIRoute = () => {
	return new Response(START_INSTRUCTIONS, {
		headers: {
			'Content-Type': 'text/markdown; charset=utf-8',
		},
	});
};
