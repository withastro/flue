import mdx from '@astrojs/mdx';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'astro/config';

export default defineConfig({
	site: 'https://flueframework.com',
	base: '/docs',
	trailingSlash: 'always',
	outDir: './dist/docs',
	output: 'static',
	integrations: [mdx()],
	markdown: {
		shikiConfig: {
			theme: 'github-light',
			transformers: [
				{
					name: 'code-block-title',
					root(root) {
						const title = this.options.meta?.__raw?.match(/title="([^"]+)"/)?.[1];
						if (!title) return;
						const pre = root.children[0];
						root.children = [
							{
								type: 'element',
								tagName: 'figure',
								properties: { className: ['astro-code-figure'] },
								children: [
									{
										type: 'element',
										tagName: 'figcaption',
										properties: { className: ['astro-code-title'] },
										children: [
											{
												type: 'element',
												tagName: 'svg',
												properties: {
													viewBox: '0 0 24 24',
													fill: 'none',
													stroke: 'currentColor',
													strokeWidth: '2',
													strokeLinecap: 'round',
													strokeLinejoin: 'round',
													ariaHidden: 'true',
												},
												children: [
													{
														type: 'element',
														tagName: 'path',
														properties: {
															d: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z',
														},
														children: [],
													},
													{
														type: 'element',
														tagName: 'polyline',
														properties: { points: '14 2 14 8 20 8' },
														children: [],
													},
												],
											},
											{
												type: 'element',
												tagName: 'span',
												properties: {},
												children: [{ type: 'text', value: title }],
											},
										],
									},
									pre,
								],
							},
						];
					},
				},
			],
		},
	},
	vite: {
		plugins: tailwindcss(),
	},
});
