# React chat example

A Flue server plus a React UI driven by `@flue/react` hooks. Exercises the
offline scripted `assistant` agent, the real-model `helper` agent
(`ANTHROPIC_API_KEY` required), and a `demo` agent whose deterministic
background job is a model-callable action (formerly a workflow).

## Vite arrangement (two configs)

The server and the UI are two separate Vite builds:

- `vite.config.ts` — the Flue server (`flue()` plugin). Default config, so
  plain `vite dev` / `vite build` drive it. Emits `dist/server.mjs`.
- `vite.config.ui.ts` — the plain React SPA build. Emits static assets into
  `dist/client`, which `src/app.ts` serves with `serveStatic` while mounting
  the agents under `/api`. The UI addresses each conversation by URL —
  `useFlueAgent({ url: '/api/agents/assistant/<id>' })` — the mount path
  app.ts chose plus a caller-chosen conversation id.

Build order matters: the server build empties `dist/`, so it runs first and
the UI build lands in `dist/client` afterwards (see the `build` script).

## Commands

```sh
pnpm run dev        # builds the UI once, then vite dev for the server
pnpm run build      # server build, then UI build (dist/server.mjs + dist/client)
node dist/server.mjs   # run the production build from this directory
```

In dev, the UI is served prebuilt — re-run `pnpm run build:ui` (or keep
`vite build --watch --config vite.config.ui.ts` running) after UI edits;
server/agent edits hot-reload through `vite dev` as usual.
