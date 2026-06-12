export type DocsNavItem =
	| {
			title: string;
			slug: string;
			anchor?: string;
			items?: DocsNavItem[];
	  }
	| {
			title: string;
			href: string;
	  };

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
					{ title: 'What is an agent?', slug: 'concepts/agents' },
					{ title: 'Why Flue?', slug: 'introduction/why-flue' },
					{ title: 'Changelog', href: 'https://github.com/withastro/flue/blob/main/CHANGELOG.md' },
				],
			},
			{
				title: 'Guides',
				items: [
					{ title: 'Project Layout', slug: 'guide/project-layout' },
					{ title: 'Models & Providers', slug: 'guide/models' },
					{ title: 'Agents', slug: 'guide/building-agents' },
					{ title: 'Workflows', slug: 'guide/workflows' },
					{ title: 'Scheduling', slug: 'guide/scheduling' },
					{ title: 'Durable Execution', slug: 'guide/durable-execution' },
					{ title: 'Database', slug: 'guide/database' },
					{ title: 'Skills', slug: 'guide/skills' },
					{ title: 'Tools', slug: 'guide/tools' },
					{ title: 'Subagents', slug: 'guide/subagents' },
					{ title: 'Sandboxes', slug: 'guide/sandboxes' },
					{ title: 'Routing', slug: 'guide/routing' },
					{ title: 'Develop & Build', slug: 'guide/develop-and-build' },
					{ title: 'Chat', slug: 'guide/chat' },
					{ title: 'Observability', slug: 'guide/observability' },
				],
			},
			{
				title: 'Targets',
				items: [
					{ title: 'Node.js', slug: 'guide/targets/node' },
					{ title: 'Cloudflare', slug: 'guide/targets/cloudflare' },
				],
			},
		],
	},
	{
		key: 'api',
		title: 'Reference',
		landingSlug: 'api/agent-api',
		groups: [
			{
				title: 'Runtime',
				items: [
					{ title: 'Configuration', slug: 'reference/configuration' },
					{ title: 'Errors Reference', slug: 'api/errors-reference' },
					{ title: 'Agent API', slug: 'api/agent-api' },
					{ title: 'Provider API', slug: 'api/provider-api' },
					{ title: 'Routing API', slug: 'api/routing-api' },
					{ title: 'Streaming Protocol', slug: 'api/streaming-protocol' },
					{ title: 'Events Reference', slug: 'api/events-reference' },
				],
			},
			{
				title: 'Advanced',
				items: [
					{ title: 'Sandbox Connector API', slug: 'api/sandbox-api' },
					{ title: 'Data Persistence API', slug: 'api/data-persistence-api' },
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
					{ title: 'connect', slug: 'cli/connect' },
					{ title: 'run', slug: 'cli/run' },
					{ title: 'build', slug: 'cli/build' },
					{ title: 'logs', slug: 'cli/logs' },
					{ title: 'add', slug: 'cli/add' },
					{ title: 'docs', slug: 'cli/docs' },
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
				title: 'SDK',
				items: [
					{ title: 'Overview', slug: 'sdk/overview' },
					{
						title: 'createFlueClient(...)',
						slug: 'sdk/client',
						items: [
							{
								title: 'CreateFlueClientOptions',
								slug: 'sdk/client',
								anchor: 'createflueclientoptions',
							},
							{ title: 'RequestHeaders', slug: 'sdk/client', anchor: 'requestheaders' },
						],
					},
					{
						title: 'client.agents',
						slug: 'sdk/agents',
						items: [
							{ title: 'prompt(...)', slug: 'sdk/agents', anchor: 'clientagentsprompt' },
							{ title: 'send(...)', slug: 'sdk/agents', anchor: 'clientagentssend' },
							{ title: 'stream(...)', slug: 'sdk/agents', anchor: 'clientagentsstream' },
						],
					},
					{
						title: 'client.workflows',
						slug: 'sdk/workflows',
						items: [
							{ title: 'invoke(...)', slug: 'sdk/workflows', anchor: 'clientworkflowsinvoke' },
						],
					},
					{
						title: 'client.runs',
						slug: 'sdk/runs',
						items: [
							{ title: 'get(...)', slug: 'sdk/runs', anchor: 'clientrunsget' },
							{ title: 'events(...)', slug: 'sdk/runs', anchor: 'clientrunsevents' },
							{ title: 'stream(...)', slug: 'sdk/runs', anchor: 'clientrunsstream' },
						],
					},
					{
						title: 'client.admin',
						slug: 'sdk/admin',
						items: [
							{ title: 'agents.list()', slug: 'sdk/admin', anchor: 'clientadminagentslist' },
							{ title: 'runs.list(...)', slug: 'sdk/admin', anchor: 'clientadminrunslist' },
							{ title: 'runs.get(...)', slug: 'sdk/admin', anchor: 'clientadminrunsget' },
						],
					},
					{ title: 'Events and records', slug: 'sdk/events' },
				{ title: 'Errors', slug: 'sdk/errors' },
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
				items: [{ title: 'Overview', slug: 'ecosystem/overview' }],
			},
			{
				title: 'Deployment',
				items: [
					{ title: 'Cloudflare', slug: 'ecosystem/deploy/cloudflare' },
					{ title: 'GitHub Actions', slug: 'ecosystem/deploy/github-actions' },
					{ title: 'GitLab CI/CD', slug: 'ecosystem/deploy/gitlab-ci' },
					{ title: 'Node.js', slug: 'ecosystem/deploy/node' },
					{ title: 'Render', slug: 'ecosystem/deploy/render' },
				],
			},
			{
				title: 'Sandboxes',
				items: [
					{ title: 'boxd', slug: 'ecosystem/sandboxes/boxd' },
					{ title: 'Cloudflare Shell', slug: 'ecosystem/sandboxes/cloudflare-shell' },
					{ title: 'Cloudflare Sandbox', slug: 'ecosystem/sandboxes/cloudflare' },
					{ title: 'Daytona', slug: 'ecosystem/sandboxes/daytona' },
					{ title: 'E2B', slug: 'ecosystem/sandboxes/e2b' },
					{ title: 'exe.dev', slug: 'ecosystem/sandboxes/exedev' },
					{ title: 'islo', slug: 'ecosystem/sandboxes/islo' },
					{ title: 'Mirage', slug: 'ecosystem/sandboxes/mirage' },
					{ title: 'Modal', slug: 'ecosystem/sandboxes/modal' },
					{ title: 'smolvm', slug: 'ecosystem/sandboxes/smolvm' },
					{ title: 'Superserve', slug: 'ecosystem/sandboxes/superserve' },
					{ title: 'Vercel Sandbox', slug: 'ecosystem/sandboxes/vercel' },
				],
			},
		],
	},
];

export function docsHref(slug: string, anchor?: string) {
	return `${import.meta.env.BASE_URL}${slug}/${anchor ? `#${anchor}` : ''}`;
}

function includesSlug(items: DocsNavItem[], slug: string): boolean {
	return items.some(
		(item) =>
			'slug' in item &&
			(item.slug === slug || (item.items !== undefined && includesSlug(item.items, slug))),
	);
}

export function getDocsSection(slug: string) {
	return (
		docsSections.find((section) =>
			section.groups.some((group) => includesSlug(group.items, slug)),
		) ?? docsSections[0]
	);
}
