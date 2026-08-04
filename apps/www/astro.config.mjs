// @ts-check

import mdx from '@astrojs/mdx';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
	site: 'https://flueframework.com',
	output: 'static',
	integrations: [mdx()],
	markdown: {
		shikiConfig: {
			defaultColor: 'light-dark()',
			themes: {
				dark: 'github-dark',
				light: 'github-light',
			},
		},
	},
	vite: {
		plugins: tailwindcss(),
	},
});
