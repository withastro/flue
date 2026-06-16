export interface EcosystemItem {
	name: string;
	href: string;
	icon?: string;
	mark?: string;
	brand?: 'daytona' | 'e2b' | 'modal';
	background: string;
	iconClass?: string;
	keywords?: string;
	sortName?: string;
	homepageRank?: number;
}

function sortEcosystemItems(a: EcosystemItem, b: EcosystemItem): number {
	return (a.sortName ?? a.name).localeCompare(b.sortName ?? b.name);
}

function svgDataUri(svg: string): string {
	return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const braintrustIcon = svgDataUri(
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 27 27"><path fill="#fff" d="M9.552 0c1.507 0 2.729 1.237 2.729 2.762v2.76c0 1.525-1.222 2.762-2.729 2.762H8.188v1.074h1.364c1.507 0 2.729 1.236 2.729 2.761v2.762c0 1.525-1.222 2.761-2.729 2.761H8.188v1.074h1.364c1.507 0 2.729 1.237 2.729 2.762v2.76c0 1.525-1.222 2.762-2.729 2.762h-2.73c-1.507 0-2.728-1.237-2.728-2.762v-1.917H2.729C1.222 22.321 0 21.085 0 19.56v-2.762c0-1.525 1.223-2.761 2.729-2.761h1.365v-1.074H2.729C1.223 12.963 0 11.727 0 10.202V7.44c0-1.525 1.222-2.761 2.729-2.761h1.365V2.762C4.094 1.237 5.315 0 6.822 0zm9.4 0c1.507 0 2.729 1.237 2.729 2.762v1.917h1.365c1.507 0 2.728 1.237 2.728 2.761v2.762c0 1.525-1.221 2.761-2.728 2.761h-1.365v1.074h1.365c1.507 0 2.728 1.236 2.728 2.761v2.762c0 1.524-1.221 2.761-2.728 2.761h-1.365v1.917c0 1.525-1.222 2.762-2.729 2.762h-2.729c-1.507 0-2.728-1.237-2.728-2.762v-2.76c0-1.525 1.221-2.762 2.728-2.762h1.364v-1.074h-1.364c-1.507 0-2.728-1.236-2.728-2.761v-2.762c0-1.525 1.221-2.761 2.728-2.761h1.364V8.284h-1.364c-1.507 0-2.728-1.237-2.728-2.762v-2.76C13.495 1.237 14.716 0 16.223 0z"/></svg>',
);
const openTelemetryIcon = svgDataUri(
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><path fill="#f5a800" d="M67.648 69.797c-5.246 5.25-5.246 13.758 0 19.008 5.25 5.246 13.758 5.246 19.004 0 5.25-5.25 5.25-13.758 0-19.008-5.246-5.246-13.754-5.246-19.004 0Zm14.207 14.219a6.649 6.649 0 0 1-9.41 0 6.65 6.65 0 0 1 0-9.407 6.649 6.649 0 0 1 9.41 0c2.598 2.586 2.598 6.809 0 9.407ZM86.43 3.672l-8.235 8.234a4.17 4.17 0 0 0 0 5.875l32.149 32.149a4.17 4.17 0 0 0 5.875 0l8.234-8.235c1.61-1.61 1.61-4.261 0-5.87L92.29 3.671a4.159 4.159 0 0 0-5.86 0ZM28.738 108.895a3.763 3.763 0 0 0 0-5.31l-4.183-4.187a3.768 3.768 0 0 0-5.313 0l-8.644 8.649-.016.012-2.371-2.375c-1.313-1.313-3.45-1.313-4.75 0-1.313 1.312-1.313 3.449 0 4.75l14.246 14.242a3.353 3.353 0 0 0 4.746 0c1.3-1.313 1.313-3.45 0-4.746l-2.375-2.375.016-.012Zm43.559-81.582L54.004 45.605c-1.625 1.625-1.625 4.301 0 5.926L65.3 62.824c7.984-5.746 19.18-5.035 26.363 2.153l9.148-9.149c1.622-1.625 1.622-4.297 0-5.922L78.22 27.313a4.185 4.185 0 0 0-5.922 0ZM60.55 67.585l-6.672-6.672c-1.563-1.562-4.125-1.562-5.684 0l-23.53 23.54a4.036 4.036 0 0 0 0 5.687l13.331 13.332a4.036 4.036 0 0 0 5.688 0l15.132-15.157c-3.199-6.609-2.625-14.593 1.735-20.73Z"/></svg>',
);

export const channels: EcosystemItem[] = [
	{
		name: 'Discord',
		href: '/docs/ecosystem/channels/discord/',
		icon: 'https://svgl.app/library/discord.svg',
		background: '#5865f2',
		iconClass: 'monochrome-white',
		homepageRank: 19,
	},
	{
		name: 'Facebook',
		href: '/docs/ecosystem/channels/messenger/',
		mark: 'messenger',
		background: '#ffffff',
		keywords: 'messenger',
	},
	{
		name: 'GitHub',
		href: '/docs/ecosystem/channels/github/',
		icon: 'https://svgl.app/library/github_light.svg',
		background: '#181717',
		iconClass: 'monochrome-white',
		homepageRank: 14,
	},
	{
		name: 'Google Chat',
		href: '/docs/ecosystem/channels/google-chat/',
		icon: 'https://svgl.app/library/google-chat.svg',
		background: '#ffffff',
	},
	{
		name: 'Intercom',
		href: '/docs/ecosystem/channels/intercom/',
		mark: 'intercom',
		background: '#286efa',
	},
	{
		name: 'Linear',
		href: '/docs/ecosystem/channels/linear/',
		icon: 'https://svgl.app/library/linear.svg',
		background: '#181717',
		iconClass: 'monochrome-white',
	},
	{
		name: 'Microsoft Teams',
		href: '/docs/ecosystem/channels/teams/',
		icon: 'https://svgl.app/library/microsoft-teams.svg',
		background: '#ffffff',
	},
	{
		name: 'Notion',
		href: '/docs/ecosystem/channels/notion/',
		icon: 'https://svgl.app/library/notion.svg',
		background: '#ffffff',
		homepageRank: 16,
	},
	{
		name: 'Resend',
		href: '/docs/ecosystem/channels/resend/',
		icon: 'https://svgl.app/library/resend-icon-white.svg',
		background: '#181717',
	},
	{
		name: 'Salesforce',
		href: '/docs/ecosystem/channels/salesforce-marketing-cloud/',
		icon: 'https://svgl.app/library/salesforce.svg',
		background: '#ffffff',
		keywords: 'salesforce marketing cloud sfmc',
	},
	{
		name: 'Shopify',
		href: '/docs/ecosystem/channels/shopify/',
		icon: 'https://svgl.app/library/shopify.svg',
		background: '#ffffff',
		homepageRank: 3,
	},
	{
		name: 'Slack',
		href: '/docs/ecosystem/channels/slack/',
		icon: 'https://svgl.app/library/slack.svg',
		background: '#ffffff',
		homepageRank: 7,
	},
	{
		name: 'Stripe',
		href: '/docs/ecosystem/channels/stripe/',
		icon: 'https://svgl.app/library/stripe.svg',
		background: '#635bff',
		iconClass: 'monochrome-white',
		homepageRank: 8,
	},
	{
		name: 'Telegram',
		href: '/docs/ecosystem/channels/telegram/',
		icon: 'https://svgl.app/library/telegram.svg',
		background: '#ffffff',
		homepageRank: 10,
	},
	{
		name: 'Twilio',
		href: '/docs/ecosystem/channels/twilio/',
		icon: 'https://svgl.app/library/twilio.svg',
		background: '#f22f46',
		iconClass: 'monochrome-white',
	},
	{
		name: 'WhatsApp',
		href: '/docs/ecosystem/channels/whatsapp/',
		icon: 'https://svgl.app/library/whatsapp-icon.svg',
		background: '#25d366',
		iconClass: 'monochrome-white',
		homepageRank: 6,
	},
	{
		name: 'Zendesk',
		href: '/docs/ecosystem/channels/zendesk/',
		mark: 'zendesk',
		background: '#ffffff',
	},
].sort(sortEcosystemItems);

export const deploy: EcosystemItem[] = [
	{
		name: 'AWS',
		href: '/docs/ecosystem/deploy/aws/',
		icon: 'https://svgl.app/library/aws_dark.svg',
		background: '#181717',
		keywords: 'ecs express fargate ec2 cloud',
		homepageRank: 2,
	},
	{
		name: 'Cloudflare',
		href: '/docs/ecosystem/deploy/cloudflare/',
		icon: 'https://svgl.app/library/cloudflare.svg',
		background: '#ffffff',
		keywords: 'workers',
		homepageRank: 1,
	},
	{
		name: 'Docker',
		href: '/docs/ecosystem/deploy/docker/',
		icon: 'https://svgl.app/library/docker.svg',
		background: '#ffffff',
		keywords: 'container image',
		homepageRank: 12,
	},
	{
		name: 'Fly.io',
		href: '/docs/ecosystem/deploy/fly/',
		icon: 'https://svgl.app/library/fly.svg',
		background: '#ffffff',
		keywords: 'hosting machines container',
		homepageRank: 13,
	},
	{
		name: 'GitHub Actions',
		href: '/docs/ecosystem/deploy/github-actions/',
		icon: 'https://svgl.app/library/github_light.svg',
		background: '#181717',
		iconClass: 'monochrome-white',
		keywords: 'ci cd',
	},
	{
		name: 'GitLab CI/CD',
		href: '/docs/ecosystem/deploy/gitlab-ci/',
		icon: 'https://svgl.app/library/gitlab.svg',
		background: '#ffffff',
		keywords: 'ci cd',
		homepageRank: 15,
	},
	{
		name: 'Node.js',
		href: '/docs/ecosystem/deploy/node/',
		icon: 'https://svgl.app/library/nodejs.svg',
		background: '#ffffff',
		keywords: 'node hosting server',
		homepageRank: 5,
	},
	{
		name: 'Railway',
		href: '/docs/ecosystem/deploy/railway/',
		icon: 'https://svgl.app/library/railway.svg',
		background: '#181717',
		iconClass: 'invert',
		keywords: 'hosting node container',
		homepageRank: 11,
	},
	{
		name: 'Render',
		href: '/docs/ecosystem/deploy/render/',
		icon: 'https://svgl.app/library/render_black.svg',
		background: '#ffffff',
		iconClass: 'ecosystem-logo-large',
		keywords: 'hosting node',
		homepageRank: 18,
	},
	{
		name: 'SST',
		href: '/docs/ecosystem/deploy/sst/',
		icon: 'https://svgl.app/library/sst.svg',
		background: '#ffffff',
		keywords: 'iac infrastructure aws fargate',
	},
].sort(sortEcosystemItems);

export const sandboxes: EcosystemItem[] = [
	{ name: 'boxd', href: '/docs/ecosystem/sandboxes/boxd/', background: '#2563eb' },
	{
		name: 'Cloudflare Sandbox',
		href: '/docs/ecosystem/sandboxes/cloudflare/',
		icon: 'https://svgl.app/library/cloudflare.svg',
		background: '#ffffff',
	},
	{
		name: 'Cloudflare Shell',
		href: '/docs/ecosystem/sandboxes/cloudflare-shell/',
		icon: 'https://svgl.app/library/cloudflare.svg',
		background: '#ffffff',
		keywords: '@cloudflare/shell cloudflare shell',
	},
	{
		name: 'Daytona',
		href: '/docs/ecosystem/sandboxes/daytona/',
		brand: 'daytona',
		background: '#181717',
		homepageRank: 9,
	},
	{
		name: 'E2B',
		href: '/docs/ecosystem/sandboxes/e2b/',
		brand: 'e2b',
		background: '#ffffff',
		homepageRank: 17,
	},
	{ name: 'exe.dev', href: '/docs/ecosystem/sandboxes/exedev/', background: '#2563eb' },
	{ name: 'islo', href: '/docs/ecosystem/sandboxes/islo/', background: '#2563eb' },
	{ name: 'Mirage', href: '/docs/ecosystem/sandboxes/mirage/', background: '#2563eb' },
	{
		name: 'Modal',
		href: '/docs/ecosystem/sandboxes/modal/',
		brand: 'modal',
		background: '#ffffff',
	},
	{ name: 'smolvm', href: '/docs/ecosystem/sandboxes/smolvm/', background: '#2563eb' },
	{
		name: 'Vercel Sandbox',
		href: '/docs/ecosystem/sandboxes/vercel/',
		icon: 'https://svgl.app/library/vercel.svg',
		background: '#181717',
		iconClass: 'monochrome-white ecosystem-logo-small',
		homepageRank: 4,
	},
].sort(sortEcosystemItems);

export const databases: EcosystemItem[] = [
	{
		name: 'libSQL',
		href: '/docs/ecosystem/databases/libsql/',
		mark: 'sqlite',
		background: '#ffffff',
		keywords: 'libsql sqlite turso embedded sql database persistence',
	},
	{
		name: 'MongoDB',
		href: '/docs/ecosystem/databases/mongodb/',
		icon: 'https://svgl.app/library/mongodb-icon-light.svg',
		background: '#00ed64',
		iconClass: 'monochrome-white ecosystem-logo-mongodb',
		keywords: 'mongodb atlas document database persistence',
	},
	{
		name: 'MySQL',
		href: '/docs/ecosystem/databases/mysql/',
		icon: 'https://svgl.app/library/mysql-icon-light.svg',
		background: '#ffffff',
		keywords: 'mysql sql innodb database persistence',
	},
	{
		name: 'Postgres',
		href: '/docs/ecosystem/databases/postgres/',
		icon: 'https://svgl.app/library/postgresql.svg',
		background: '#ffffff',
		keywords: 'postgresql sql database persistence',
		homepageRank: 20,
	},
	{
		name: 'Redis',
		href: '/docs/ecosystem/databases/redis/',
		icon: 'https://svgl.app/library/redis.svg',
		background: '#ffffff',
		keywords: 'redis key value database persistence',
	},
	{
		name: 'Supabase',
		href: '/docs/ecosystem/databases/supabase/',
		icon: 'https://svgl.app/library/supabase.svg',
		background: '#ffffff',
		keywords: 'supabase postgres postgresql sql database persistence',
	},
	{
		name: 'Turso',
		href: '/docs/ecosystem/databases/turso/',
		mark: 'turso',
		background: '#1b252d',
		keywords: 'turso libsql sqlite hosted replicated sql database persistence',
	},
	{
		name: 'Valkey',
		href: '/docs/ecosystem/databases/valkey/',
		mark: 'valkey',
		background: '#123678',
		keywords: 'valkey redis protocol key value database persistence',
	},
].sort(sortEcosystemItems);

export const tooling: EcosystemItem[] = [
	{
		name: 'Braintrust',
		href: '/docs/ecosystem/tooling/braintrust/',
		icon: braintrustIcon,
		background: '#2c1fea',
		iconClass: 'ecosystem-logo-tooling',
		keywords: 'braintrust observability tracing evaluation evals monitoring',
	},
	{
		name: 'OpenTelemetry',
		href: '/docs/ecosystem/tooling/opentelemetry/',
		icon: openTelemetryIcon,
		background: '#ffffff',
		iconClass: 'ecosystem-logo-tooling',
		keywords:
			'opentelemetry otel observability telemetry tracing traces otlp monitoring vendor neutral',
	},
	{
		name: 'Sentry',
		href: '/docs/ecosystem/tooling/sentry/',
		icon: 'https://svgl.app/library/sentry.svg',
		background: '#ffffff',
		iconClass: 'ecosystem-logo-tooling',
		keywords: 'sentry observability monitoring errors tracing',
	},
].sort(sortEcosystemItems);

const catalog = [...channels, ...deploy, ...databases, ...tooling, ...sandboxes];
const homepageOrder = [
	'Cloudflare',
	'Slack',
	'GitHub',
	'Postgres',
	'Discord',
	'Docker',
	'Stripe',
	'AWS',
	'Shopify',
	'MongoDB',
	'Linear',
	'Sentry',
	'WhatsApp',
	'Node.js',
	'Supabase',
	'Notion',
	'Redis',
	'OpenTelemetry',
	'Vercel Sandbox',
	'Telegram',
	'GitLab CI/CD',
	'Google Chat',
	'Microsoft Teams',
	'MySQL',
	'Railway',
	'Daytona',
	'E2B',
	'Braintrust',
	'Render',
	'Twilio',
	'Salesforce',
	'SST',
	'Resend',
	'Fly.io',
];
const homepageOrderIndex = new Map(homepageOrder.map((name, index) => [name, index]));
const seenIcons = new Set<string>();

export const homepageEcosystemItems = catalog
	.filter((item) => item.icon || item.brand === 'daytona' || item.brand === 'e2b')
	.sort(
		(a, b) =>
			(homepageOrderIndex.get(a.name) ?? Number.MAX_SAFE_INTEGER) -
				(homepageOrderIndex.get(b.name) ?? Number.MAX_SAFE_INTEGER) || sortEcosystemItems(a, b),
	)
	.filter((item) => {
		const identity = item.icon ?? item.brand;
		if (!identity || seenIcons.has(identity)) return false;
		seenIcons.add(identity);
		return true;
	});
