interface MarkdownConversionResult {
	format: 'markdown' | 'error';
	data?: string;
	error?: string;
	tokens?: number;
}

interface Env {
	ASSETS: {
		fetch(request: Request): Promise<Response>;
	};
	AI: {
		toMarkdown(
			document: { name: string; blob: Blob },
			options?: { conversionOptions?: { html?: { hostname?: string; cssSelector?: string } } },
		): Promise<MarkdownConversionResult>;
	};
}

function isMarkdownRequest(request: Request, url: URL) {
	return (
		(request.method === 'GET' || request.method === 'HEAD') && url.pathname.endsWith('/index.md')
	);
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (!isMarkdownRequest(request, url)) {
			return env.ASSETS.fetch(request);
		}

		url.pathname = url.pathname.slice(0, -'index.md'.length);
		const page = await env.ASSETS.fetch(new Request(url));

		if (!page.ok) {
			return page;
		}

		const result = await env.AI.toMarkdown(
			{
				name: 'page.html',
				blob: new Blob([await page.arrayBuffer()], { type: 'text/html' }),
			},
			{
				conversionOptions: {
					html: {
						hostname: url.origin,
						cssSelector: '[data-markdown-content], [data-markdown-navigation]',
					},
				},
			},
		);

		if (result.format === 'error') {
			return new Response(result.error ?? 'Unable to convert page to Markdown.', { status: 502 });
		}

		const headers = new Headers({
			'Content-Type': 'text/markdown; charset=utf-8',
		});

		if (result.tokens !== undefined) {
			headers.set('X-Markdown-Tokens', result.tokens.toString());
		}

		return new Response(request.method === 'HEAD' ? null : result.data, { headers });
	},
};
