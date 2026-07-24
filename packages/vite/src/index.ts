/**
 * `@flue/vite` — the Vite plugin that makes a Vite project a Flue app.
 *
 * ```ts
 * // vite.config.ts
 * import { defineConfig } from 'vite';
 * import { flue } from '@flue/vite';
 * export default defineConfig({ plugins: [flue()] });
 * ```
 *
 * See plans/2026-07-02-vite-plugin-explicit-routing-redesign.md. Targets:
 * Node (`flue()` alone) and Cloudflare (`flue()` before a sibling
 * `cloudflare({ config: flueWorkerConfig() })` from `@cloudflare/vite-plugin`).
 *
 * The `'use agent'` scanner (`scanAgents` and friends in `agent-scan.ts`) is
 * deliberately not public API: its only consumers are this plugin and the
 * package's own tests. A tooling-facing scan API can ship on purpose later.
 */
export type { AgentScanResult } from './agent-scan.ts';
export type { FlueWorkerConfigCustomizer } from './cloudflare-worker-config.ts';
export { flueWorkerConfig } from './cloudflare-worker-config.ts';
export type { FlueResolvedProjectInfo, FlueVitePluginApi } from './flue-plugin.ts';
export { flue } from './flue-plugin.ts';
