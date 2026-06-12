# Vitest Evals for Flue

A small black-box eval example for a Flue app. It exposes one workflow and one agent, then evaluates the HTTP routes a deployed app would actually ship.

## Run it

Install workspace dependencies from the repository root:

```bash
pnpm install
```

Set the provider key for your selected model. By default this example uses `openai/gpt-5.5`:

```bash
export OPENAI_API_KEY='<openai-api-key>'
```

Start Flue in one terminal:

```bash
pnpm --dir examples/evals run dev
```

Run evals from another terminal:

```bash
pnpm --dir examples/evals run evals
```

Emit JSON for CI or the Vitest Evals report UI:

```bash
pnpm --dir examples/evals run evals:json
```

Set `FLUE_EVAL_MODEL` before starting `flue dev` to use another Flue model string. Set `FLUE_EVAL_BASE_URL` before running evals if Flue is mounted somewhere other than `http://localhost:3583`.
