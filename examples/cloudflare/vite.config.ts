import { cloudflare } from '@cloudflare/vite-plugin';
import { flue, flueWorkerConfig } from '@flue/vite';
import { defineConfig } from 'vite';

// flue() must come before cloudflare(): the Cloudflare plugin invokes
// flueWorkerConfig() — Flue's worker-config customizer, contributing the
// generated Worker entry (`main`) and per-agent Durable Object bindings —
// while Vite resolves this config, after flue() has scanned the project.
// The target is auto-detected from the presence of cloudflare() in the
// plugin array.
export default defineConfig({
	plugins: [flue(), cloudflare({ config: flueWorkerConfig() })],
});
