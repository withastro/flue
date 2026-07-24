/**
 * `vite preview` for the Node target.
 *
 * Preview is artifact-based: the built `dist/app.mjs` (the non-listening
 * application chunk `vite build` emits alongside the self-starting
 * `dist/server.mjs`) is imported natively — no Vite transformation — and its
 * fetch handler is mounted on the preview server's middleware stack. What
 * preview serves is therefore exactly what `node dist/server.mjs` would
 * serve, including production persistence defaults and the real process
 * environment (no `.env` loading — deployed environments own their
 * configuration).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getRequestListener } from '@hono/node-server';
import type { PreviewServer } from 'vite';
import type {
	LoadedFlueNodeApplication,
	LoadFlueNodeApplicationOptions,
} from './bootstrap/node-server.ts';
import { stackless } from './diagnostics.ts';

/** The application chunk `vite build` emits for artifact-based consumers. */
const BUILT_APP_BASENAME = 'app.mjs';

/**
 * Load the built application and return the post-internal middleware
 * installer (the same hook shape `configurePreviewServer` expects).
 */
export async function configureNodePreview(server: PreviewServer): Promise<() => void> {
	const outDir = path.resolve(server.config.root, server.config.build.outDir);
	const appPath = path.join(outDir, BUILT_APP_BASENAME);
	if (!fs.existsSync(appPath)) {
		const relative = path.relative(server.config.root, appPath);
		throw stackless(
			new Error(`[flue] No built application found at ${relative}. Run \`vite build\` first.`),
		);
	}
	const bootstrap = (await import(pathToFileURL(appPath).href)) as {
		loadFlueNodeApplication(
			options?: LoadFlueNodeApplicationOptions,
		): Promise<LoadedFlueNodeApplication>;
	};
	if (typeof bootstrap.loadFlueNodeApplication !== 'function') {
		throw stackless(
			new Error(
				`[flue] ${BUILT_APP_BASENAME} is not a Flue build artifact (missing loadFlueNodeApplication). ` +
					'Re-run `vite build` with the current @flue/vite version.',
			),
		);
	}
	const application = await bootstrap.loadFlueNodeApplication({ env: process.env });
	server.httpServer.once('close', () => {
		void application.stop().catch(() => undefined);
	});
	const listener = getRequestListener((request) => application.fetch(request));
	return () => {
		server.middlewares.use((req, res) => {
			void listener(req, res);
		});
	};
}
