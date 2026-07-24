// The Flue server config (default `vite dev` / `vite build`). The React UI
// has its own plain Vite config (vite.config.ui.ts) building into
// dist/client; app.ts serves those static assets and mounts the agents
// under /api. Build order matters: the server build empties dist/, so run
// it BEFORE the UI build (see the package.json scripts).
import { flue } from '@flue/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [flue()],
});
