const githubApiUrlKey = 'github-api-url';
const outboundCommentsKey = 'outbound-comments';

type OutboundComment = {
	body: string;
	issueNumber: number;
};

export class ChatSdkExampleTestSupport {
	constructor(private readonly storage: DurableObjectStorage) {}

	async githubApiUrlFor(request: Request, configured?: string): Promise<string> {
		if (configured) {
			return configured;
		}
		const url = new URL(request.url);
		if (url.hostname === 'chat-ingress.local') {
			const stored = await this.storage.get<string>(githubApiUrlKey);
			if (stored) {
				return stored;
			}
		}
		const apiUrl = new URL('/api/github', request.url).toString();
		await this.storage.put(githubApiUrlKey, apiUrl);
		return apiUrl;
	}

	async handle(request: Request, url: URL): Promise<Response | undefined> {
		if (request.method === 'GET' && url.pathname === '/test/outbound-comments') {
			return Response.json(await this.readOutboundComments());
		}
		const issueNumber = getIssueNumber(url);
		if (request.method !== 'POST' || issueNumber === undefined) {
			return undefined;
		}
		const payload = await request.json<{ body?: string }>();
		const body = typeof payload.body === 'string' ? payload.body : '';
		const comments = await this.readOutboundComments();
		comments.push({ issueNumber: Number(issueNumber), body });
		await this.storage.put(outboundCommentsKey, comments);
		return Response.json({
			id: comments.length,
			body,
			user: { id: 1, login: 'flue-bot', type: 'Bot' },
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
		});
	}

	private async readOutboundComments(): Promise<Array<OutboundComment>> {
		return (await this.storage.get<Array<OutboundComment>>(outboundCommentsKey)) ?? [];
	}
}

function getIssueNumber(url: URL): string | undefined {
	return /^\/api\/github\/repos\/[^/]+\/[^/]+\/issues\/([^/]+)\/comments$/.exec(url.pathname)?.[1];
}
