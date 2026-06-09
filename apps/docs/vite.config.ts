import { defineConfig } from 'vite-plus';

export default defineConfig({
	run: {
		tasks: {
			dev: {
				command: 'astro dev',
				cache: false,
			},
			build: {
				command: [
					'rm -rf ./dist',
					'astro build',
					'mv ./dist/docs/_redirects ./dist/_redirects',
					'pagefind --site ./dist/docs',
				],
				output: ['dist/**'],
			},
			preview: {
				command: 'astro preview',
				cache: false,
			},
			deploy: {
				command: ['vp run build', 'vp exec wrangler deploy'],
				cache: false,
			},
			astro: {
				command: 'astro',
				cache: false,
			},
			'check:types': 'astro check',
		},
	},
});
