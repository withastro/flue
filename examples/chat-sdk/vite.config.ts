import { flue } from '@flue/vite';
import { defineConfig } from 'vite';

// Node target (auto-detected: no @cloudflare/vite-plugin sibling).
// The Chat SDK fake GitHub API defaults to http://localhost:3585, so the dev
// server pins that port; the built server does the same via PORT=3585.
export default defineConfig({
	plugins: [flue()],
	server: { port: 3585, strictPort: true },
});
