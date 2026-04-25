import type { APIRoute } from "astro";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const docsDir = join(repoRoot, "docs");
const rawDocsUrl = "https://raw.githubusercontent.com/withastro/flue/refs/heads/main/docs";

async function getDeployGuideList() {
  const files = (await readdir(docsDir)).filter((file) => file.startsWith("deploy-") && file.endsWith(".md")).sort();

  const guides = await Promise.all(
    files.map(async (file) => {
      const contents = await readFile(join(docsDir, file), "utf-8");
      const title = contents.match(/^#\s+(.+)$/m)?.[1] ?? file;

      return `   - ${title}: ${rawDocsUrl}/${file}`;
    }),
  );

  return guides.join("\n");
}

const START_INSTRUCTIONS = `# Skill: Create a New Flue Agent

You are helping the user create a new Flue agent.

## Step 1: Context

First, fetch and read the Flue README:

https://raw.githubusercontent.com/withastro/flue/refs/heads/main/README.md

Use the README as the source of truth for how Flue works.

## Step 2: Discover Requirements

Then, determine the following (ask the user if you don't already have the answer from other context):

1. In a simple sentence, what should the agent do? 
   - You will use this to create a simple hello world that is in the theme of what they are building.
   - Suggestion: You can suggest a simple "hello world" as the default, if they don't have an idea in mind.
2. Where should the project live on disk?
   - You will use this to create the project in this directory.
   - Suggestion: the current directory. If the current directory has files, use the \`.flue\` subdirectory feature (see README)
3. Where should it deploy? For example: Cloudflare, Node.js, GitHub Actions, Vercel, Fly.io.
   - Available deploy guides:
${await getDeployGuideList()}
4. (Skip if Cloudflare) Do you have a sandbox provider in mind? 
   - Optional! For most users, a good starter project should use the built-in, default virtual sandbox.
   - However, sometimes a user will already have a specific sandbox provider that they are trying integrate, so it is good to ask.
5. Do you have an LLM provider/model in mind? 
   - Optional, but recommended! Flue really only makes sense with an LLM. Setup is easier if you know which LLM provider the user is planning to use, so that you can scaffold out a good default model identifier, the ENV keys needed to talk to that API, etc.
   - Suggestion: Whatever model/provider you are, if you can tell from this conversation. Otherwise, Anthropic is a common default choice.

## Step 3: Build the Smallest Useful Starter Project

1. Pick the deploy guide that best matches the user's target, fetch it, and follow it.
2. Create or update the project in the requested location.
3. Scaffold one minimal Flue agent that matches the user's idea. Keep it closer to "hello world" than production app.
4. Add only the dependencies and config required by the selected deploy guide.
5. Fetch https://flueframework.com/models.json and use one of its exact model identifiers for the LLM provider/model. Do not guess model IDs.
6. Run the most relevant validation command you can, such as build, typecheck, or a local Flue run. If you cannot run it, explain why.
7. Finish with the exact next commands the user should run, including how to set any required secrets.

## Important Instructions and Constraints to be Successful

- Important: Never guess at model IDs! Your training data is likely out of date, and the models you're familiar with are no longer hosted, causing "404 not found" issues.
  - Instead: Fetch https://flueframework.com/models.json and choose an exact model ID from that array.
- Important: Never invent API keys or secrets.
  - Instead: You can scaffold out obvious placeholders, but always ask the user to provide the API secrets/keys/tokens themselves. You can still help the user by showing them the command to run to set the secret, based on their local dev setup and chosen host.

`;

export const GET: APIRoute = () => {
  return new Response(START_INSTRUCTIONS, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
    },
  });
};
