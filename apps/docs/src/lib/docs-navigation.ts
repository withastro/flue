export interface DocsNavItem {
	title: string;
	slug: string;
}

export interface DocsNavGroup {
	title: string;
	items: DocsNavItem[];
}

export interface DocsSection {
	key: 'guide' | 'api' | 'cli' | 'sdk' | 'ecosystem';
	title: string;
	landingSlug: string;
	groups: DocsNavGroup[];
}

export const docsSections: DocsSection[] = [
	{
		key: 'guide',
		title: 'Guide',
		landingSlug: 'getting-started/quickstart',
		groups: [
			{
				title: 'Introduction',
				items: [
					{ title: 'Getting Started', slug: 'getting-started/quickstart' },
					{ title: 'Agents', slug: 'concepts/agents' },
					{ title: 'Workflows', slug: 'guide/workflows' },
					{ title: 'Why Flue?', slug: 'introduction/why-flue' },
				],
			},
			{
				title: 'Guides',
				items: [
					{ title: 'Project Layout', slug: 'guide/project-layout' },
					{ title: 'Configuration', slug: 'guide/configuration' },
					{ title: 'LLMs & Models', slug: 'guide/models' },
					{ title: 'Harness', slug: 'guide/harness' },
					{ title: 'Prompting', slug: 'guide/prompting' },
					{ title: 'Skills', slug: 'guide/skills' },
					{ title: 'Tools', slug: 'guide/tools' },
					{ title: 'Subagents', slug: 'guide/subagents' },
					{ title: 'Sandboxes', slug: 'guide/sandboxes' },
					{ title: 'Routing', slug: 'guide/routing' },
					{ title: 'Chat', slug: 'guide/chat' },
					{ title: 'Observability', slug: 'guide/observability' },
				],
			},
			{
				title: 'Deploy',
				items: [
					{ title: 'Cloudflare', slug: 'deploy/cloudflare' },
					{ title: 'GitHub Actions', slug: 'deploy/github-actions' },
					{ title: 'GitLab CI/CD', slug: 'deploy/gitlab-ci' },
					{ title: 'Node.js', slug: 'deploy/node' },
					{ title: 'Render', slug: 'deploy/render' },
				],
			},
		],
	},
	{
		key: 'api',
		title: 'API',
		landingSlug: 'api/agent-api',
		groups: [
			{
				title: 'Runtime',
				items: [
					{ title: 'Agent API', slug: 'api/agent-api' },
					{ title: 'Workflows API', slug: 'api/workflows-api' },
					{ title: 'Harness API', slug: 'api/harness-api' },
					{ title: 'Channels API', slug: 'api/channels-api' },
					{ title: 'Sandbox API', slug: 'api/sandbox-api' },
					{ title: 'Data Persistence API', slug: 'api/data-persistence-api' },
					{ title: 'Events Reference', slug: 'api/events-reference' },
					{ title: 'Tools Reference', slug: 'api/tools-reference' },
					{ title: 'MCP Reference', slug: 'api/mcp-reference' },
					{ title: 'Skills Reference', slug: 'api/skills-reference' },
					{ title: 'Subagents Reference', slug: 'api/subagents-reference' },
				],
			},
			{
				title: 'Routing',
				items: [{ title: 'Application API', slug: 'api/application-api' }],
			},
			{
				title: 'Platforms',
				items: [
					{ title: 'Node.js', slug: 'api/nodejs' },
					{ title: 'Cloudflare', slug: 'api/cloudflare' },
				],
			},
		],
	},
	{
		key: 'cli',
		title: 'CLI',
		landingSlug: 'cli/overview',
		groups: [
			{
				title: 'CLI',
				items: [
					{ title: 'Overview', slug: 'cli/overview' },
					{ title: 'init', slug: 'cli/init' },
					{ title: 'dev', slug: 'cli/dev' },
					{ title: 'run', slug: 'cli/run' },
					{ title: 'build', slug: 'cli/build' },
					{ title: 'logs', slug: 'cli/logs' },
					{ title: 'add', slug: 'cli/add' },
				],
			},
		],
	},
	{
		key: 'sdk',
		title: 'SDK',
		landingSlug: 'sdk/overview',
		groups: [
			{
				title: 'Introduction',
				items: [{ title: 'Overview', slug: 'sdk/overview' }],
			},
			{
				title: 'Client',
				items: [
					{ title: 'createFlueClient()', slug: 'sdk/create-flue-client' },
					{ title: 'client.agents.invoke()', slug: 'sdk/client-agents-invoke' },
					{ title: 'client.agents.connect()', slug: 'sdk/client-agents-connect' },
					{ title: 'client.workflows.connect()', slug: 'sdk/client-workflows-connect' },
					{ title: 'client.runs.get()', slug: 'sdk/client-runs-get' },
					{ title: 'client.runs.events()', slug: 'sdk/client-runs-events' },
					{ title: 'client.runs.stream()', slug: 'sdk/client-runs-stream' },
				],
			},
			{
				title: 'Admin',
				items: [
					{ title: 'client.admin.agents.list()', slug: 'sdk/client-admin-agents-list' },
					{ title: 'client.admin.runs.list()', slug: 'sdk/client-admin-runs-list' },
					{ title: 'client.admin.runs.get()', slug: 'sdk/client-admin-runs-get' },
				],
			},
			{
				title: 'Reference',
				items: [
					{ title: 'WebSocket Types', slug: 'sdk/websocket-types' },
					{ title: 'Event Types', slug: 'sdk/event-types' },
					{ title: 'Error Types', slug: 'sdk/error-types' },
				],
			},
		],
	},
	{
		key: 'ecosystem',
		title: 'Ecosystem',
		landingSlug: 'ecosystem/overview',
		groups: [
			{
				title: 'Ecosystem',
				items: [
					{ title: 'Overview', slug: 'ecosystem/overview' },
					{ title: 'Connectors', slug: 'ecosystem/connectors' },
				],
			},
			{
				title: 'Deployment',
				items: [{ title: 'Targets', slug: 'ecosystem/targets' }],
			},
		],
	},
];

export function docsHref(slug: string) {
	return `/${slug}/`;
}

export function getDocsSection(slug: string) {
	return docsSections.find((section) => section.groups.some((group) => group.items.some((item) => item.slug === slug))) ?? docsSections[0];
}

