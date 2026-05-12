import { defineConfig } from '@flue/cli/config';

/**
 * `flue.config.ts` is the build-time config surface — it sets `target`,
 * `root`, `output`, and other build-shaped knobs. Provider/model
 * registration intentionally does NOT live here: those are runtime
 * concerns (an apiKey often comes from `process.env` or a Cloudflare
 * binding), so they live in `app.ts` via `registerProvider(...)`.
 *
 * `target` is intentionally left unset here so existing `--target node`
 * invocations in this example keep working unchanged.
 */
export default defineConfig({});
