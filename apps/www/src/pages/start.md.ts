import type { APIRoute } from 'astro';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const docsDir = join(repoRoot, 'docs');
const rawDocsUrl = 'https://raw.githubusercontent.com/withastro/flue/refs/heads/main/docs';

async function getDeployGuideList() {
	const files = (await readdir(docsDir))
		.filter((file) => file.startsWith('deploy-') && file.endsWith('.md'))
		.sort();

	const guides = await Promise.all(
		files.map(async (file) => {
			const contents = await readFile(join(docsDir, file), 'utf-8');
			const title = contents.match(/^#\s+(.+)$/m)?.[1] ?? file;

			return `   - ${title}: ${rawDocsUrl}/${file}`;
		}),
	);

	return guides.join('\n');
}

const START_INSTRUCTIONS = `# Skill: Create a New Flue Agent

You are helping the user create a new Flue agent.

## Step 1: Gather Context

First, fetch and read the Flue README and homepage:

https://raw.githubusercontent.com/withastro/flue/refs/heads/main/README.md
https://flueframework.com/

## Step 2: Discover Requirements

Then, determine the following. Ask the user only for information you do not already know from the conversation. If the user has already made a choice, treat that choice as binding.

1. What should the agent do?
   - Use this to create a simple starter agent in the theme of what they are building.
   - Suggest/recommend a simple "hello world" agent, but give them room to request a specific focus/agent instead.
2. Where should the project live on disk?
   - Use filesystem tools to inspect the current working directory first. Infer its layout as the default target using the layout rules below.
   - Confirm with the user that they want to implement there. Mention the inferred layout in that confirmation. For example: "Use the current directory with the \`.flue\` layout because it already has files?"
   - If they choose a different location, inspect that directory instead and infer the layout again using the same layout rules.
   - Project layout rules:
     - Directory does not exist: create it and use the root layout: \`./agents/\` and \`./roles/\`.
     - Directory exists and is empty: use the root layout: \`./agents/\` and \`./roles/\`.
     - Directory exists and already has files: use the \`.flue\` layout: \`./.flue/agents/\` and \`./.flue/roles/\`.
3. Where should it deploy? For example: Cloudflare Workers, Node.js, GitHub Actions, GitLab CI/CD, Vercel, Fly.io.
   - Available deploy guides:
${await getDeployGuideList()}
   - If they choose a host without a deploy guide, use the Node.js guide as the baseline unless they ask for something else.
4. Do they have an LLM provider/model in mind?
   - Optional, but recommended. Setup is easier if you know which provider they plan to use, because you can scaffold the right model identifier and environment variable names.
   - We suggest these exact model IDs:
     - \`anthropic/claude-sonnet-4-6\` - latest Sonnet
     - \`anthropic/claude-opus-4-7\` - latest Opus
     - \`openai/gpt-5.5\` - GPT-5.5
     - \`openrouter/moonshotai/kimi-k2.6\` - latest Kimi
   - If the user wants a different provider or model, use this list to get the best model ID: \`https://flueframework.com/models.json\`
   - If their requested model is unavailable, ask before substituting another model. Don't continue until you have a model ID.

Before implementing, restate the chosen requirements to yourself as an implementation contract:

- Agent purpose: \`<purpose>\`
- Project directory: \`<absolute or relative path>\`
- Workspace layout: \`root\` if the target directory is new or empty, otherwise \`.flue\`
- Agent file path: \`./agents/<name>.ts\` or \`./.flue/agents/<name>.ts\`
- Deploy target: \`<target>\`
- Provider/model: \`<exact model id>\`

## Step 3: Build the Smallest Useful Starter Project

1. Pick the deploy guide that best matches the user's target, fetch it, and follow it.
2. Prefer the collapsible starter template files near the top of the deploy guide for package and config scaffolding. Adapt paths to the inferred workspace layout.
   - If the target directory is new or empty and the guide shows \`.flue/agents/hello.ts\`, create \`./agents/hello.ts\` instead.
   - If the target directory has files and the guide shows \`agents/hello.ts\`, create \`./.flue/agents/hello.ts\` instead.
3. Create or update the project in the requested directory.
4. Scaffold one minimal Flue agent that matches the user's idea. Keep it closer to "hello world" than production app.
5. Pass the selected model ID to \`init({ model: '<exact model id>' })\`. Flue does not choose a model automatically.
6. Add only the dependencies and config required by the selected deploy guide.
7. Run the most relevant validation command you can, such as build, typecheck, or a local Flue run. If you cannot run it, explain why.
8. Finish with the exact next commands the user should run, including how to set any required secrets.

## Step 4: Verify Implementation

Before finishing, verify that the implementation matches the user's explicit choices:

- **Project location**: Files were created in the requested directory.
- **Workspace layout**: Agent file is in the exact location corresponding to the inferred layout.
  - New or empty target directory means root layout: \`./agents/<name>.ts\`.
  - Existing non-empty target directory means \`.flue\` layout: \`./.flue/agents/<name>.ts\`.
- **Deploy target**: Config and commands match the user's selected deploy target.
- **LLM provider/model**: Model identifier is one of the suggested exact IDs, or an exact value from \`https://flueframework.com/models.json\` if the user requested another model.
- **Agent initialization**: The selected model ID is passed to \`init({ model })\`, or to individual \`prompt()\` / \`skill()\` calls (not common).
- **Secrets**: No fake API keys, tokens, or secrets were invented.
- **Dependencies**: Only dependencies required by the selected deploy guide were added.

If any item does not match the user's choices, fix it before you finish.

In your final response, include a short checklist with the project directory, inferred layout, agent file path, deploy target, model ID, and validation result.

## Important Instructions and Constraints to be Successful

- Important: Never invent API keys or secrets.
  - Instead: You can scaffold out obvious placeholders, but always ask the user to provide the API secrets/keys/tokens themselves. You can still help the user by showing them the command to run to set the secret, based on their local dev setup and chosen host.
- Important: For local development, prefer \`flue dev --target node\` or \`flue dev --target cloudflare\`. The dev server defaults to port 3583, watches for file changes, and rebuilds + reloads on edits.
  - Instead of: combining \`flue build\` with \`wrangler dev\` (the previous workflow). \`flue dev --target cloudflare\` covers that case directly and stays in sync with what \`wrangler deploy\` will bundle.
- Important: \`flue run --target cloudflare\` is not supported.
  - Instead: \`flue run\` only supports \`--target node\`. To exercise a Cloudflare agent locally, use \`flue dev --target cloudflare\` and hit the endpoint with \`curl\`. For one-shot/scripted Cloudflare invocations, build with \`flue build --target cloudflare\` and call the deployed endpoint after \`wrangler deploy\`.
`;

export const GET: APIRoute = () => {
	return new Response(START_INSTRUCTIONS, {
		headers: {
			'Content-Type': 'text/markdown; charset=utf-8',
		},
	});
};
