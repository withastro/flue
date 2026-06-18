import {
	boxdIcon,
	braintrustIcon,
	daytonaIcon,
	e2bIcon,
	exeDevIcon,
	isloIcon,
	mirageIcon,
	modalIcon,
	openTelemetryIcon
} from './ecosystem-icons';

export interface EcosystemItem {
	name: string;
	href: string;
	icon?: string;
	mark?: string;
	background: string;
	iconClass?: string;
	keywords?: string;
	sortName?: string;
	homepageRank?: number;
}

function sortEcosystemItems(a: EcosystemItem, b: EcosystemItem): number {
	return (a.sortName ?? a.name).localeCompare(b.sortName ?? b.name);
}

function sortEcosystemItemsLogoFirst(a: EcosystemItem, b: EcosystemItem): number {
	const aHasLogo = Boolean(a.icon ?? a.mark);
	const bHasLogo = Boolean(b.icon ?? b.mark);
	if (aHasLogo !== bHasLogo) return aHasLogo ? -1 : 1;
	return sortEcosystemItems(a, b);
}

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

const sandboxItems: EcosystemItem[] = [
	{
		name: 'boxd',
		href: '/docs/ecosystem/sandboxes/boxd/',
		icon: boxdIcon,
		background: '#000000',
		iconClass: 'w-1/2! h-1/2!',
	},
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
		icon: daytonaIcon,
		background: '#181717',
		iconClass: 'w-1/2! h-1/2!',
		homepageRank: 9,
	},
	{
		name: 'E2B',
		href: '/docs/ecosystem/sandboxes/e2b/',
		icon: e2bIcon,
		background: '#ffffff',
		iconClass: 'w-3/4! h-3/4!',
		homepageRank: 17,
	},
	{
		name: 'exe.dev',
		href: '/docs/ecosystem/sandboxes/exedev/',
		icon: exeDevIcon,
		background: '#ffffff',
	},
	{
		name: 'islo',
		href: '/docs/ecosystem/sandboxes/islo/',
		icon: isloIcon,
		background: '#ffffff',
		iconClass: 'w-3/4! h-3/4! max-h-3/4!',
	},
	{
		name: 'Mirage',
		href: '/docs/ecosystem/sandboxes/mirage/',
		icon: mirageIcon,
		background: '#000000',
		iconClass: 'w-[62%]! h-auto! max-h-[62%]!',
	},
	{
		name: 'Modal',
		href: '/docs/ecosystem/sandboxes/modal/',
		icon: modalIcon,
		background: '#ffffff',
		iconClass: 'w-2/3! h-2/3!',
	},
	{
		name: 'Vercel Sandbox',
		href: '/docs/ecosystem/sandboxes/vercel/',
		icon: 'https://svgl.app/library/vercel.svg',
		background: '#181717',
		iconClass: 'monochrome-white ecosystem-logo-small',
		homepageRank: 4,
	},
];

export const sandboxes = sandboxItems.sort(sortEcosystemItemsLogoFirst);

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
	'Braintrust',
	'Linear',
	'Sentry',
	'WhatsApp',
	'Railway',
	'Supabase',
	'Notion',
	'Daytona',
	'Render',
	'Vercel Sandbox',
	'Telegram',
	'GitLab CI/CD',
	'Google Chat',
	'Microsoft Teams',
	'MySQL',
	'Node.js',
	'Redis',
	'E2B',
	'MongoDB',
	'OpenTelemetry',
	'Twilio',
	'Salesforce',
	'SST',
	'Resend',
	'Fly.io',
];
const homepageOrderIndex = new Map(homepageOrder.map((name, index) => [name, index]));
const seenIcons = new Set<string>();

export const homepageEcosystemItems = catalog
	.filter((item) => item.icon)
	.sort(
		(a, b) =>
			(homepageOrderIndex.get(a.name) ?? Number.MAX_SAFE_INTEGER) -
			(homepageOrderIndex.get(b.name) ?? Number.MAX_SAFE_INTEGER) || sortEcosystemItems(a, b),
	)
	.filter((item) => {
		const identity = item.icon;
		if (!identity || seenIcons.has(identity)) return false;
		seenIcons.add(identity);
		return true;
	});
