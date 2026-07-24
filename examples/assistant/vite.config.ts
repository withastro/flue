import { cloudflare } from '@cloudflare/vite-plugin';
import { flue, flueWorkerConfig } from '@flue/vite';
import { defineConfig } from 'vite';

// flue() must precede cloudflare(): the Cloudflare plugin invokes
// flueWorkerConfig() — contributing the generated Worker entry and per-agent
// Durable Object bindings — after flue() has scanned the project.
export default defineConfig({
	plugins: [flue(), cloudflare({ config: flueWorkerConfig() })],
});
