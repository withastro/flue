/**
 * `app.ts` — the application's route map, and the only required file.
 *
 * The default export owns the entire request pipeline via
 * `.fetch(request, env, ctx)`. The same `app.ts` shape works on both Node and
 * Cloudflare targets; `flue()` adapts internally. On Cloudflare each mounted
 * agent route resolves the generated binding and forwards to that agent's
 * Durable Object via the Agents SDK; everything else is just a Hono app.
 *
 * Every route is mounted explicitly: `createAgentRouter(Fn)` is a pure
 * router factory over an agent function exported from a module marked with
 * the `'use agent'` directive (the scan of marked modules — not the mount —
 * is what registers the agent, so a dispatch-only agent needs no mount at
 * all).
 */
import { createAgentRouter } from '@flue/runtime/routing';
import { Hono } from 'hono';
import { SkillsFromGit } from './agents/skills-from-git';
import { SkillsFromR2 } from './agents/skills-from-r2';
import { WithCloudflareBinding } from './agents/with-cloudflare-binding';

// ─── Cloudflare AI Gateway (optional) ───────────────────────────────────────
// By default, every `cloudflare/...` model call is routed through
// Cloudflare's default AI Gateway, which the binding spins up on demand
// for your account. To customize the gateway (e.g. point at a named
// gateway, override caching, attach metadata) — or to opt out entirely —
// register `cloudflare` yourself. Your registration wins because user
// `app.ts` imports run before the auto-registration (ESM hoisting).
//
//   import { setProvider } from '@flue/runtime';
//   import { cloudflareBindingProvider } from '@flue/runtime/cloudflare/workers-ai';
//   import { env } from 'cloudflare:workers';
//
//   // Custom gateway with cache + metadata.
//   setProvider(cloudflareBindingProvider({
//     binding: env.AI,
//     gateway: {
//       id: 'my-gateway',
//       cacheTtl: 3360,
//       metadata: { tenant: 'acme' },
//     },
//   }));
//
//   // Opt out of the gateway entirely.
//   setProvider(cloudflareBindingProvider({ binding: env.AI, gateway: false }));
//
// Docs: https://developers.cloudflare.com/ai-gateway/integrations/worker-binding-methods/

const app = new Hono();

// Custom route — runs in the worker isolate, NOT inside an agent's
// Durable Object. Useful for liveness probes, status pages, or any
// endpoint that doesn't need agent state / streaming.
app.get('/api/ping', (c) => c.json({ pong: true, at: new Date().toISOString() }));

// Each agent's HTTP surface, mounted explicitly. Relative to the mount:
//   POST /:id            prompt (202 admission)
//   GET|HEAD /:id        conversation stream
//   POST /:id/abort      abort in-flight work
// The mount path is yours to choose; the agent function's name (its durable
// identity) is what keys conversations and the Durable Object class.
app.route('/agents/with-cloudflare-binding', createAgentRouter(WithCloudflareBinding));
app.route('/agents/skills-from-git', createAgentRouter(SkillsFromGit));
app.route('/agents/skills-from-r2', createAgentRouter(SkillsFromR2));

export default app;
