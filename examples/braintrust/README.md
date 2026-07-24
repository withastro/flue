# Braintrust tracing for Flue

This example registers Braintrust's public Flue observer against Flue's public `observe(...)` event stream.

## What it demonstrates

- One observer integration traces prompt and skill operations, model turns, tools, delegated tasks, and compactions.
- Model spans include content, errors, token usage, and estimated cost where available.
- Flue correlation fields connect agent activity to Braintrust traces.
- The application continues without trace export when `BRAINTRUST_API_KEY` is absent.

The integration lives in [`src/app.ts`](src/app.ts). Agents do not import Braintrust.

## Integration

The example pins Braintrust 3.17 and registers only the lifecycle events its Flue observer consumes:

```ts
import { type FlueObservation, observe } from '@flue/runtime';
import { braintrustFlueObserver, initLogger } from 'braintrust';

const apiKey = process.env.BRAINTRUST_API_KEY;

if (apiKey) {
  initLogger({
    projectName: process.env.BRAINTRUST_PROJECT_NAME ?? 'Flue',
    apiKey,
  });

  observe((event, ctx) => {
    const compatible = compatibleEvent(event);
    if (compatible) braintrustFlueObserver(compatible, ctx);
  });
}

function compatibleEvent(event: FlueObservation): unknown {
  if (event.type === 'tool') return { ...event, type: 'tool_call' };
  if (
    event.type === 'operation_start' ||
    event.type === 'operation' ||
    event.type === 'turn_request' ||
    event.type === 'turn' ||
    event.type === 'tool_start' ||
    event.type === 'task_start' ||
    event.type === 'task' ||
    event.type === 'compaction_start' ||
    event.type === 'compaction'
  ) {
    return event;
  }
  return undefined;
}
```

Braintrust 3.17 expects `tool_call` for a terminal tool event; every other consumed event passes through with its current public shape. The observer was written while Flue still had workflow runs, so its workflow-specific handling (`run_start`/`run_end`) is simply never exercised here — persistent-agent activity is correlated by operation, instance, session, and optional dispatch fields instead.

## Trace shape

For a tool-using agent turn, the generated structure is:

```text
flue.prompt
  llm:<model>
  tool:lookup_weather
  llm:<model>
```

| Flue activity                          | Braintrust representation |
| -------------------------------------- | ------------------------- |
| Prompt, skill, or compaction operation | `task` span               |
| Model turn                             | Nested `llm` span         |
| Tool call                              | Nested `tool` span        |
| Delegated task                         | Nested `task` span        |
| Context compaction                     | Nested compaction span    |

## Sensitive content

Braintrust's observer is content-bearing. It can export model messages and output, reasoning, system prompts, tool definitions and values, task content, errors, and correlation metadata. Use Braintrust's masking support and review retention and access requirements before enabling it for sensitive workloads. See the [Braintrust ecosystem guide](https://flueframework.com/docs/ecosystem/tooling/braintrust/).

## Running it

From the repository root, install workspace dependencies:

```bash
pnpm install
```

Set credentials for Braintrust trace export and Anthropic model calls:

```bash
export BRAINTRUST_API_KEY='<braintrust-api-key>'
export BRAINTRUST_PROJECT_NAME='Flue'
export ANTHROPIC_API_KEY='<anthropic-api-key>'
```

From this example directory, start the Node dev server:

```bash
pnpm exec vite dev
```

Vite prints the local URL it serves (`http://localhost:5173` by default — substitute yours below). Agent prompts are fire-and-forget: `POST` returns a `202` admission, and a `GET` of the same URL streams the conversation. Trigger each example agent:

```bash
curl -X POST 'http://localhost:5173/agents/prompt/demo-1' \
  -H 'content-type: application/json' \
  -d '{"kind":"user","body":"Welcome a developer named Ada."}'

curl -X POST 'http://localhost:5173/agents/tools/demo-1' \
  -H 'content-type: application/json' \
  -d '{"kind":"user","body":"What is the weather in San Francisco?"}'

curl -X POST 'http://localhost:5173/agents/task/demo-1' \
  -H 'content-type: application/json' \
  -d '{"kind":"user","body":"Rewrite this sentence: We are leveraging synergies to move faster."}'
```

Run the compatibility checks with:

```bash
pnpm run check:types
pnpm run build
```
