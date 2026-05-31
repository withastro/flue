export type DocsNavItem =
	| {
			title: string;
			slug: string;
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
					{ title: 'Routing API', slug: 'api/routing-api' },
					{ title: 'Events Reference', slug: 'api/events-reference' },
				],
			},
			{
				title: 'Advanced',
				items: [
					{
						title: 'Sandbox Connector API',
						href: 'https://github.com/withastro/flue/blob/main/docs/sandbox-connector-spec.md',
					},
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
				items: [{ title: 'SDK API', slug: 'sdk/overview' }],
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

export function docsHref(slug: string) {
	return `${import.meta.env.BASE_URL}${slug}/`;
}

export function getDocsSection(slug: string) {
	return docsSections.find((section) => section.groups.some((group) => group.items.some((item) => 'slug' in item && item.slug === slug))) ?? docsSections[0];
}

