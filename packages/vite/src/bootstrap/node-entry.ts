/**
 * The self-starting production entry for the Node target. `vite build` uses
 * this module as the SSR input, producing `dist/server.mjs`: it starts the
 * bootstrap's server on PORT (default 3000) and shuts down gracefully on
 * SIGINT/SIGTERM/disconnect.
 */
import { startFlueNodeServer } from 'virtual:flue/server';

const lifecycle = await startFlueNodeServer({
	port: Number.parseInt(process.env.PORT || '3000', 10),
});

async function stop(exitCode: number) {
	setTimeout(() => {
		console.error('[flue] Shutdown timed out, exiting.');
		process.exit(exitCode);
	}, 60_000).unref();
	await lifecycle.stop();
	process.exit(exitCode);
}

process.on('SIGINT', () => {
	void stop(130);
});
process.on('SIGTERM', () => {
	void stop(143);
});
process.on('disconnect', () => {
	void stop(0);
});
