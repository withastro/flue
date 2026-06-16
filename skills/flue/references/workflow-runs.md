# Workflow Runs

Use this when implementing finite units of work, inspecting runs, or choosing between workflow and agent semantics.

## Workflow Shape

```ts
import { createAgent, type FlueContext } from '@flue/runtime';

const summarizer = createAgent(() => ({
  model: 'anthropic/claude-haiku-4-5',
  instructions: 'Summarize the supplied document.',
}));

export async function run({ init, payload }: FlueContext<{ text: string }>) {
  const harness = await init(summarizer);
  const session = await harness.session();
  const response = await session.prompt(payload.text);

  return { summary: response.text };
}
```

- Filename gives the workflow name.
- Each invocation creates one workflow run with `ctx.id === runId`.
- Return value becomes the completed workflow result.
- Use `init(agent)` and session operations for model-backed work so events, tools, skills, sandbox, and model resolution are preserved.

## Invocation Surfaces

| Surface | Use |
| --- | --- |
| `flue run <workflow>` | Local or CI one-shot execution. |
| `POST /workflows/<name>` | HTTP admission when workflow exports `route`. |
| `?wait=result` | Wait for completed HTTP result in the request. |
| `flue logs <runId>` | Inspect or follow a workflow run. |
| `GET /runs/<runId>` | Stream run events. |
| `GET /runs/<runId>?meta` | Read run record metadata. |

Do not import a workflow module and call `run(...)` directly from `app.ts`, `cloudflare.ts`, a scheduler, or a queue handler when you need a real run. Invoke the mounted workflow route or extract shared pure logic.

## Run Boundaries

- Only workflows create workflow runs.
- Direct prompts and `dispatch(...)` input are continuing agent operations.
- Run listing can expose payloads, results, logs, and model activity; protect run routes.
- Per-workflow route middleware protects that workflow's run views.
- Shared `/runs/*` middleware in `app.ts` can protect every run.

## Recovery Notes

| Target | Behavior |
| --- | --- |
| Node without durable `db.ts` | In-memory state is lost on process exit. |
| Node with durable adapter | Accepted agent submissions can reconcile after restart; interrupted workflow runs may remain active and streams open. |
| Cloudflare | Durable Objects and Fiber recovery handle admitted work more conservatively and can terminalize interrupted runs. |

