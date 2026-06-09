import { defineConfig } from 'vite-plus';

export default defineConfig({
	run: {
		tasks: {
			'test:live': {
				command: 'node ./test/live-websocket.mjs',
				cache: false,
			},
		},
	},
});
