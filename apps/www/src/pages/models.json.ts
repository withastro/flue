import type { APIRoute } from "astro";

const modelsUrl = "https://unpkg.com/@mariozechner/pi-ai/dist/models.generated.js";

type ModelRegistry = Record<string, Record<string, unknown>>;

async function extractModelIds(source: string) {
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
  const { MODELS } = (await import(moduleUrl)) as { MODELS?: ModelRegistry };

  if (!MODELS) {
    throw new Error(`No MODELS export found in ${modelsUrl}`);
  }

  const ids: string[] = [];

  for (const [provider, models] of Object.entries(MODELS)) {
    for (const modelId of Object.keys(models)) {
      ids.push(`${provider}/${modelId}`);
    }
  }

  return ids;
}

export const GET: APIRoute = async () => {
  const response = await fetch(modelsUrl);

  if (!response.ok) {
    throw new Error(`Failed to fetch model list from ${modelsUrl}: ${response.status} ${response.statusText}`);
  }

  const modelIds = await extractModelIds(await response.text());

  if (modelIds.length === 0) {
    throw new Error(`No model IDs found in ${modelsUrl}`);
  }

  return new Response(JSON.stringify(modelIds, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
  });
};
