import { defineConfig } from '@flue/cli/config';

/**
 * `flue.config.ts` is the build-time config surface — it sets `target`,
 * `root`, `output`, and the built-in provider transports included in the
 * artifact. Runtime provider registration remains in `app.ts` because API
 * keys and bindings often come from the environment.
 *
 * `target` is intentionally left unset here so existing `--target node`
 * invocations in this example keep working unchanged.
 */
export default defineConfig({ providers: ['anthropic', 'openai'] });
